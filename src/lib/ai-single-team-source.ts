import { createHash } from 'node:crypto';
import { z } from 'zod';
import { aiEasternDate, extractAiBoxScore, fetchAiLeagueFeed, fetchAiNbaSchedule, type AiNbaGame, type EspnCookies } from './ai-league-feed';
import { validatedEspnCookies } from './espn-history-sync-core';
import { parseAiOwnerSnapshot } from './ai-owner-source';
import { extractPlayoffSeason } from './playoff-history';
import type { AiSingleTeamDay, AiSingleTeamInput } from './ai-single-team-types';
import type { AiStats } from './ai-league-types';

export type AiSingleTeamMetadata = Omit<AiSingleTeamInput, 'days'> & {
  dates: string[]; nbaGames: AiNbaGame[]; capturedAt: string; sourceHash: string;
};

const finite = z.number().finite().nonnegative(), positiveId = z.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), franchiseId = z.enum(['1', '2', '3', '4', '5', '6', '7', '8']);
const forecastSchema = z.object({ pts: finite, reb: finite, ast: finite, stl: finite, blk: finite, tov: finite, three: finite, fgm: finite, fga: finite, ftm: finite, fta: finite });
const metadataSchema = z.object({
  season: z.literal(2026), firstDate: z.literal('2025-10-21'), lastDate: z.literal('2026-03-29'), forecastAsOf: z.string(),
  players: z.array(z.object({ id: positiveId, name: z.string().min(1).max(100), nbaTeamId: z.number().int().nonnegative(), slots: z.array(z.number().int().min(0).max(15)), rank: z.null(), injury: z.null(), forecast: forecastSchema })).min(500),
  matchups: z.array(z.object({ id: z.string().regex(/^\d+$/), period: z.number().int().min(1).max(20), home: franchiseId, away: franchiseId, start: isoDate, end: isoDate, playoff: z.boolean() })).length(80),
  officialScores: z.array(z.object({ period: z.number().int().min(1).max(20), teamId: franchiseId, categories: z.record(z.string(), finite) })).length(160),
  officialAdjustments: z.array(z.object({ season: z.literal(2026), period: z.literal(18), teamId: z.literal('8'), stat: z.literal('blk'), reconstructed: z.literal(20), official: z.literal(19), reason: z.string().min(1).max(300) })).max(1),
  actualChampion: franchiseId.nullable(), limitations: z.array(z.string()),
  ownerDraft: z.array(z.object({ teamId: franchiseId, playerId: positiveId, name: z.string().min(1).max(100), overallPick: positiveId.max(104), keeper: z.boolean().nullable() })).length(104),
  expectedRegularRecords: z.array(z.object({ teamId: franchiseId, wins: z.number().int().nonnegative(), losses: z.number().int().nonnegative(), ties: z.number().int().nonnegative() })).length(8),
  draftOrder: z.array(franchiseId).length(8).optional(), dates: z.array(isoDate).length(160),
  nbaGames: z.array(z.object({ id: z.string().regex(/^\d+$/), date: isoDate, startsAt: z.string(), scoringPeriod: positiveId, home: positiveId, away: positiveId })),
  capturedAt: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Allowlisted metadata cache validation; the runner separately checks its stored content hash. */
export function validateAiSingleTeamMetadata(value: unknown): AiSingleTeamMetadata {
  const parsed = metadataSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Historical metadata cache is incomplete or malformed (${parsed.error.issues.slice(0, 3).map(issue => issue.path.join('.')).join(', ')}).`);
  const metadata = parsed.data, known = new Set(metadata.players.map(player => player.id));
  if (known.size !== metadata.players.length || !Number.isFinite(Date.parse(metadata.forecastAsOf)) || metadata.forecastAsOf.slice(0, 10) >= metadata.firstDate
    || !Number.isFinite(Date.parse(metadata.capturedAt)) || metadata.dates.some((date, index) => Date.parse(`${date}T12:00:00Z`) !== Date.parse(`${metadata.firstDate}T12:00:00Z`) + index * 86_400_000)) throw new Error('Historical metadata calendar or player identities are invalid.');
  if (new Set(metadata.matchups.map(row => row.id)).size !== 80 || new Set(metadata.officialScores.map(row => `${row.period}:${row.teamId}`)).size !== 160
    || metadata.matchups.some(row => row.home === row.away || row.playoff !== (row.period > 18) || !metadata.dates.includes(row.start) || !metadata.dates.includes(row.end) || row.start > row.end)
    || metadata.officialScores.some(row => Object.keys(row.categories).length !== 9 || CATEGORY_IDS.some(id => row.categories[String(id)] === undefined) || row.categories['19'] > 1 || row.categories['20'] > 1)) throw new Error('Historical metadata matchup evidence is invalid.');
  for (let period = 1; period <= 20; period++) {
    const games = metadata.matchups.filter(row => row.period === period);
    if (games.length !== 4 || new Set(games.flatMap(row => [row.home, row.away])).size !== 8 || new Set(games.map(row => `${row.start}:${row.end}`)).size !== 1) throw new Error('Historical metadata period coverage is incomplete.');
  }
  const boundaries = metadata.matchups.filter((row, index, rows) => rows.findIndex(other => other.period === row.period) === index);
  if (metadata.dates.some(date => boundaries.filter(row => row.start <= date && date <= row.end).length !== 1)) throw new Error('Historical metadata matchup dates overlap or leave gaps.');
  if (metadata.officialAdjustments.some(adjustment => metadata.officialScores.find(row => row.period === adjustment.period && row.teamId === adjustment.teamId)?.categories['1'] !== adjustment.official)) throw new Error('The audited frozen-owner adjustment contradicts its official weekly source.');
  if (new Set(metadata.ownerDraft.map(row => row.playerId)).size !== 104 || new Set(metadata.ownerDraft.map(row => row.overallPick)).size !== 104
    || metadata.ownerDraft.some(row => !known.has(row.playerId)) || new Set(metadata.expectedRegularRecords.map(row => row.teamId)).size !== 8
    || metadata.expectedRegularRecords.some(row => row.wins + row.losses + row.ties !== 162)
    || (metadata.draftOrder && new Set(metadata.draftOrder).size !== 8)
    || new Set(metadata.nbaGames.map(row => row.id)).size !== metadata.nbaGames.length
    || metadata.nbaGames.some(row => !Number.isFinite(Date.parse(row.startsAt)) || row.home === row.away || aiEasternDate(row.startsAt) !== row.date)) throw new Error('Historical metadata draft, standings or NBA schedule are inconsistent.');
  return metadata;
}
type Json = Record<string, unknown>;
type DayEvidence = { league: unknown; pool: unknown; scoreboard: unknown; boxes?: Record<string, unknown> };
class GameCoverageError extends Error {
  constructor(readonly gameIds: string[]) { super('Full-player scoring does not reconcile with the NBA final score.'); }
}
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935';
const STAT_IDS: Record<keyof AiStats, string> = { pts: '0', reb: '6', ast: '3', stl: '2', blk: '1', tov: '11', three: '17', fgm: '13', fga: '14', ftm: '15', fta: '16' };
const CATEGORY_IDS = [0, 1, 2, 3, 6, 11, 17, 19, 20];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Single-team source object is missing.');
  return value as Json;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Single-team source collection is missing.');
  return value;
};
const count = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Single-team source count is invalid.');
  return value;
};
const id = (value: unknown) => count(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, 1);
const franchise = (value: unknown) => { const result = id(value); if (result > 8) throw new Error('Unknown single-team franchise.'); return String(result); };
function add(a: AiStats, b: AiStats) { for (const key of Object.keys(STAT_IDS) as (keyof AiStats)[]) a[key] += b[key]; return a; }
function stats(value: unknown, provider = false): AiStats {
  const input = object(value), line = zero();
  for (const [key, statId] of Object.entries(STAT_IDS)) line[key as keyof AiStats] = count(input[provider ? statId : key]);
  if (line.fgm > line.fga || line.ftm > line.fta || line.three > line.fgm) throw new Error('Single-team shooting counts are inconsistent.');
  return line;
}
function sameStats(a: AiStats, b: AiStats) { return (Object.keys(STAT_IDS) as (keyof AiStats)[]).every(key => a[key] === b[key]); }
function connectionHeaders(cookies?: EspnCookies) {
  const connection = validatedEspnCookies(cookies?.espnS2 ?? process.env.ESPN_S2, cookies?.swid ?? process.env.ESPN_SWID ?? process.env.SWID);
  if (!connection) throw new Error('The ESPN single-team connection is unavailable.');
  return { Accept: 'application/json', Cookie: `espn_s2=${connection.s2}; SWID=${connection.swid}` };
}
async function read(url: string, headers: Record<string, string> = {}) {
  let response: Response;
  try { response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('Single-team ESPN evidence is temporarily unavailable.'); }
  if (!response.ok) throw new Error(`Single-team ESPN evidence returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text.length || text.length > 12_000_000) throw new Error('Single-team ESPN evidence size is unexpected.');
  try { return { payload: JSON.parse(text) as unknown, sha256: hash(text) }; }
  catch { throw new Error('Single-team ESPN evidence could not be read.'); }
}
function validateLeague(league: Json, scoringPeriod?: number) {
  if (league.id !== 139935 || league.seasonId !== 2026 || (scoringPeriod !== undefined && league.scoringPeriodId !== scoringPeriod)) throw new Error('Historical lineup response has the wrong league, season, or date.');
  const teams = array(league.teams).map(object);
  if (teams.length !== 8 || new Set(teams.map(team => franchise(team.id))).size !== 8) throw new Error('All eight actual franchises are required.');
  return teams;
}

/** One-time metadata fetch. Every returned field is public sports/simulation evidence. */
export async function fetchAiSingleTeamMetadata(cookies?: EspnCookies): Promise<AiSingleTeamMetadata> {
  const feed = await fetchAiLeagueFeed({ season: 2026, replay: true, dates: [], cookies });
  if (!feed.firstDate || !feed.lastDate || !feed.forecastAsOf) throw new Error('Historical simulation metadata is incomplete.');
  const url = `${BASE}?view=mTeam&view=mSettings&view=mMatchup&view=mMatchupScore&view=mStandings&view=mRoster`;
  const response = await read(url, connectionHeaders(cookies)), league = object(response.payload), teams = validateLeague(league);
  const nbaGames = await fetchAiNbaSchedule(2026), capturedAt = new Date().toISOString();
  const ranges = new Map(feed.matchups.map(matchup => [matchup.period, { start: matchup.start, end: matchup.end }]));
  const regularPeriods = count(object(object(league.settings).scheduleSettings).matchupPeriodCount, 1);
  const officialScores: AiSingleTeamInput['officialScores'] = [];
  const matchups = array(league.schedule).map(raw => {
    const matchup = object(raw), period = id(matchup.matchupPeriodId), range = ranges.get(period);
    if (!range) throw new Error('Official matchup has no verified date range.');
    const home = object(matchup.home), away = object(matchup.away);
    for (const side of [home, away]) {
      const values = object(object(side.cumulativeScore).scoreByStat), categories: Record<string, number> = {};
      for (const statId of CATEGORY_IDS) {
        const value = object(values[statId]).score;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || ((statId === 19 || statId === 20) && value > 1)) throw new Error('Official category total is missing.');
        categories[String(statId)] = value;
      }
      officialScores.push({ period, teamId: franchise(side.teamId), categories });
    }
    return { id: String(id(matchup.id)), period, home: franchise(home.teamId), away: franchise(away.teamId), ...range, playoff: period > regularPeriods };
  });
  if (new Set(officialScores.map(score => `${score.period}:${score.teamId}`)).size !== officialScores.length
    || new Set(matchups.map(matchup => matchup.id)).size !== matchups.length) throw new Error('Official matchup evidence is duplicated.');
  for (const period of ranges.keys()) if (officialScores.filter(score => score.period === period).length !== 8) throw new Error('Official period is missing a franchise.');
  const expectedRegularRecords = teams.map(team => {
    const overall = object(object(team.record).overall);
    const wins = count(overall.wins), losses = count(overall.losses), ties = count(overall.ties);
    if (wins + losses + ties !== regularPeriods * 9) throw new Error('Official season category record is incomplete.');
    return { teamId: franchise(team.id), wins, losses, ties };
  });
  const actual = parseAiOwnerSnapshot(league, { season: 2026, playerNames: new Map(feed.players.map(player => [player.id, player.name])), source: { url, sha256: response.sha256, capturedAt } });
  if (!actual.draft) throw new Error('The authoritative historical owner draft is unavailable.');
  let actualChampion: string | null = null;
  try { actualChampion = extractPlayoffSeason(league, Object.fromEntries(teams.map(team => [String(team.id), String(team.id)])), { leagueId: 139935, sourceSha256: response.sha256, sourceKind: 'espn-server-sync', capturedAt }).championFranchiseId ?? null; }
  catch { /* A missing championship stays explicit; category evidence can still be audited. */ }
  const dates: string[] = [];
  for (let stamp = Date.parse(`${feed.firstDate}T12:00:00Z`); stamp <= Date.parse(`${feed.lastDate}T12:00:00Z`); stamp += 86_400_000) dates.push(new Date(stamp).toISOString().slice(0, 10));
  if (dates.length !== count(object(league.status).finalScoringPeriod, 1)) throw new Error('The actual season calendar is incomplete.');
  // Independently audited against all eleven positive NBA player/day block
  // contributions for this owner/week. Both source totals are retained.
  const officialAdjustments = officialScores.find(row => row.period === 18 && row.teamId === '8')?.categories['1'] === 19 ? [{
    season: 2026, period: 18, teamId: '8', stat: 'blk', reconstructed: 20, official: 19,
    reason: 'Official weekly total differs from verified daily NBA player totals; no player/date correction identified.',
  }] : [];
  return validateAiSingleTeamMetadata({
    season: 2026, firstDate: feed.firstDate, lastDate: feed.lastDate, forecastAsOf: feed.forecastAsOf,
    players: feed.players, matchups, officialScores, officialAdjustments, expectedRegularRecords, actualChampion, ownerDraft: actual.draft,
    dates, nbaGames, capturedAt, sourceHash: hash(response.sha256 + JSON.stringify(feed.players) + JSON.stringify(nbaGames)),
    limitations: [...feed.limitations,
      'Actual owner roster membership, lineup slots and scoring come from ESPN historical scoring-period snapshots. Daily snapshot ownership is used; intraday transaction execution times and historical waiver queues are unavailable.',
      'The dated player-pool API exposes current/end-of-season ownership even for historical dates. Its ownership, waiver status, rankings and injury fields are deliberately ignored; only dated actual player statistics are used.',
      'Scheduled participants are reconstructed from dated NBA game-stat records, including explicit DNP records. Actual player production is revealed only after the simulated decisions for that date.',
      'Players outside the archived ESPN fantasy universe cannot be drafted or acquired. When NBA team points include such players, a separate complete NBA box score must account for them and independently match every fantasy-eligible player contribution.',
      'The seven other franchises retain their observed daily roster choices and statistics. If they later acquire an AI-held player, their recorded ownership takes priority; the conflict must be logged.',
      'The original owner draft follows the commissioner workbook, with uniquely resolved ESPN player identities. ESPN’s offline draft import is not used for its ordering or keeper flags.',
      ...officialAdjustments.map(() => 'One source discrepancy is preserved explicitly: team 8, period 18 has 20 blocks in independently verified daily NBA player totals and 19 in the official ESPN weekly result. Frozen-owner period scoring uses the official 19; daily player statistics, AI-controlled scoring and future forecasts retain the verified player totals.'),
    ],
  });
}

