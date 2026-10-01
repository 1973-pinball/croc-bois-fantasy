import { createHash, timingSafeEqual } from 'node:crypto';
import { extractPlayoffSeason, extractSeasonStatistics, validatePlayoffSeason, type FranchiseMap, type PlayoffHistory, type PlayoffSeason, type StatisticsOnlySeason } from './playoff-history';

export const ESPN_HISTORY_LEAGUE = 139935;
export const FIRST_HISTORY_YEAR = 2018;
const MAX_RESPONSE_BYTES = 4_000_000;
const RETRY_MS = 24 * 60 * 60 * 1000;
export type HistoryFailureCode = 'ESPN_AUTH_REQUIRED' | 'ESPN_UNAVAILABLE' | 'ESPN_NOT_FOUND' | 'INVALID_SOURCE' | 'BRACKET_UNVERIFIED';
export interface HistoryFailure { seasonId: number; code: HistoryFailureCode; message: string }
export interface HistoryRow { espn_season_id: number; playoff_history: PlayoffSeason | null; statistics: StatisticsOnlySeason | null; fetched_at: string; last_hash: string }
export interface HistorySyncState {
  lease_expires_at: string | null; last_started_at: string | null; last_finished_at: string | null; last_successful_at: string | null;
  status: string; failures: HistoryFailure[]; year_attempts: Record<string, { attemptedAt: string; outcome: string; code?: string }>;
}
export interface HistoryWrite { espnSeasonId: number; playoffHistory?: PlayoffSeason; statistics?: StatisticsOnlySeason; fetchedAt: string; sourceHash: string }
export interface EspnCookies { s2: string; swid: string }
export const FAILURE_MESSAGES: Record<HistoryFailureCode, string> = {
  ESPN_AUTH_REQUIRED: 'ESPN requires a valid private league connection. Saved history has been retained.',
  ESPN_UNAVAILABLE: 'ESPN could not provide this season. Saved history has been retained.',
  ESPN_NOT_FOUND: 'This season is not available from the ESPN history endpoints.',
  INVALID_SOURCE: 'This season could not be matched safely to the league and franchise records.',
  BRACKET_UNVERIFIED: 'Observed category wins were saved; the championship bracket still needs verification.',
};
function failure(seasonId: number, code: HistoryFailureCode): HistoryFailure { return { seasonId, code, message: FAILURE_MESSAGES[code] }; }
function validYear(value: number) { return Number.isSafeInteger(value) && value >= FIRST_HISTORY_YEAR && value <= 2100; }

/** July is a conservative completed-season boundary; the active ESPN season remains separate. */
export function historyYearRange(configuredLeagueYear: number, now: Date) {
  if (!validYear(configuredLeagueYear) || !Number.isFinite(now.getTime())) throw new Error('Invalid history boundary');
  const completedThrough = Math.max(configuredLeagueYear, now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0));
  const current = Math.max(completedThrough, now.getUTCFullYear() + (now.getUTCMonth() >= 8 ? 1 : 0));
  return { completedThrough, current, expected: Array.from({ length: completedThrough - FIRST_HISTORY_YEAR + 1 }, (_, i) => FIRST_HISTORY_YEAR + i) };
}

export function historyRowComplete(row: HistoryRow | undefined): boolean {
  if (!row?.playoff_history?.championFranchiseId) return false;
  const participants = row.statistics?.participants || row.playoff_history.participants;
  return participants.length >= 4 && participants.every(team => team.regularSeasonWins !== undefined);
}

