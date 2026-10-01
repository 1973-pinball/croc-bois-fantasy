import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const uuid = z.string().uuid();
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), seasonId: uuid, franchiseId: uuid, expectedRevision: z.number().int().min(0), assignments: z.array(z.object({ playerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), pickId: uuid }).strict()).max(30) }).strict(),
  z.object({ action: z.enum(['submit', 'approve', 'reject', 'lock']), submissionId: uuid, expectedRevision: z.number().int().positive(), note: z.string().max(2000).optional() }).strict(),
]);

export async function GET(request: Request) {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!uuid.safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  const { data, error } = await auth.client.from('keeper_submissions').select('*,keeper_assignments(*)').eq('season_id', seasonId).eq('is_current', true);
  return error ? rpcError(error) : json({ submissions: data });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = actionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, 400);
  const body = parsed.data;
  const result = body.action === 'save'
    ? await auth.client.rpc('save_keeper_submission', { p_season: body.seasonId, p_franchise: body.franchiseId, p_expected_revision: body.expectedRevision, p_assignments: body.assignments.map((a) => ({ player_id: a.playerId, pick_id: a.pickId })) })
    : await auth.client.rpc('transition_keeper_submission', { p_submission: body.submissionId, p_expected_revision: body.expectedRevision, p_action: body.action, p_note: body.note ?? null });
  return result.error ? rpcError(result.error) : json({ submission: result.data });
}