function regularEvents(scoreboard: unknown, date: string) {
  const events = array(object(scoreboard).events).map(object).filter(event => {
    if (object(event.season).year !== 2026 || object(event.season).type !== 2) return false;
    const type = object(object(array(event.competitions)[0]).type);
    return !((String(type.id) === '39' && type.abbreviation === 'CC') || (String(type.id) === '4' && type.abbreviation === 'ALLSTAR'));
  });
  if (events.some(event => typeof event.date !== 'string' || aiEasternDate(event.date) !== date) || new Set(events.map(event => id(event.id))).size !== events.length) throw new Error('NBA scoreboard date or game identity is inconsistent.');
  return events;
}

/** Pure source parser, also used to prove that every actual roster contribution is dated correctly. */
export function parseAiSingleTeamDay(evidence: DayEvidence, metadata: AiSingleTeamMetadata, date: string, snapshotId: string): AiSingleTeamDay {
  const scoringPeriodId = metadata.dates.indexOf(date) + 1;
  if (!scoringPeriodId) throw new Error('Requested date is outside the replay season.');
  const league = object(evidence.league), teams = validateLeague(league, scoringPeriodId), events = regularEvents(evidence.scoreboard, date);
  const expected = new Set(metadata.nbaGames.filter(game => game.date === date).map(game => game.id));
  if (expected.size !== events.length || events.some(event => !expected.has(String(event.id)))) throw new Error('Historical NBA scoreboard does not reconcile with the season calendar.');
  const playedGames = new Set<string>(), finalPoints = new Map<string, number>();
  for (const event of events) {
    const status = object(object(event.status).type), eventId = String(id(event.id));
    if (status.completed === true) {
      playedGames.add(eventId);
      finalPoints.set(eventId, array(object(array(event.competitions)[0]).competitors).reduce<number>((sum, raw) => sum + count(Number(object(raw).score)), 0));
    } else if (!(status.state === 'post' && ['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED'].includes(String(status.name)))) throw new Error('A historical NBA game is not complete.');
  }
  const knownIds = new Set(metadata.players.map(player => player.id)), poolRows = array(object(evidence.pool).players).map(object);
  if (poolRows.length !== knownIds.size || new Set(poolRows.map(row => id(row.id))).size !== knownIds.size || poolRows.some(row => !knownIds.has(id(row.id)))) throw new Error('Historical full-player statistics are missing rows or duplicated.');
  const statLines = new Map<number, AiStats>(), scheduled = new Set<number>(), pointsByGame = new Map<string, number>();
  const gameLines = new Map<string, Map<number, AiStats>>();
  for (const row of poolRows) {
    const playerId = id(row.id), player = object(row.player);
    if (player.id !== playerId) throw new Error('Historical player identity is inconsistent.');
    const seenGames = new Set<string>();
    for (const raw of array(player.stats)) {
      const entry = object(raw);
      if (entry.seasonId !== 2026 || entry.statSourceId !== 0 || entry.statSplitTypeId !== 5 || entry.scoringPeriodId !== scoringPeriodId) throw new Error('Historical player statistics include an incorrect date or future aggregate.');
      const eventId = String(id(entry.externalId));
      if (!expected.has(eventId) || seenGames.has(eventId)) throw new Error('Historical player game is unknown or duplicated.');
      seenGames.add(eventId);
      const values = object(entry.stats), line = Object.keys(values).length ? stats(values, true) : zero();
      if (!playedGames.has(eventId)) {
        if (!sameStats(line, zero())) throw new Error('A postponed game contains a scoring contribution.');
        continue;
      }
      scheduled.add(playerId);
      statLines.set(playerId, add(statLines.get(playerId) ?? zero(), line));
      pointsByGame.set(eventId, (pointsByGame.get(eventId) ?? 0) + line.pts);
      if (!gameLines.has(eventId)) gameLines.set(eventId, new Map());
      gameLines.get(eventId)!.set(playerId, line);
    }
  }
  const missingBoxes = [...finalPoints].filter(([eventId, total]) => (pointsByGame.get(eventId) ?? 0) !== total && evidence.boxes?.[eventId] === undefined).map(([eventId]) => eventId);
  if (missingBoxes.length) throw new GameCoverageError(missingBoxes);
  for (const [eventId, total] of finalPoints) if ((pointsByGame.get(eventId) ?? 0) !== total) {
    const rawBox = evidence.boxes![eventId], box = extractAiBoxScore(rawBox, eventId, 2026);
    // ESPN has two observable IDs for Olbrich: fantasy 5091709 and NBA 5107156.
    // This exact alias is accepted only with both independent full names verified.
    if (box.stats.some(row => row.playerId === 5107156) && knownIds.has(5091709) && !knownIds.has(5107156)) {
      const names = array(object(object(rawBox).boxscore).players).map(object).flatMap(team => array(team.statistics).map(object)).flatMap(table => array(table.athletes).map(object)).map(row => object(row.athlete)).filter(athlete => String(athlete.id) === '5107156');
      if (metadata.players.find(player => player.id === 5091709)?.name !== 'Lachlan Olbrich' || names.length !== 1 || names[0].displayName !== 'Lachlan Olbrich') throw new Error('The documented NBA/fantasy player alias could not be verified.');
      box.stats = box.stats.map(row => row.playerId === 5107156 ? { ...row, playerId: 5091709 } : row);
    }
    const boxLines = new Map(box.stats.map(row => [row.playerId, row.stats]));
    if (boxLines.size !== box.stats.length) throw new Error('Supplemental NBA identities are duplicated after alias reconciliation.');
    if (!box.complete || box.stats.reduce((sum, row) => sum + row.stats.pts, 0) !== total) throw new Error('Supplemental NBA box score does not reconcile with the final score.');
    const fantasy = gameLines.get(eventId) ?? new Map<number, AiStats>();
    for (const [playerId, line] of boxLines) if (knownIds.has(playerId) && !sameStats(line, fantasy.get(playerId) ?? zero())) throw new Error('A fantasy-eligible player contribution is missing or conflicts with the NBA box score.');
    for (const [playerId, line] of fantasy) if (!sameStats(line, boxLines.get(playerId) ?? zero())) throw new Error('Fantasy and NBA box-score contributions conflict.');
    const excludedPoints = box.stats.filter(row => !knownIds.has(row.playerId)).reduce((sum, row) => sum + row.stats.pts, 0);
    if ((pointsByGame.get(eventId) ?? 0) + excludedPoints !== total) throw new Error('NBA players outside the fantasy universe do not account for the missing points.');
  }
  const sides = array(league.schedule).map(object).flatMap(matchup => [matchup.home, matchup.away]).filter(Boolean).map(object).filter(side => side.rosterForCurrentScoringPeriod && array(object(side.rosterForCurrentScoringPeriod).entries).length > 0);
  if (sides.length !== 8 || new Set(sides.map(side => franchise(side.teamId))).size !== 8) throw new Error('Historical daily lineups do not cover all eight franchises.');
  const owned = new Set<number>();
  const owners = sides.map(side => {
    const teamId = franchise(side.teamId), entries = array(object(side.rosterForCurrentScoringPeriod).entries).map(object);
    const lineup = entries.map(entry => {
      const playerId = id(entry.playerId), slot = count(entry.lineupSlotId);
      if (!knownIds.has(playerId) || owned.has(playerId) || slot > 13) throw new Error('Historical daily ownership or lineup slot is invalid.');
      owned.add(playerId);
      // Cross-check the independently returned roster player's actual day stats.
      const player = object(object(entry.playerPoolEntry).player), lines = array(player.stats).map(object);
      if (player.id !== playerId) throw new Error('Historical roster player identity is inconsistent.');
      const rosterLine = zero();
      for (const raw of lines) {
        if (raw.seasonId !== 2026 || raw.statSourceId !== 0 || raw.statSplitTypeId !== 5 || raw.scoringPeriodId !== scoringPeriodId) throw new Error('Historical roster stats belong to another day.');
        if (Object.keys(object(raw.stats)).length) add(rosterLine, stats(raw.stats, true));
      }
      if (!sameStats(rosterLine, statLines.get(playerId) ?? zero())) throw new Error('Historical roster and full-pool player statistics conflict.');
      return { slot, playerId };
    });
    const team = teams.find(team => String(team.id) === teamId)!;
    const rosterEntries = array(object(team.roster).entries).map(object).map(entry => `${id(entry.playerId)}:${count(entry.lineupSlotId)}`).sort();
    if (JSON.stringify(rosterEntries) !== JSON.stringify(lineup.map(entry => `${entry.playerId}:${entry.slot}`).sort())) throw new Error('Historical team and scoring-day rosters disagree.');
    const total = zero();
    for (const entry of lineup) if (entry.slot <= 11) add(total, statLines.get(entry.playerId) ?? zero());
    return { teamId, roster: lineup.map(entry => entry.playerId), lineup, stats: total, complete: true };
  });
  const starts = events.filter(event => playedGames.has(String(event.id))).map(event => new Date(String(event.date)).toISOString()).sort();
  return validateAiSingleTeamDay({ season: 2026, scoringPeriodId, date, startsAt: starts[0] ?? `${date}T23:59:59.000Z`, complete: true, snapshotId,
    availablePlayerIds: [...knownIds].filter(playerId => !owned.has(playerId)).sort((a, b) => a - b), scheduledPlayerIds: [...scheduled].sort((a, b) => a - b),
    stats: [...knownIds].map(playerId => ({ playerId, stats: statLines.get(playerId) ?? zero() })), owners,
  }, metadata, date);
}