/** Two backfill slots and one refresh slot prevent old missing years from starving recent results. */
export function planHistorySync(rows: readonly HistoryRow[], state: HistorySyncState | null, completedThrough: number, now: Date, retryAuthFailures = false): number[] {
  const { expected, current } = historyYearRange(completedThrough, now), time = now.getTime();
  const rowMap = new Map(rows.map(row => [row.espn_season_id, row]));
  const attempted = (year: number) => Date.parse(state?.year_attempts?.[String(year)]?.attemptedAt || '') || 0;
  const retryAuth = (year: number) => retryAuthFailures && Boolean(state?.failures.some(item => item.seasonId === year && item.code === 'ESPN_AUTH_REQUIRED'));
  const ready = (year: number) => retryAuth(year) || time - attempted(year) >= RETRY_MS;
  const priority = (year: number) => year === 2025 ? 0 : year === 2026 ? 1 : 2;
  // An observed wins-only year is still incomplete; rotate it behind never-tried years.
  const missing = expected.filter(year => !historyRowComplete(rowMap.get(year)) && ready(year)).sort((a, b) => Number(retryAuth(b)) - Number(retryAuth(a)) || attempted(a) - attempted(b) || priority(a) - priority(b) || a - b);
  const result = missing.slice(0, 2);
  const refresh = [...new Set([completedThrough, current])].filter(year => !result.includes(year) && ready(year)).sort((a, b) => attempted(a) - attempted(b) || a - b);
  if (refresh.length) result.push(refresh[0]);
  for (const year of missing) if (result.length < 3 && !result.includes(year)) result.push(year);
  return result;
}

export function validatedEspnCookies(s2?: string, swid?: string): EspnCookies | null {
  if (!s2 && !swid) return null;
  if (!s2 || !swid || s2.length > 16_384 || swid.length > 256 || /[;\s\u0000-\u001f\u007f]/.test(s2 + swid)) throw new Error('Invalid private ESPN connection');
  return { s2, swid };
}

export function espnConnectionStatus(s2: string | undefined, swid: string | undefined, hadAuthFailure: boolean) {
  let ready = false;
  try { ready = validatedEspnCookies(s2, swid) !== null; } catch { /* Only a status is exposed. */ }
  return { needsConnection: !ready, ...(hadAuthFailure ? { message: ready ? 'A previous ESPN connection attempt failed. You can retry with the current connection.' : 'ESPN needs a working private league connection. Existing results remain available.' } : !ready ? { message: 'Connect the private ESPN league to enable automatic history refreshes.' } : {}) };
}

export function cronAuthorized(header: string | null, configuredSecret: string | undefined): boolean {
  if (!configuredSecret || configuredSecret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)), expected = Buffer.from(configuredSecret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function seasonUrl(year: number, legacy: boolean) {
  if (!validYear(year)) throw new Error('Invalid ESPN season');
  const url = new URL(legacy ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/leagueHistory/${ESPN_HISTORY_LEAGUE}` : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${year}/segments/0/leagues/${ESPN_HISTORY_LEAGUE}`);
  if (legacy) url.searchParams.set('seasonId', String(year));
  for (const view of ['mTeam', 'mSettings', 'mMatchup', 'mStandings']) url.searchParams.append('view', view);
  return url.href;
}

async function readBoundedBody(response: Response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('ESPN response too large');
  if (!response.body) throw new Error('Empty ESPN response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('ESPN response too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function fetchHistorySeason(options: { seasonId: number; completedThrough: number; mapping: FranchiseMap; cookies: EspnCookies | null; deadline: number; fetcher?: typeof fetch; now?: () => number }): Promise<{ season?: HistoryWrite; failure?: HistoryFailure }> {
  const { seasonId, completedThrough, mapping, cookies, deadline } = options, now = options.now || Date.now, fetcher = options.fetcher || fetch;
  for (const legacy of [false, true]) {
    if (deadline - now() < 500) return { failure: failure(seasonId, 'ESPN_UNAVAILABLE') };
    const url = seasonUrl(seasonId, legacy), headers: Record<string, string> = { Accept: 'application/json' };
    if (cookies) headers.Cookie = `espn_s2=${cookies.s2}; SWID=${cookies.swid}`;
    let response: Response, text: string;
    try {
      response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - now()))) });
      if (response.status === 401 || response.status === 403) return { failure: failure(seasonId, 'ESPN_AUTH_REQUIRED') };
      if (response.status === 404) { if (!legacy) continue; return { failure: failure(seasonId, 'ESPN_NOT_FOUND') }; }
      if (!response.ok || response.status >= 300) return { failure: failure(seasonId, 'ESPN_UNAVAILABLE') };
      text = await readBoundedBody(response);
    } catch { return { failure: failure(seasonId, 'ESPN_UNAVAILABLE') }; }
    try {
      const parsed: unknown = JSON.parse(text);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      // History arrays may carry other years, but never two conflicting versions of this year.
      const matches = candidates.filter(value => value && typeof value === 'object' && (value as Record<string, unknown>).seasonId === seasonId);
      if (matches.length !== 1) return { failure: failure(seasonId, 'INVALID_SOURCE') };
      const payload = matches[0] as Record<string, unknown>, fetchedAt = new Date(now()).toISOString(), sourceHash = createHash('sha256').update(text).digest('hex');
      const provenance = { leagueId: ESPN_HISTORY_LEAGUE, sourceSha256: sourceHash, sourceKind: 'espn-server-sync' as const, sourceUrl: url, capturedAt: fetchedAt };
      const statistics = extractSeasonStatistics(payload, mapping, provenance);
      const season: HistoryWrite = { espnSeasonId: seasonId, statistics, fetchedAt, sourceHash };
      // The active, unfinished season may provide wins but cannot enter completed-season awards.
      if (seasonId > completedThrough) return { season };
      try { season.playoffHistory = extractPlayoffSeason(payload, mapping, provenance); }
      catch { return { season, failure: failure(seasonId, 'BRACKET_UNVERIFIED') }; }
      return { season };
    } catch { return { failure: failure(seasonId, 'INVALID_SOURCE') }; }
  }
  return { failure: failure(seasonId, 'ESPN_UNAVAILABLE') };
}

