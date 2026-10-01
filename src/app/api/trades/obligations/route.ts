import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const schema = z.object({ obligationId: z.string().uuid(), status: z.enum(['fulfilled', 'waived']), note: z.string().trim().min(1).max(2000) }).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY' }, 400);
  const b = parsed.data;
  const { data, error } = await auth.client.rpc('resolve_trade_obligation', { p_obligation: b.obligationId, p_status: b.status, p_note: b.note });
  return error ? rpcError(error) : json({ obligation: data });
}