/** Validates cache identity and recomputes all eight owner totals before accepting a saved day. */
export function validateAiSingleTeamDay(value: unknown, metadata: AiSingleTeamMetadata, expectedDate: string): AiSingleTeamDay {
  const day = object(value), scoringPeriodId = metadata.dates.indexOf(expectedDate) + 1;
  if (!scoringPeriodId || day.season !== 2026 || day.scoringPeriodId !== scoringPeriodId || day.date !== expectedDate || day.complete !== true
    || typeof day.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(day.snapshotId) || typeof day.startsAt !== 'string' || !Number.isFinite(Date.parse(day.startsAt))) throw new Error('Cached historical day identity or coverage is invalid.');
  const known = new Set(metadata.players.map(player => player.id));
  const ids = (value: unknown) => { const result = array(value).map(id); if (new Set(result).size !== result.length || result.some(playerId => !known.has(playerId))) throw new Error('Cached player identities are invalid.'); return result; };
  const scheduledPlayerIds = ids(day.scheduledPlayerIds), availablePlayerIds = ids(day.availablePlayerIds);
  const lines = array(day.stats).map(raw => { const row = object(raw), playerId = id(row.playerId); if (!known.has(playerId)) throw new Error('Cached statistics have an unknown player.'); return { playerId, stats: stats(row.stats) }; });
  const lineMap = new Map(lines.map(row => [row.playerId, row.stats]));
  if (lineMap.size !== known.size || lines.length !== known.size || scheduledPlayerIds.some(playerId => !lineMap.has(playerId))
    || lines.some(row => !scheduledPlayerIds.includes(row.playerId) && !sameStats(row.stats, zero()))) throw new Error('Cached player statistics are missing, duplicated, or have an unscheduled contribution.');
  const owned = new Set<number>();
  const owners = array(day.owners).map(raw => {
    const owner = object(raw), teamId = franchise(owner.teamId), roster = ids(owner.roster);
    if (owner.complete !== true || roster.length < 1 || roster.some(playerId => owned.has(playerId))) throw new Error('Cached owner roster coverage is invalid.');
    roster.forEach(playerId => owned.add(playerId));
    const lineup = array(owner.lineup).map(raw => { const entry = object(raw), slot = count(entry.slot), playerId = id(entry.playerId); if (slot > 13 || !roster.includes(playerId)) throw new Error('Cached owner lineup is invalid.'); return { slot, playerId }; });
    if (lineup.length !== roster.length || new Set(lineup.map(entry => entry.playerId)).size !== roster.length) throw new Error('Cached owner lineup is incomplete.');
    const total = zero(); for (const entry of lineup) if (entry.slot <= 11) add(total, lineMap.get(entry.playerId) ?? zero());
    const declared = stats(owner.stats);
    if (!sameStats(total, declared)) throw new Error('Cached owner scoring does not match its actual lineup.');
    return { teamId, roster, lineup, stats: declared, complete: true };
  });
  if (owners.length !== 8 || new Set(owners.map(owner => owner.teamId)).size !== 8 || availablePlayerIds.length + owned.size !== known.size || availablePlayerIds.some(playerId => owned.has(playerId))) throw new Error('Cached ownership and free-agent universe are incomplete.');
  return { season: 2026, scoringPeriodId, date: expectedDate, startsAt: day.startsAt, snapshotId: day.snapshotId, complete: true, scheduledPlayerIds, availablePlayerIds, stats: lines, owners };
}