export async function fetchHistoryBatch(options: { years: number[]; completedThrough: number; mapping: FranchiseMap; cookies: EspnCookies | null; deadline: number; fetcher?: typeof fetch; now?: () => number }) {
  if (options.years.length > 3 || new Set(options.years).size !== options.years.length || options.years.some(year => !validYear(year))) throw new Error('Invalid bounded history batch');
  const seasons: HistoryWrite[] = [], failures: HistoryFailure[] = [], attemptedYears: number[] = [];
  for (const seasonId of options.years) {
    if (options.deadline - (options.now || Date.now)() < 500) break;
    attemptedYears.push(seasonId);
    const result = await fetchHistorySeason({ ...options, seasonId });
    if (result.season) seasons.push(result.season);
    if (result.failure) failures.push(result.failure);
    if (result.failure?.code === 'ESPN_AUTH_REQUIRED') break;
  }
  return { seasons, failures, attemptedYears };
}

/** One changed champion needs review without rolling back unrelated successful backfill years. */
export function protectVerifiedChampions(batch: Awaited<ReturnType<typeof fetchHistoryBatch>>, stored: readonly HistoryRow[]) {
  const conflicts = new Set(batch.seasons.filter(candidate => {
    const previous = stored.find(row => row.espn_season_id === candidate.espnSeasonId)?.playoff_history?.championFranchiseId;
    const incoming = candidate.playoffHistory?.championFranchiseId;
    return previous !== undefined && incoming !== undefined && previous !== incoming;
  }).map(candidate => candidate.espnSeasonId));
  return { ...batch, seasons: batch.seasons.filter(candidate => !conflicts.has(candidate.espnSeasonId)),
    failures: [...batch.failures.filter(item => !conflicts.has(item.seasonId)), ...[...conflicts].map(year => failure(year, 'INVALID_SOURCE'))] };
}

