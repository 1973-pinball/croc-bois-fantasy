import { z } from 'zod';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';
import { seasonActionSchema, seasonReadinessSchema } from '@/lib/season-readiness';

export async function GET(request: Request) {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!z.string().uuid().safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  // The RPC authorizes the commissioner before reading any private readiness counts.
  const { data, error } = await auth.client.rpc('get_season_readiness', { p_season: seasonId });
  if (error) return rpcError(error);
  const parsed = seasonReadinessSchema.safeParse(data);
  return parsed.success ? json({ readiness: parsed.data }) : json({ error: 'READINESS_UNAVAILABLE', message: 'Season readiness could not be verified. Refresh before making changes.' }, 503);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = seasonActionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message || 'Check the season settings.' }, 400);
  const body = parsed.data;
  const { data, error } = body.action === 'open_keeper_selection'
    ? await auth.client.rpc('open_keeper_selection', { p_season: body.seasonId, p_note: body.note })
    : await auth.client.rpc('update_schedule', { p_season: body.seasonId, p_expected_revision: body.expectedRevision, p_keeper_deadline: body.keeperDeadline, p_draft_at: body.draftAt, p_season_time_zone: body.seasonTimeZone, p_note: body.note });
  return error ? rpcError(error) : json({ season: data });
}
