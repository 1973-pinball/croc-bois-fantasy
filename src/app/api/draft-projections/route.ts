import { z } from 'zod';
import identities from '../../../../data/identities.json';
import { importDraftProjectionText, importEspnDraftProjections, importYahooDraftProjections } from '@/lib/draft-projection-service';
import { authenticatedClient, json, sameOrigin } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('espn'), seasonId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('yahoo'), seasonId: z.string().uuid(), refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('import'), seasonId: z.string().uuid(), source: z.enum(['espn', 'yahoo', 'basketball-monster']), text: z.string().min(1).max(2_000_000), basis: z.enum(['per-game', 'totals']) }).strict(),
]);

async function readImportBody(request: Request): Promise<unknown> {
  // Bound the stream before allocation; large projection tables exceed the normal small action-body limit.
  const limit = 2_100_000;
  if (Number(request.headers.get('content-length')) > limit) throw new Error('Projection import must be under 2 MB.');
  if (!request.body) throw new Error('An import body is required.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Projection import must be under 2 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN', message: 'Use Commissioner Tools to import projections.' }, 403);
  try {
    const auth = await authenticatedClient();
    if ('response' in auth) return auth.response;
    const membership = await auth.client.from('league_memberships').select('role').eq('league_id', identities.leagueId).eq('user_id', auth.user.id).eq('active', true).maybeSingle();
    if (membership.error) return json({ error: 'ACCESS_UNAVAILABLE', message: 'Commissioner access could not be checked.' }, 503);
    if (membership.data?.role !== 'commissioner') return json({ error: 'FORBIDDEN', message: 'Only the commissioner can use the private draft tool.' }, 403);
    let body: z.infer<typeof bodySchema>;
    try {
      const parsed = bodySchema.safeParse(await readImportBody(request));
      if (!parsed.success) return json({ error: 'INVALID_BODY', message: 'Choose a projection source, season, and per-game or totals format.' }, 400);
      body = parsed.data;
    } catch { return json({ error: 'INVALID_BODY', message: 'Import a valid CSV/TSV table under 2 MB.' }, 400); }
    const season = await auth.client.from('seasons').select('draft_year').eq('id', body.seasonId).eq('league_id', identities.leagueId).maybeSingle();
    if (season.error) return json({ error: 'SEASON_UNAVAILABLE', message: 'The draft season could not be checked.' }, 503);
    if (!season.data || !Number.isInteger(season.data.draft_year)) return json({ error: 'INVALID_SEASON', message: 'Choose a draft season in this league.' }, 400);
    const espnSeasonId = season.data.draft_year + 1;
    try {
      const dataset = body.action === 'espn'
        ? await importEspnDraftProjections(espnSeasonId)
        : body.action === 'yahoo'
          ? await importYahooDraftProjections(espnSeasonId, { refresh: body.refresh })
          : importDraftProjectionText({ seasonId: espnSeasonId, source: body.source, text: body.text, basis: body.basis });
      // No shared database, board, queue, analytics feed, or public cache receives these projections.
      return json({ dataset });
    } catch (error) {
      return json({ error: 'PROJECTION_IMPORT_FAILED', message: error instanceof Error ? error.message : 'The projection import could not finish.' }, body.action === 'import' ? 400 : 503);
    }
  } catch { return json({ error: 'PROJECTION_IMPORT_UNAVAILABLE', message: 'The private projection import is temporarily unavailable.' }, 503); }
}