/** Database writes contain only these reviewed extraction types, never ESPN member objects. */
export function historyFromRows(rows: readonly HistoryRow[]): PlayoffHistory {
  if (new Set(rows.map(row => row.espn_season_id)).size !== rows.length) throw new Error('Duplicate saved season');
  const seasons: PlayoffSeason[] = [], statsOnlySeasons: StatisticsOnlySeason[] = [];
  for (const row of rows) {
    if (!validYear(row.espn_season_id)) throw new Error('Invalid saved season');
    if (row.playoff_history) {
      validatePlayoffSeason(row.playoff_history);
      if (row.playoff_history.espnSeasonId !== row.espn_season_id || row.playoff_history.source.leagueId !== ESPN_HISTORY_LEAGUE) throw new Error('Saved season identity mismatch');
      const value = row.playoff_history;
      seasons.push({ draftYear: value.draftYear, espnSeasonId: value.espnSeasonId, priorSeasonStartYear: value.priorSeasonStartYear, playoffTeamCount: value.playoffTeamCount,
        firstChampionshipMatchupPeriod: value.firstChampionshipMatchupPeriod,
        participants: value.participants.map(team => ({ espnTeamId: team.espnTeamId, franchiseId: team.franchiseId, qualified: team.qualified, ...(team.regularSeasonWins === undefined ? {} : { regularSeasonWins: team.regularSeasonWins }) })),
        qualifiedFranchiseIds: [...value.qualifiedFranchiseIds], ...(value.championFranchiseId ? { championFranchiseId: value.championFranchiseId } : {}),
        source: { ...publicProvenance(value.source), method: value.source.method, matchups: value.source.matchups.map(game => ({ id: game.id, homeEspnTeamId: game.homeEspnTeamId, awayEspnTeamId: game.awayEspnTeamId, ...(game.winnerEspnTeamId === undefined ? {} : { winnerEspnTeamId: game.winnerEspnTeamId }) })),
          ...(value.source.championship ? { championship: { id: value.source.championship.id, matchupPeriod: value.source.championship.matchupPeriod, homeEspnTeamId: value.source.championship.homeEspnTeamId, awayEspnTeamId: value.source.championship.awayEspnTeamId, winnerEspnTeamId: value.source.championship.winnerEspnTeamId } } : {}) },
        ...(value.additionalSourceEvidence ? { additionalSourceEvidence: value.additionalSourceEvidence.map(publicProvenance) } : {}),
      });
    }
    if (row.statistics) {
      const stats = row.statistics;
      if (stats.espnSeasonId !== row.espn_season_id || stats.draftYear !== row.espn_season_id || stats.priorSeasonStartYear !== row.espn_season_id - 1 || stats.source.leagueId !== ESPN_HISTORY_LEAGUE || stats.qualificationStatus !== 'unverified' || stats.participants.length < 2 || new Set(stats.participants.map(team => team.franchiseId)).size !== stats.participants.length || stats.participants.some(team => !/^[1-9]\d*$/.test(team.franchiseId) || !Number.isSafeInteger(team.espnTeamId) || team.espnTeamId < 1 || (team.regularSeasonWins !== undefined && (!Number.isSafeInteger(team.regularSeasonWins) || team.regularSeasonWins < 0)))) throw new Error('Invalid saved statistics');
      if (row.playoff_history && JSON.stringify(stats.participants.map(team => team.franchiseId).sort()) !== JSON.stringify(row.playoff_history.participants.map(team => team.franchiseId).sort())) throw new Error('Saved season participant records disagree');
      statsOnlySeasons.push({ draftYear: stats.draftYear, espnSeasonId: stats.espnSeasonId, priorSeasonStartYear: stats.priorSeasonStartYear, qualificationStatus: 'unverified', source: publicProvenance(stats.source),
        participants: stats.participants.map(team => ({ espnTeamId: team.espnTeamId, franchiseId: team.franchiseId, ...(team.regularSeasonWins === undefined ? {} : { regularSeasonWins: team.regularSeasonWins }) })) });
    } else if (!row.playoff_history) throw new Error('Empty saved season');
  }
  return { version: 1, leagueId: ESPN_HISTORY_LEAGUE, seasons: seasons.sort((a, b) => a.draftYear - b.draftYear), ...(statsOnlySeasons.length ? { statsOnlySeasons: statsOnlySeasons.sort((a, b) => a.draftYear - b.draftYear) } : {}) };
}

function publicProvenance(source: StatisticsOnlySeason['source']): StatisticsOnlySeason['source'] {
  return { kind: source.kind, leagueId: source.leagueId, sha256: source.sha256, ...(source.url ? { url: source.url } : {}), ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}), paths: [...source.paths] };
}
