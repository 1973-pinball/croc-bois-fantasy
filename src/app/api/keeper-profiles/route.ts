import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const schema = z.object({ seasonId: z.string().uuid(), playerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), baseRound: z.number().int().min(1).max(30).nullable(), tenureYears: z.number().int().min(1).max(100).nullable(), verification: z.enum(['confirmed', 'provisional', 'unresolved', 'ineligible']), note: z.string().trim().min(1).max(2000) }).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY' }, 400);
  const b = parsed.data;
  const { data, error } = await auth.client.rpc('review_keeper_profile', { p_season: b.seasonId, p_player: b.playerId, p_base_round: b.baseRound, p_tenure: b.tenureYears, p_verification: b.verification, p_note: b.note });
  return error ? rpcError(error) : json({ profile: data });
}
