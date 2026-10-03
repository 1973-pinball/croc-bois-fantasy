import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const teams = { fromFranchiseId: z.string().uuid(), toFranchiseId: z.string().uuid() };
const schema = z.object({
  seasonId: z.string().uuid(), category: z.enum(['player_only', 'advanced']), terms: z.string().max(10000).default(''),
  correctsTradeId: z.string().uuid().optional(),
  players: z.array(z.object({ ...teams, playerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).max(100).default([]),
  picks: z.array(z.object({ ...teams, pickId: z.string().uuid() }).strict()).max(100).default([]),
  obligations: z.array(z.object({ ...teams, kind: z.enum(['loan_return', 'conditional_pick', 'espn_action', 'other']), terms: z.string().min(1).max(10000), dueAt: z.string().datetime({ offset: true }).nullable().optional() }).strict()).max(100).default([]),
}).strict();

export async function GET(request: Request) {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!z.string().uuid().safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  const { data, error } = await auth.client.from('trades').select('id,category,status,terms,effective_at,created_at,review_deadline,application_mode,cancelled_at,cancellation_reason,corrects_trade_id,trade_participants(franchise_id),trade_player_transfers(player_id,from_franchise_id,to_franchise_id,espn_status),trade_pick_transfers(pick_id,from_franchise_id,to_franchise_id),trade_obligations(id,kind,terms,from_franchise_id,to_franchise_id,due_at,status,resolution_note)').eq('season_id',seasonId).order('created_at',{ascending:false});
  return error ? rpcError(error) : json({ trades:data });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY' }, 400);
  const b = parsed.data;
  const { data, error } = await auth.client.rpc(b.correctsTradeId ? 'create_trade_revision' : 'create_trade', {
    ...(b.correctsTradeId ? { p_previous: b.correctsTradeId } : {}),
    p_season: b.seasonId, p_category: b.category, p_terms: b.terms,
    p_players: b.players.map((p) => ({ player_id: p.playerId, from_franchise_id: p.fromFranchiseId, to_franchise_id: p.toFranchiseId })),
    p_picks: b.picks.map((p) => ({ pick_id: p.pickId, from_franchise_id: p.fromFranchiseId, to_franchise_id: p.toFranchiseId })),
    p_obligations: b.obligations.map((p) => ({ kind: p.kind, terms: p.terms, due_at: p.dueAt ?? null, from_franchise_id: p.fromFranchiseId, to_franchise_id: p.toFranchiseId })),
  });
  return error ? rpcError(error) : json({ tradeId: data }, 201);
}
