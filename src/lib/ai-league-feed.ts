import type { AiGameDay, AiLeagueFeed, AiMatchup, AiPlayer, AiStats } from './ai-league-types';

/** Only fixed ESPN endpoints receive these credentials. Never publish the source payloads. */
export type EspnCookies = { espnS2: string; swid: string };
export type AiNbaGame = { id: string; date: string; startsAt: string; scoringPeriod: number; home: number; away: number };
export type AiPeriodBoundary = { id: number; start: number; end: number };
type Json = Record<string, unknown>;
const FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons';
const NBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const STAT_IDS: Record<keyof AiStats, string> = { pts: '0', reb: '6', ast: '3', stl: '2', blk: '1', tov: '11', three: '17', fgm: '13', fga: '14', ftm: '15', fta: '16' };
const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ESPN returned an unexpected data object.');
  return value as Json;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('ESPN returned an incomplete data collection.');
  return value;
};
const positive = (value: unknown): number => {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) throw new Error('ESPN returned an invalid identifier.');
  return result;
};
const seasonId = (season: number) => {
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error('Invalid NBA season.');
  return season;
};
export function aiEasternDate(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid NBA date.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
}
function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid NBA calendar date.');
  return date;
}
function averages(player: Json, season: number, source: number): AiStats | null {
  const entry = array(player.stats ?? []).map(object).find(stat => stat.seasonId === season && stat.statSourceId === source && stat.statSplitTypeId === 0);
  if (!entry || !entry.averageStats) return null;
  const values = object(entry.averageStats), result = zero();
  for (const [key, id] of Object.entries(STAT_IDS)) {
    const value = values[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    result[key as keyof AiStats] = value;
  }
  if (result.fgm > result.fga + 0.00001 || result.ftm > result.fta + 0.00001) throw new Error('ESPN shooting averages are inconsistent.');
  return result;
}
function poolRows(payload: unknown): Json[] {
  const rows = array(object(payload).players).map(object);
  if (!rows.length || rows.length >= 2000) throw new Error('ESPN player pool is missing or potentially truncated.');
  const seen = new Set<number>();
  return rows.map(row => {
    const player = object(row.player), id = positive(player.id);
    if (id !== row.id || seen.has(id)) throw new Error('ESPN player pool has duplicate or conflicting identities.');
    seen.add(id);
    return player;
  });
}

/** Replay deliberately ignores all target-season stats, present rankings and present injuries. */
export function extractAiPlayers(payload: unknown, season: number, replay = false, priorSeasonPayload?: unknown): AiPlayer[] {
  seasonId(season);
  const prior = new Map(priorSeasonPayload ? poolRows(priorSeasonPayload).map(player => [positive(player.id), player]) : []);
  return poolRows(payload).map(player => {
    const id = positive(player.id), name = player.fullName;
    if (typeof name !== 'string' || !name.trim()) throw new Error('ESPN player name is missing.');
    const slots = array(player.eligibleSlots).map(slot => {
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > 15) throw new Error('ESPN player eligibility is invalid.');
      return slot;
    });
    if (!slots.length || slots.length !== new Set(slots).size) throw new Error('ESPN player eligibility is incomplete.');
    const nbaTeamId = player.proTeamId;
    if (typeof nbaTeamId !== 'number' || !Number.isInteger(nbaTeamId) || nbaTeamId < 0 || nbaTeamId > 30) throw new Error('Unknown ESPN NBA team.');
    const ranks = player.draftRanksByRankType ? object(player.draftRanksByRankType) : {};
    const roto = ranks.ROTO ? object(ranks.ROTO) : {};
    const rank = !replay && typeof roto.rank === 'number' && Number.isSafeInteger(roto.rank) && roto.rank > 0 ? roto.rank : null;
    const baseline = replay ? prior.get(id) : player;
    const forecast = replay ? (baseline ? averages(baseline, season - 1, 0) : null) : (averages(player, season, 1) ?? averages(player, season - 1, 0));
    return { id, name: name.trim(), nbaTeamId, slots, rank, forecast: forecast ?? zero(), injury: !replay && typeof player.injuryStatus === 'string' ? player.injuryStatus : null };
  }).sort((a, b) => a.id - b.id);
}