/** Sequential read-only requests, including any required supplemental boxes; four day calls mean at most four requests. */
export async function fetchAiSingleTeamDay(metadata: AiSingleTeamMetadata, date: string, cookies?: EspnCookies): Promise<AiSingleTeamDay> {
  const scoringPeriodId = metadata.dates.indexOf(date) + 1;
  if (metadata.season !== 2026 || !scoringPeriodId) throw new Error('Unsupported historical scoring day.');
  const headers = connectionHeaders(cookies);
  const league = await read(`${BASE}?view=mBoxscore&view=mMatchupScore&view=mRoster&view=mSettings&scoringPeriodId=${scoringPeriodId}`, headers);
  const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: 2000, offset: 0,
    sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'STANDARD' }, filterStatsForScoringPeriodIds: { value: [scoringPeriodId] } } };
  const pool = await read(`${BASE}?view=kona_player_info&scoringPeriodId=${scoringPeriodId}`, { ...headers, 'x-fantasy-filter': JSON.stringify(filter) });
  const scoreboard = await read(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll('-', '')}&limit=100`, { Accept: 'application/json' });
  const evidence: DayEvidence = { league: league.payload, pool: pool.payload, scoreboard: scoreboard.payload };
  let sourceHashes = league.sha256 + pool.sha256 + scoreboard.sha256;
  try { return parseAiSingleTeamDay(evidence, metadata, date, hash(sourceHashes)); }
  catch (error) {
    if (!(error instanceof GameCoverageError)) throw error;
    evidence.boxes = {};
    for (const eventId of error.gameIds) {
      const box = await read(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`, { Accept: 'application/json' });
      evidence.boxes[eventId] = box.payload; sourceHashes += box.sha256;
    }
    return parseAiSingleTeamDay(evidence, metadata, date, hash(sourceHashes));
  }
}
