import { z } from 'zod';
import { draftLotteryActionSchema, draftLotterySchema } from '@/lib/draft-lottery';
import { createClient } from '@/lib/supabase/server';
import { authenticatedClient, json, readJson, rpcError, sameOrigin, setupResponse } from '@/lib/supabase/http';

function lotteryResponse(data: unknown) {
  const parsed = draftLotterySchema.safeParse(data);
  return parsed.success ? json({ lottery: parsed.data }) : json({ error: 'LOTTERY_UNAVAILABLE', message: 'The lottery inputs could not be verified. Refresh before continuing.' }, 503);
}

export async function GET(request: Request) {
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!z.string().uuid().safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  const client = await createClient();
  if (!client) return setupResponse();
  // Database authorization exposes verified inputs publicly, and the result only to commissioners.
  const { data, error } = await client.rpc('get_draft_lottery', { p_season: seasonId });
  return error ? rpcError(error) : lotteryResponse(data);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = draftLotteryActionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: 'Choose the season to generate its official lottery.' }, 400);
  const { data, error } = await auth.client.rpc('run_draft_lottery', { p_season: parsed.data.seasonId });
  return error ? rpcError(error) : lotteryResponse(data);
}
