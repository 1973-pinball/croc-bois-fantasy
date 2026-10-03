import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { draftActionSchema, draftBoardSchema } from '@/lib/draft-board';
import { getSupabaseConfig } from '@/lib/supabase/config';
import { authenticatedClient, json, readJson, rpcError, sameOrigin, setupResponse } from '@/lib/supabase/http';

function boardResponse(data: unknown) {
  const parsed = draftBoardSchema.safeParse(data);
  return parsed.success ? json({ board: parsed.data }) : json({ error: 'DRAFT_BOARD_UNAVAILABLE', message: 'The draft board could not be verified. Refresh before making a change.' }, 503);
}

export async function GET(request: Request) {
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!z.string().uuid().safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  const config = getSupabaseConfig();
  if (!config) return setupResponse();
  // This public projection must never inherit a commissioner's access to private keepers.
  const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc('get_draft_board', { p_season: seasonId });
  return error ? rpcError(error) : boardResponse(data);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = draftActionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message || 'Check the draft change.' }, 400);
  const body = parsed.data;
  const { data, error } = await auth.client.rpc('update_draft_board', {
    p_season: body.seasonId, p_expected_revision: body.expectedRevision, p_action: body.action,
    p_order: body.action === 'set_order' ? body.franchiseIds : null,
    p_pick: body.action === 'set_order' ? null : body.pickId,
    p_player: body.action === 'record' || body.action === 'correct' ? body.playerId : null,
    p_note: body.note || null,
  });
  // The RPC returns its own committed candidate under the same league lock; no stale second read.
  return error ? rpcError(error) : boardResponse(data);
}