/** Schedules repeat each game under both NBA teams; require those records to agree. */
export function extractAiNbaSchedule(payload: unknown): AiNbaGame[] {
  const teams = array(object(object(payload).settings).proTeams), games = new Map<string, AiNbaGame>();
  for (const raw of teams) {
    const team = object(raw);
    if (!team.proGamesByScoringPeriod) continue;
    for (const [period, rows] of Object.entries(object(team.proGamesByScoringPeriod))) for (const rawGame of array(rows)) {
      const game = object(rawGame), id = String(positive(game.id)), startsAt = new Date(Number(game.date)).toISOString();
      const scoringPeriod = positive(game.scoringPeriodId);
      if (scoringPeriod !== Number(period)) throw new Error('ESPN NBA schedule has conflicting scoring periods.');
      const value = { id, date: aiEasternDate(startsAt), startsAt, scoringPeriod, home: positive(game.homeProTeamId), away: positive(game.awayProTeamId) };
      const previous = games.get(id);
      if (value.home === value.away || (previous && JSON.stringify(previous) !== JSON.stringify(value))) throw new Error('ESPN NBA schedule has conflicting games.');
      games.set(id, value);
    }
  }
  if (!games.size) throw new Error('ESPN NBA schedule is unavailable.');
  return [...games.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
}

/** Uses observed scoring-day/date pairs to infer off-days without assuming a UTC game date. */
export function aiScoringDate(games: AiNbaGame[], period: number): string {
  positive(period);
  if (!games.length) throw new Error('NBA scoring calendar is missing.');
  const origins = new Set(games.map(game => Date.parse(`${game.date}T12:00:00Z`) - (game.scoringPeriod - 1) * 86_400_000));
  if (origins.size !== 1) throw new Error('NBA scoring calendar is not consecutive; review ESPN period definitions.');
  return new Date([...origins][0] + (period - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function extractAiMatchups(payload: unknown, games: AiNbaGame[], boundaries: AiPeriodBoundary[]): AiMatchup[] {
  const league = object(payload), settings = object(object(league.settings).scheduleSettings);
  if (league.id !== 139935 || object(object(league.settings).scoringSettings).scoringType !== 'H2H_CATEGORY') throw new Error('Unexpected fantasy league scoring settings.');
  const regularCount = positive(settings.matchupPeriodCount), mapping = object(settings.matchupPeriods);
  const ranges = new Map<number, { start: string; end: string }>();
  for (const [id, indexes] of Object.entries(mapping)) {
    const periods = array(indexes).map(index => boundaries.find(row => row.id === Number(index)));
    if (!periods.length || periods.some(period => !period)) throw new Error('ESPN matchup calendar has an unmapped period.');
    ranges.set(positive(id), { start: aiScoringDate(games, Math.min(...periods.map(period => period!.start))), end: aiScoringDate(games, Math.max(...periods.map(period => period!.end))) });
  }
  const matchups = array(league.schedule).map(object).filter(row => Number(row.matchupPeriodId) <= regularCount).map(row => {
    const period = positive(row.matchupPeriodId), range = ranges.get(period);
    if (!range) throw new Error('ESPN matchup date range is missing.');
    const home = String(positive(object(row.home).teamId)), away = String(positive(object(row.away).teamId));
    if (home === away) throw new Error('ESPN matchup repeats a franchise.');
    return { id: String(positive(row.id)), period, home, away, ...range, playoff: false };
  });
  // Participants are placeholders: the simulation determines its own semifinal/final seeds.
  for (const [period, range] of ranges) if (period > regularCount) matchups.push({ id: `playoff-${period}`, period, home: '1', away: '2', ...range, playoff: true });
  if (!matchups.length || new Set(matchups.map(row => row.id)).size !== matchups.length) throw new Error('ESPN matchup schedule is missing or duplicated.');
  return matchups.sort((a, b) => a.period - b.period || a.id.localeCompare(b.id));
}

export function extractAiBoxScore(payload: unknown, eventId: string, season: number): { complete: boolean; playerIds: number[]; stats: AiGameDay['stats'] } {
  const root = object(payload), header = object(root.header), competition = array(header.competitions).map(object).find(row => String(row.id) === eventId);
  if (!competition || object(header.season).year !== season || object(header.season).type !== 2) throw new Error('NBA box score belongs to another game or season.');
  const status = object(object(competition.status).type), complete = status.completed === true;
  const rows = root.boxscore && object(root.boxscore).players ? array(object(root.boxscore).players) : [];
  const unplayed = status.state === 'post' && ['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED'].includes(String(status.name));
  if (unplayed) {
    // A postponed original fixture is terminal for this date, not a completed
    // NBA game. The independently scheduled makeup fixture scores on its date.
    // Refuse to discard any existing contribution (for example a suspended game).
    for (const team of rows) for (const table of array(object(team).statistics ?? [])) for (const athlete of array(object(table).athletes ?? [])) {
      const values = array(object(athlete).stats ?? []);
      if (values.some(value => typeof value !== 'string' || !/^(?:[+-]?0(?:\.0+)?|0-0|0:00|--)?$/.test(value))) throw new Error('A postponed NBA game contains statistics; its scoring date needs review.');
    }
    return { complete: true, playerIds: [], stats: [] };
  }
  if (!rows.length && !complete) return { complete: false, playerIds: [], stats: [] };
  if (rows.length !== 2) throw new Error('A final NBA box score is incomplete.');
  const playerIds: number[] = [], stats: AiGameDay['stats'] = [];
  for (const rawTeam of rows) {
    const tables = array(object(rawTeam).statistics).map(object), table = tables.find(row => Array.isArray(row.labels) && row.labels.includes('PTS'));
    if (!table) throw new Error('NBA player statistics are missing.');
    const labels = array(table.labels), athletes = array(table.athletes);
    if (!athletes.length) throw new Error('NBA player statistics are missing.');
    for (const rawAthlete of athletes) {
      const row = object(rawAthlete), athlete = object(row.athlete);
      // ESPN occasionally emits an unidentified roster stub (Olbrich, CHI).
      // Some carry DNP=true; others incorrectly carry DNP=false with MIN="--"
      // and every statistic zero. Neither contributes any category statistics.
      const missingId = athlete.id === undefined || athlete.id === null || athlete.id === '';
      const emptyDnp = row.didNotPlay === true && Array.isArray(row.stats) && row.stats.length === 0;
      const minuteIndex = labels.indexOf('MIN');
      const zeroMinuteStub = Array.isArray(row.stats) && row.stats.length === labels.length && minuteIndex >= 0
        && ['--', '0', '0:00'].includes(String(row.stats[minuteIndex]))
        && row.stats.every((value, index) => index === minuteIndex || (typeof value === 'string' && /^[+-]?0(?:-0)?$/.test(value)));
      if (missingId && (emptyDnp || zeroMinuteStub)) continue;
      const playerId = positive(athlete.id);
      if (playerIds.includes(playerId)) throw new Error('NBA box score contains a duplicate player.');
      playerIds.push(playerId);
      if (row.didNotPlay === true) { stats.push({ playerId, stats: zero() }); continue; }
      const values = array(row.stats);
      const field = (label: string) => { const index = labels.indexOf(label); if (index < 0 || typeof values[index] !== 'string') throw new Error('NBA box score is missing a scoring category.'); return values[index] as string; };
      const count = (label: string) => { const text = field(label); if (!/^\d+$/.test(text)) throw new Error('NBA box score has an invalid count.'); return Number(text); };
      const shooting = (label: string) => { const text = field(label); if (!/^\d+-\d+$/.test(text)) throw new Error('NBA shooting statistics are missing.'); const [made, attempted] = text.split('-').map(Number); if (made > attempted) throw new Error('NBA shooting statistics are inconsistent.'); return [made, attempted]; };
      const [fgm, fga] = shooting('FG'), [ftm, fta] = shooting('FT'), [three] = shooting('3PT');
      stats.push({ playerId, stats: { pts: count('PTS'), reb: count('REB'), ast: count('AST'), stl: count('STL'), blk: count('BLK'), tov: count('TO'), three, fgm, fga, ftm, fta } });
    }
  }
  return { complete, playerIds, stats };
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('ESPN data is temporarily unavailable.'); }
  if (!response.ok) throw new Error(`ESPN data request returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text.length || text.length > 30_000_000) throw new Error('ESPN response size is unexpected.');
  try { return JSON.parse(text); } catch { throw new Error('ESPN returned an unreadable response.'); }
}
function headers(cookies?: EspnCookies): Record<string, string> {
  const espnS2 = cookies?.espnS2 ?? process.env.ESPN_S2, swid = cookies?.swid ?? process.env.ESPN_SWID ?? process.env.SWID;
  if (!espnS2 || !swid) throw new Error('The ESPN connection is unavailable.');
  if (/[\s;]/.test(espnS2 + swid)) throw new Error('The ESPN connection is invalid.');
  return { Cookie: `espn_s2=${espnS2}; SWID=${swid}` };
}
export async function fetchAiPlayerPool(season: number, cookies?: EspnCookies): Promise<unknown> {
  seasonId(season);
  const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: 2000, offset: 0, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'STANDARD' }, filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: [`00${season}`, `10${season}`, `00${season - 1}`] } } };
  return json(`${FANTASY}/${season}/segments/0/leagues/139935?view=kona_player_info`, { ...headers(cookies), 'x-fantasy-filter': JSON.stringify(filter) });
}
export async function fetchAiLeagueSettings(season: number, cookies?: EspnCookies): Promise<unknown> {
  return json(`${FANTASY}/${seasonId(season)}/segments/0/leagues/139935?view=mSettings&view=mMatchup`, headers(cookies));
}
export async function fetchAiNbaSchedule(season: number): Promise<AiNbaGame[]> {
  return extractAiNbaSchedule(await json(`${FANTASY}/${seasonId(season)}?view=proTeamSchedules_wl`));
}
async function mapLimited<T, U>(values: T[], fn: (value: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => { while (next < values.length) { const index = next++; result[index] = await fn(values[index]); } }));
  return result;
}
export async function fetchAiDailyStats(date: string, season: number, players: AiPlayer[], replay = false, expectedGames?: AiNbaGame[]): Promise<AiGameDay> {
  validDate(date); seasonId(season);
  const scoreboard = object(await json(`${NBA}/scoreboard?dates=${date.replaceAll('-', '')}&limit=100`));
  const events = array(scoreboard.events).map(object).filter(event => {
    if (object(event.season).year !== season || object(event.season).type !== 2) return false;
    const competition = object(array(event.competitions)[0]), type = object(competition.type);
    // ESPN's scoreboard also labels Cup finals and All-Star games "regular-season".
    // Its fantasy scoring calendar excludes both; exclude only the verified types.
    return !((String(type.id) === '39' && type.abbreviation === 'CC') || (String(type.id) === '4' && type.abbreviation === 'ALLSTAR'));
  });
  if (events.length >= 100) throw new Error('NBA scoreboard may be truncated.');
  const observed = new Set(events.map(event => String(positive(event.id))));
  if (observed.size !== events.length) throw new Error('NBA scoreboard contains duplicated games.');
  if (expectedGames) {
    const expected = new Set(expectedGames.filter(game => game.date === date).map(game => game.id));
    if (expected.size !== observed.size || [...expected].some(id => !observed.has(id))) throw new Error('NBA scoreboard does not reconcile with the season schedule. Preserve the previous results.');
  }
  const starts = events.map(event => {
    if (typeof event.date !== 'string' || aiEasternDate(event.date) !== date) throw new Error('NBA scoreboard returned a different date.');
    return new Date(event.date).toISOString();
  }).sort();
  const nbaTeams = new Set(events.flatMap(event => array(object(array(event.competitions)[0]).competitors).map(row => positive(object(object(row).team).id))));
  const boxes = await mapLimited(events, event => json(`${NBA}/summary?event=${positive(event.id)}`).then(payload => extractAiBoxScore(payload, String(event.id), season)));
  const stats = new Map<number, AiStats>();
  for (const box of boxes) for (const entry of box.stats) {
    const total = stats.get(entry.playerId) ?? zero();
    for (const key of Object.keys(total) as (keyof AiStats)[]) total[key] += entry.stats[key];
    stats.set(entry.playerId, total);
  }
  const playerIds = [...new Set([...(!replay ? players.filter(player => nbaTeams.has(player.nbaTeamId)).map(player => player.id) : []), ...boxes.flatMap(box => box.playerIds)])].sort((a, b) => a - b);
  return { date, startsAt: starts[0] ?? `${date}T23:59:59.000Z`, playerIds, stats: [...stats].map(([playerId, line]) => ({ playerId, stats: line })), complete: boxes.every(box => box.complete) };
}

/** Verified ESPN periodTypeId=2 calendar constants, read as data without executing client code.
 *  2027: https://cdn1.espn.net/kona/35f16ade75be-1.504/_next/static/commons/main-396c1392ce19efb16ea8.js
 *  2026: https://cdn1.espn.net/kona/35f16ade75be-1.504/_next/webpack/chunks/modules_api_lm_seasons_fba_2026_3be81645dbe39bf3c7b1b1f60069885b-12b5f9280f90886a9c98.js
 *  ESPN combines the All-Star interval in week 18 (2027) and week 17 (2026).
 *  Dates are independently grounded in the live NBA scoring-period/game schedule.
 */
const PERIOD_ENDS: Record<number, number[]> = {
  2027: [6, 13, 20, 27, 34, 41, 48, 55, 62, 69, 76, 83, 90, 97, 104, 111, 118, 132, 139, 146, 153, 160, 167, 174],
  2026: [6, 13, 20, 27, 34, 41, 48, 55, 62, 69, 76, 83, 90, 97, 104, 111, 125, 132, 139, 146, 153, 160, 167, 174],
};
export function aiSeasonPeriodBoundaries(season: number): AiPeriodBoundary[] {
  const ends = PERIOD_ENDS[season];
  if (!ends) throw new Error('This NBA season needs a verified ESPN matchup calendar.');
  return ends.map((end, index) => ({ id: index + 1, start: index ? ends[index - 1] + 1 : 1, end }));
}

type SeasonAssembly = { players: AiPlayer[]; matchups: AiMatchup[]; games: AiNbaGame[]; firstDate: string; lastDate: string; capturedAt: string };
const seasonCache = new Map<string, { at: number; value: Promise<SeasonAssembly> }>();
async function assembleSeason(season: number, replay: boolean, cookies?: EspnCookies): Promise<SeasonAssembly> {
  const [pool, prior, leaguePayload, games] = await Promise.all([
    fetchAiPlayerPool(season, cookies), replay ? fetchAiPlayerPool(season - 1, cookies) : Promise.resolve(undefined),
    fetchAiLeagueSettings(season, cookies), fetchAiNbaSchedule(season),
  ]);
  const league = object(leaguePayload), settings = object(league.settings);
  if (league.seasonId !== season || object(settings.scheduleSettings).periodTypeId !== 2) throw new Error('Unexpected ESPN season or matchup period type.');
  const players = extractAiPlayers(pool, season, replay, prior);
  if (players.filter(player => player.forecast.pts > 0).length < 104) throw new Error('Not enough complete player forecasts for eight AI rosters.');
  const matchups = extractAiMatchups(league, games, aiSeasonPeriodBoundaries(season));
  const firstDate = matchups.map(row => row.start).sort()[0], lastDate = matchups.map(row => row.end).sort().at(-1)!;
  if (lastDate !== aiScoringDate(games, positive(object(league.status).finalScoringPeriod))) throw new Error('ESPN final scoring day does not reconcile with the matchup calendar.');
  return { players, matchups, games, firstDate, lastDate, capturedAt: new Date().toISOString() };
}

/** At most three scoring dates per call; every source is read-only and public output is allowlisted. */
export async function fetchAiLeagueFeed(options: { season: number; dates: string[]; replay: boolean; cookies?: EspnCookies }): Promise<AiLeagueFeed> {
  const { season, replay, cookies } = options, dates = [...new Set(options.dates)].sort();
  if (season !== 2027 && season !== 2026) throw new Error('Only the 2026–27 season and 2025–26 replay are supported.');
  if (dates.length > 3) throw new Error('Refresh at most three NBA scoring dates at a time.');
  if ((season === 2026) !== replay) throw new Error('The 2025–26 season uses the historical baseline replay.');
  dates.forEach(validDate);
  const key = `${season}:${replay}:${aiEasternDate(new Date())}`, now = Date.now();
  let cached = seasonCache.get(key);
  if (!cached || now - cached.at >= 300_000) {
    cached = { at: now, value: assembleSeason(season, replay, cookies) };
    seasonCache.set(key, cached);
    // Do not retain rejected promises, raw league responses, credentials, or old-day entries.
    void cached.value.catch(() => { if (seasonCache.get(key) === cached) seasonCache.delete(key); });
    for (const entry of seasonCache.keys()) if (!entry.endsWith(aiEasternDate(new Date()))) seasonCache.delete(entry);
  }
  const { players, matchups, games, firstDate, lastDate, capturedAt: forecastCapturedAt } = structuredClone(await cached.value);
  // Sequential dates bound the total public box-score concurrency to four for each request.
  const days: AiGameDay[] = [];
  for (const date of dates) days.push(await fetchAiDailyStats(date, season, players, replay, games));
  const capturedAt = new Date().toISOString();
  return {
    season, capturedAt, players, matchups, firstDate, lastDate, currentDate: aiEasternDate(capturedAt), days,
    forecastAsOf: replay ? `${season - 1}-07-01T00:00:00.000Z` : forecastCapturedAt,
    limitations: [
      'Results use ESPN NBA regular-season box scores, including players outside the real fantasy rosters. Incomplete or mismatched scoring days are not finalized.',
      'NBA game dates use America/New_York; matchup boundaries come from the ESPN basketball calendar, including its extended All-Star period.',
      'ESPN statistics can be corrected after a game. Previously finalized dates require an explicit rebuild to incorporate later corrections.',
      ...(replay ? [
        'Historical replay is a reconstructed prior-stat baseline, not archived preseason AI intelligence: only 2024–25 actual per-game averages drive player values. No 2025–26 outcomes, present rankings or present injuries enter those values.',
        'The baseline date identifies when the prior NBA season had finished; the data was retrieved later. Historical player eligibility and the available player universe come from the ESPN season endpoint and may include later changes.',
        'Daily historical roster availability is reconstructed from box-score rosters, including DNP players. Historical injury reports, waiver eligibility and announcements at lineup lock are unavailable.',
        'Players without a complete prior-season average receive a zero baseline; rookies and other newcomers are therefore disadvantaged. This is an explicit limitation of the replay.',
      ] : [
        'Player values use current ESPN season projections, falling back to prior-season per-game averages. Players without complete forecasts receive a zero baseline.',
        'Live player eligibility, injuries, forecasts and NBA schedules reflect the latest successful capture. Decisions must be saved before games start to count as prospective.',
      ]),
    ],
  };
}
