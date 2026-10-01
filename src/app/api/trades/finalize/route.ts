import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const schema = z.object({ tradeId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY' }, 400);
  const { data, error } = await auth.client.rpc('finalize_trade', { p_trade: parsed.data.tradeId });
  return error ? rpcError(error) : json({ trade: data });
}
