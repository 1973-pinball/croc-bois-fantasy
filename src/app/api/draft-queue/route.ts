import { z } from 'zod';
import { draftQueueActionSchema, draftQueueSchema } from '@/lib/draft-board';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

function queueResponse(data: unknown) {
  const parsed = draftQueueSchema.safeParse(data);
  return parsed.success ? json({ queue: parsed.data }) : json({ error: 'DRAFT_QUEUE_UNAVAILABLE', message: 'Your draft queue could not be verified. Reload it before making a change.' }, 503);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = z.object({ seasonId: z.string().uuid(), franchiseId: z.string().uuid() }).safeParse({ seasonId: params.get('seasonId'), franchiseId: params.get('franchiseId') });
  if (!parsed.success) return json({ error: 'INVALID_QUEUE' }, 400);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const { data, error } = await auth.client.rpc('get_draft_queue', { p_season: parsed.data.seasonId, p_franchise: parsed.data.franchiseId });
  return error ? rpcError(error) : queueResponse(data);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = draftQueueActionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message || 'Check your draft queue.' }, 400);
  const body = parsed.data;
  const { data, error } = await auth.client.rpc('save_draft_queue', {
    p_season: body.seasonId, p_franchise: body.franchiseId,
    p_expected_revision: body.expectedRevision, p_player_ids: body.playerIds,
  });
  return error ? rpcError(error) : queueResponse(data);
}
