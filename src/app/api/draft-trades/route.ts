import { draftBoardSchema } from '@/lib/draft-board';
import { liveDraftTradeSchema } from '@/lib/draft-trade';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  let parsed;
  try { parsed = liveDraftTradeSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message || 'Check the draft trade.' }, 400);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const body = parsed.data;
  const { data, error } = await auth.client.rpc('execute_live_draft_trade', {
    p_season: body.seasonId, p_expected_revision: body.expectedRevision,
    p_players: body.players, p_picks: body.picks, p_note: body.note,
  });
  if (error) return rpcError(error);
  const board = draftBoardSchema.safeParse(data);
  return board.success ? json({ board: board.data }) : json({ error: 'DRAFT_BOARD_UNAVAILABLE', message: 'The trade response could not be verified. Refresh the draft board before making another change.' }, 503);
}
