import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const schema = z.object({ tradeId: z.string().uuid(), reason: z.string().trim().min(5).max(2000) }).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: 'Provide a withdrawal reason of 5 to 2,000 characters.' }, 400);
  const { data, error } = await auth.client.rpc('withdraw_trade', { p_trade: parsed.data.tradeId, p_reason: parsed.data.reason });
  return error ? rpcError(error) : json({ trade: data });
}
