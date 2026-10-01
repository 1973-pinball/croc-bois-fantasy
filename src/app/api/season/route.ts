import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';

const schema = z.object({ action: z.literal('open_keeper_selection'), seasonId: z.string().uuid(), note: z.string().trim().min(1).max(2000) }).strict();

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = schema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY' }, 400);
  const { data, error } = await auth.client.rpc('open_keeper_selection', { p_season: parsed.data.seasonId, p_note: parsed.data.note });
  return error ? rpcError(error) : json({ season: data });
}
