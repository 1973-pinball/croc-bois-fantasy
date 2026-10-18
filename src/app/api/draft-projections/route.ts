import { z } from 'zod';
import identities from '../../../../data/identities.json';
import { importDraftProjectionText, importEspnDraftProjections, importYahooDraftProjections } from '@/lib/draft-projection-service';
import { draftProjectionRankSnapshotSchema } from '@/lib/draft-projection-ranks';
import { authenticatedClient, json, sameOrigin } from '@/lib/supabase/http';
import { readDraftToolAccess } from '@/lib/draft-tool-access-server';

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
    const access = await readDraftToolAccess(auth.client, auth.user.id);
    if (access.unavailable) return json({ error: 'ACCESS_UNAVAILABLE', message: 'Draft Tool access could not be checked.' }, 503);
    if (!access.commissioner && !access.restricted) return json({ error: 'FORBIDDEN', message: 'Your account does not have Draft Tool access.' }, 403);
    let body: z.infer<typeof bodySchema>;
    try {
      const parsed = bodySchema.safeParse(await readImportBody(request));
      if (!parsed.success) return json({ error: 'INVALID_BODY', message: 'Choose a projection source, season, and per-game or totals format.' }, 400);
      body = parsed.data;
    } catch { return json({ error: 'INVALID_BODY', message: 'Import a valid CSV/TSV table under 2 MB.' }, 400); }
    if (!access.commissioner && body.action === 'import') return json({ error: 'FORBIDDEN', message: 'Only the commissioner can import projection files.' }, 403);
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
      if (access.commissioner && dataset.source === 'basketball-monster') {
        const ranks = dataset.players.flatMap(player => player.providerRank === undefined ? [] : [{ id: player.id, providerRank: player.providerRank }]);
        if (ranks.length) {
          const snapshot = draftProjectionRankSnapshotSchema.parse({ source: dataset.source, seasonId: dataset.seasonId, importedAt: dataset.importedAt, ranks });
          try {
            const saved = await auth.client.rpc('save_draft_provider_ranks', { p_season: body.seasonId, p_snapshot: snapshot });
            const checked = draftProjectionRankSnapshotSchema.safeParse(saved.data);
            if (!saved.error && checked.success && checked.data.source === snapshot.source && checked.data.seasonId === snapshot.seasonId) return json({ dataset, rankSnapshot: checked.data });
          } catch { /* A failed private save must not discard a successfully parsed import. */ }
          return json({ dataset, rankSaveError: 'Projections imported, but BBM ranks could not be saved to your private account. Retry the import to save them for future visits.' });
        }
      }
      // Projection statistics remain browser-session data; only supplied BBM ranks are saved privately per account.
      return json({ dataset });
    } catch (error) {
      return json({ error: 'PROJECTION_IMPORT_FAILED', message: error instanceof Error ? error.message : 'The projection import could not finish.' }, body.action === 'import' ? 400 : 503);
    }
  } catch { return json({ error: 'PROJECTION_IMPORT_UNAVAILABLE', message: 'The private projection import is temporarily unavailable.' }, 503); }
}
