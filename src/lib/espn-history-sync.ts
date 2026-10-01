import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import identities from '../../data/identities.json';
import { leagueData } from './league-data';
import { getSupabaseConfig } from './supabase/config';
import { readAllRows } from './supabase/pagination';
import { ESPN_HISTORY_LEAGUE, FAILURE_MESSAGES, espnConnectionStatus, fetchHistoryBatch, historyFromRows, historyRowComplete, historyYearRange, planHistorySync, protectVerifiedChampions, validatedEspnCookies, type HistoryRow, type HistorySyncState, type HistoryFailure } from './espn-history-sync-core';

function yearRange() { return historyYearRange(leagueData.season, new Date()); }
type SyncStatus = {
  configured: boolean; needsConnection: boolean; running: boolean; lastSuccess: string | null;
  failedYears: HistoryFailure[]; coveredYears: number[]; pendingYears: number[]; message?: string;
  completedThrough: number; currentSeasonId: number;
};
export class HistoryServiceError extends Error {
  constructor(public readonly code: 'HISTORY_UNAVAILABLE' | 'HISTORY_SETUP_REQUIRED' | 'HISTORY_BUSY', public readonly status: number, message: string) { super(message); }
}
function unavailable(): never { throw new HistoryServiceError('HISTORY_UNAVAILABLE', 503, 'Saved ESPN history could not be loaded or updated. The existing records have been retained.'); }

function clientWithDeadline(key: string, deadline: number) {
  const config = getSupabaseConfig();
  if (!config) throw new HistoryServiceError('HISTORY_SETUP_REQUIRED', 503, 'Connect the league database to enable ESPN history.');
  return createClient(config.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('History request deadline reached');
      return fetch(input, { ...init, signal: AbortSignal.timeout(Math.min(8_000, remaining)), cache: 'no-store', redirect: 'error' });
    } },
  });
}
function serviceClient(deadline: number) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new HistoryServiceError('HISTORY_SETUP_REQUIRED', 503, 'The server connection for automatic ESPN history is not configured yet.');
  return clientWithDeadline(key, deadline);
}
async function readRows(client: SupabaseClient) {
  return readAllRows<HistoryRow>((from, to) => client.from('espn_season_history').select('espn_season_id,playoff_history,statistics,fetched_at,last_hash', { count: 'exact' }).eq('league_id', identities.leagueId).order('espn_season_id').range(from, to));
}
async function readState(client: SupabaseClient): Promise<HistorySyncState | null> {
  const result = await client.from('espn_history_sync_state').select('lease_expires_at,last_started_at,last_finished_at,last_successful_at,status,failures,year_attempts').eq('league_id', identities.leagueId).maybeSingle();
  if (result.error) unavailable();
  return result.data as HistorySyncState | null;
}
function cookies() { return validatedEspnCookies(process.env.ESPN_S2, process.env.ESPN_SWID); }
function presentFailures(state: HistorySyncState | null): HistoryFailure[] {
  return (state?.failures || []).map(item => ({ seasonId: item.seasonId, code: item.code in FAILURE_MESSAGES ? item.code : 'ESPN_UNAVAILABLE', message: FAILURE_MESSAGES[item.code] || FAILURE_MESSAGES.ESPN_UNAVAILABLE }));
}
function publicStatus(rows: HistoryRow[], state: HistorySyncState | null): SyncStatus {
  const range = yearRange();
  const connection = espnConnectionStatus(process.env.ESPN_S2, process.env.ESPN_SWID, Boolean(state?.failures.some(item => item.code === 'ESPN_AUTH_REQUIRED')));
  const coveredYears = rows.filter(row => row.espn_season_id <= range.completedThrough && historyRowComplete(row)).map(row => row.espn_season_id).sort((a, b) => a - b);
  return { configured: true, ...connection, running: Boolean(state?.lease_expires_at && Date.parse(state.lease_expires_at) > Date.now()), lastSuccess: state?.last_successful_at || null,
    failedYears: presentFailures(state), coveredYears, pendingYears: range.expected.filter(year => !coveredYears.includes(year)), completedThrough: range.completedThrough, currentSeasonId: range.current,
  };
}

