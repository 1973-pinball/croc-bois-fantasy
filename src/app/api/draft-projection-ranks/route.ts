import { z } from 'zod';
import identities from '../../../../data/identities.json';
import { draftProjectionRankSnapshotSchema } from '@/lib/draft-projection-ranks';
import { authenticatedClient, json, rpcError } from '@/lib/supabase/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const seasonId = new URL(request.url).searchParams.get('seasonId');
  if (!z.string().uuid().safeParse(seasonId).success) return json({ error: 'INVALID_SEASON' }, 400);
  const season = await auth.client.from('seasons').select('draft_year').eq('id', seasonId).eq('league_id', identities.leagueId).maybeSingle();
  if (season.error) return json({ error: 'SEASON_UNAVAILABLE' }, 503);
  if (!season.data) return json({ error: 'INVALID_SEASON' }, 400);
  // The RPC derives the account from the session and rechecks commissioner access.
  const result = await auth.client.rpc('get_draft_provider_ranks', { p_season: seasonId, p_source: 'basketball-monster' });
  if (result.error) return rpcError(result.error);
  if (result.data === null) return json({ snapshot: null });
  const snapshot = draftProjectionRankSnapshotSchema.safeParse(result.data);
  if (!snapshot.success || snapshot.data.source !== 'basketball-monster' || snapshot.data.seasonId !== season.data.draft_year + 1) {
    return json({ error: 'RANKS_UNAVAILABLE', message: 'Saved player ranks could not be verified.' }, 503);
  }
  return json({ snapshot: snapshot.data });
}
