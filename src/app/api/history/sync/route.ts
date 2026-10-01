import identities from '../../../../../data/identities.json';
import { HistoryServiceError, readHistorySyncStatus, synchronizeHistory } from '@/lib/espn-history-sync';
import { authenticatedClient, json, sameOrigin } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function commissioner() {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const membership = await auth.client.from('league_memberships').select('role').eq('league_id', identities.leagueId).eq('user_id', auth.user.id).eq('active', true).maybeSingle();
  if (membership.error) return json({ error: 'HISTORY_UNAVAILABLE', message: 'Commissioner access could not be checked.' }, 503);
  return membership.data?.role === 'commissioner' ? null : json({ error: 'FORBIDDEN', message: 'Only the commissioner can manage ESPN history refreshes.' }, 403);
}
function failure(error: unknown) { return error instanceof HistoryServiceError ? json({ error: error.code, message: error.message }, error.status) : json({ error: 'HISTORY_UNAVAILABLE', message: 'ESPN history could not be updated. Saved results have been retained.' }, 503); }

export async function GET() {
  try { const denied = await commissioner(); return denied || json(await readHistorySyncStatus()); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN', message: 'Use the league app to refresh ESPN history.' }, 403);
  try {
    const denied = await commissioner();
    if (denied) return denied;
    // No caller-supplied URL, season boundary, credentials, or league can enter the fetch path.
    return json(await synchronizeHistory({ manual: true }));
  } catch (error) { return failure(error); }
}
