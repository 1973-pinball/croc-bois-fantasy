import { draftLotteryShareIdSchema, draftLotteryShareRequestSchema, draftLotteryShareSchema } from '@/lib/draft-lottery-share';
import { createClient } from '@/lib/supabase/server';
import { authenticatedClient, json, readJson, rpcError, sameOrigin, setupResponse } from '@/lib/supabase/http';

function replayResponse(data: unknown) {
  const parsed = draftLotteryShareSchema.safeParse(data);
  return parsed.success ? json({ replay: parsed.data }) : json({ error: 'REPLAY_UNAVAILABLE', message: 'The shared replay could not be verified.' }, 503);
}

export async function GET(request: Request) {
  const parsed = draftLotteryShareIdSchema.safeParse(new URL(request.url).searchParams.get('shareId'));
  if (!parsed.success) return json({ error: 'INVALID_SHARE', message: 'This replay link is invalid.' }, 400);
  const client = await createClient();
  if (!client) return setupResponse();
  const { data, error } = await client.rpc('get_shared_draft_lottery', { p_share: parsed.data });
  return error ? rpcError(error) : replayResponse(data);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = draftLotteryShareRequestSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: 'Choose the saved lottery to share.' }, 400);
  const { data, error } = await auth.client.rpc('share_draft_lottery', { p_season: parsed.data.seasonId });
  return error ? rpcError(error) : replayResponse(data);
}