/** This client is anonymous even when a browser is signed in. */
export async function readPublicHistory() {
  const config = getSupabaseConfig();
  if (!config) throw new HistoryServiceError('HISTORY_SETUP_REQUIRED', 503, 'Connect the league database to load saved ESPN history.');
  try {
    const rows = await readRows(clientWithDeadline(config.key, Date.now() + 12_000));
    return { history: historyFromRows(rows), source: 'supabase' as const, status: { lastSuccessfulAt: rows.map(row => row.fetched_at).sort().at(-1) || null }, completedThrough: yearRange().completedThrough };
  } catch { return unavailable(); }
}

export async function readHistorySyncStatus(): Promise<SyncStatus> {
  if (!process.env.SUPABASE_SECRET_KEY || !getSupabaseConfig()) {
    const range = yearRange();
    return { configured: false, needsConnection: true, running: false, lastSuccess: null, failedYears: [], coveredYears: [], pendingYears: range.expected, completedThrough: range.completedThrough, currentSeasonId: range.current, message: 'Automatic ESPN history needs its private server connection configured.' };
  }
  try {
    const client = serviceClient(Date.now() + 12_000), [rows, state] = await Promise.all([readRows(client), readState(client)]);
    return publicStatus(rows, state);
  } catch { return unavailable(); }
}

export async function synchronizeHistory({ manual = false }: { manual?: boolean } = {}) {
  // Fetches stop early enough to persist progress within the route's 60-second host limit.
  const deadline = Date.now() + 48_000, client = serviceClient(deadline);
  let token: string | undefined;
  try {
    const [rows, state, franchises] = await Promise.all([
      readRows(client), readState(client),
      client.from('franchises').select('espn_team_id').eq('league_id', identities.leagueId).not('espn_team_id', 'is', null),
    ]);
    if (franchises.error || !franchises.data?.length) unavailable();
    const mapping: Record<string, string> = {};
    for (const franchise of franchises.data) {
      if (!Number.isSafeInteger(franchise.espn_team_id) || franchise.espn_team_id < 1 || mapping[String(franchise.espn_team_id)]) unavailable();
      mapping[String(franchise.espn_team_id)] = String(franchise.espn_team_id);
    }
    let connection;
    try { connection = cookies(); } catch { return { ...publicStatus(rows, state), needsConnection: true, message: 'The private ESPN connection needs to be configured again.', attemptedYears: [], savedYears: [] }; }
    if (!connection && state?.failures.some(item => item.code === 'ESPN_AUTH_REQUIRED')) return { ...publicStatus(rows, state), needsConnection: true, attemptedYears: [], savedYears: [] };
    const range = yearRange(), years = planHistorySync(rows, state, range.completedThrough, new Date(), manual && connection !== null);
    if (!years.length) return { ...publicStatus(rows, state), message: 'Saved history is current for this refresh interval. Failed years retry after one day.', attemptedYears: [], savedYears: [] };
    const lease = await client.rpc('claim_espn_history_sync', { p_league: identities.leagueId, p_lease_seconds: 300 });
    if (lease.error) unavailable();
    if (!lease.data) throw new HistoryServiceError('HISTORY_BUSY', 409, 'An ESPN history refresh is already running. Refresh its status shortly.');
    if (typeof lease.data.leaseToken !== 'string') unavailable();
    token = lease.data.leaseToken;
    const protectedRows = await readRows(client);
    const batch = protectVerifiedChampions(await fetchHistoryBatch({ years, completedThrough: range.completedThrough, mapping, cookies: connection, deadline: deadline - 8_000 }), protectedRows);
    const finished = await client.rpc('finish_espn_history_sync', { p_league: identities.leagueId, p_lease_token: token, p_seasons: batch.seasons, p_failures: batch.failures });
    if (finished.error) unavailable();
    token = undefined;
    // The saved data, not the fetched candidate, is the authority after merge protection.
    const [saved, latestState] = await Promise.all([readRows(client), readState(client)]);
    return { ...publicStatus(saved, latestState), attemptedYears: batch.attemptedYears, savedYears: batch.seasons.map(season => season.espnSeasonId) };
  } catch (error) {
    // A timed-out/failed commit leaves its bounded lease to expire. Retrying never removes old records.
    if (error instanceof HistoryServiceError) throw error;
    return unavailable();
  }
}

export { ESPN_HISTORY_LEAGUE };
