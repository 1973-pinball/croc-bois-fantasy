import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAiSingleTeamDay, validateAiSingleTeamDay, validateAiSingleTeamMetadata, type AiSingleTeamMetadata } from '../../src/lib/ai-single-team-source';
import type { AiStats } from '../../src/lib/ai-league-types';

const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const date = '2025-10-21', snapshotId = 'a'.repeat(64);
function fixture() {
  const values = { 0: 2, 1: 0, 2: 0, 3: 1, 6: 1, 11: 0, 13: 1, 14: 1, 15: 0, 16: 0, 17: 0 };
  const record = { seasonId: 2026, statSourceId: 0, statSplitTypeId: 5, scoringPeriodId: 1, externalId: '999', stats: values };
  const pool = { players: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, onTeamId: 7, status: 'ONTEAM', player: { id: index + 1, stats: index < 10 ? [structuredClone(record)] : [] } })) };
  const entry = (playerId: number, lineupSlotId: number) => ({ playerId, lineupSlotId, playerPoolEntry: structuredClone(pool.players[playerId - 1]) });
  const teams = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, owners: ['PRIVATE-OWNER'], roster: { entries: [entry(index + 1, 0), ...(index === 0 ? [entry(9, 12), entry(10, 13)] : [])] } }));
  const side = (index: number) => ({ teamId: index + 1, rosterForCurrentScoringPeriod: structuredClone(teams[index].roster) });
  const league = { id: 139935, seasonId: 2026, scoringPeriodId: 1, members: [{ id: 'PRIVATE-MEMBER' }], teams,
    schedule: Array.from({ length: 4 }, (_, index) => ({ home: side(index * 2), away: side(index * 2 + 1) })) };
  const scoreboard = { events: [{ id: '999', date: `${date}T23:30:00Z`, season: { year: 2026, type: 2 }, status: { type: { completed: true, state: 'post', name: 'STATUS_FINAL' } }, competitions: [{ type: { id: '1', abbreviation: 'STD' }, competitors: [{ score: '10' }, { score: '10' }] }] }] };
  const metadata: AiSingleTeamMetadata = { season: 2026, firstDate: date, lastDate: date, forecastAsOf: '2025-07-01T00:00:00.000Z', players: pool.players.map(row => ({ id: row.id, name: `Player ${row.id}`, nbaTeamId: 1, slots: [0, 12], rank: null, injury: null, forecast: zero() })), matchups: [], officialScores: [], actualChampion: null, limitations: [], dates: [date], nbaGames: [{ id: '999', date, startsAt: `${date}T23:30:00Z`, scoringPeriod: 1, home: 1, away: 2 }], capturedAt: '2026-10-07T00:00:00.000Z', sourceHash: 'b'.repeat(64) };
  return { evidence: { league, pool, scoreboard }, metadata };
}
function parse(value = fixture()) { return parseAiSingleTeamDay(value.evidence, value.metadata, date, snapshotId); }

test('historical owner source ignores final-season ownership and preserves bench/IR without scoring them', () => {
  const day = parse();
  assert.deepEqual(day.availablePlayerIds, [11]);
  assert.equal(day.owners[0].stats.pts, 2);
  assert.deepEqual(day.owners[0].lineup, [{ slot: 0, playerId: 1 }, { slot: 12, playerId: 9 }, { slot: 13, playerId: 10 }]);
  assert.equal(day.stats.length, 11);
  assert.equal(day.scheduledPlayerIds.length, 10);
  assert.deepEqual(day.stats.find(row => row.playerId === 11)?.stats, zero());
  assert.doesNotMatch(JSON.stringify(day), /PRIVATE-OWNER|PRIVATE-MEMBER|members|onTeamId|status/);
});

test('historical source rejects wrong dates and aggregate statistics instead of leaking later production', () => {
  const wrongDay = fixture(); wrongDay.evidence.league.scoringPeriodId = 2;
  assert.throws(() => parse(wrongDay), /wrong league, season, or date/);
  const future = fixture(); future.evidence.pool.players[0].player.stats[0].statSplitTypeId = 0;
  assert.throws(() => parse(future), /incorrect date or future aggregate/);
});

test('full-player universe and NBA final score audits detect missing player contributions', () => {
  const missing = fixture(); missing.evidence.pool.players.pop();
  assert.throws(() => parse(missing), /missing rows/);
  const score = fixture(); score.evidence.pool.players[0].player.stats[0].stats[0] = 1;
  assert.throws(() => parse(score), /NBA final score/);
  const missingGame = fixture(); missingGame.evidence.scoreboard.events = [];
  assert.throws(() => parse(missingGame), /season calendar/);
});

test('actual daily roster identities and their independent stat snapshots must agree', () => {
  const wrongRoster = fixture(); wrongRoster.evidence.league.teams[0].roster.entries[0].lineupSlotId = 12;
  assert.throws(() => parse(wrongRoster), /rosters disagree/);
  const wrongStats = fixture(); wrongStats.evidence.league.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerPoolEntry.player.stats[0].stats[3] = 2;
  assert.throws(() => parse(wrongStats), /statistics conflict/);
  const wrongId = fixture(); wrongId.evidence.league.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerPoolEntry.player.id = 9;
  assert.throws(() => parse(wrongId), /player identity/);
});

test('saved day validation recomputes lineups, rejects wrong identity and strips unknown fields', () => {
  const value = fixture(), day = parse(value);
  assert.throws(() => validateAiSingleTeamDay({ ...day, scoringPeriodId: 2 }, value.metadata, date), /identity or coverage/);
  const modified = structuredClone(day); modified.owners[0].stats.pts = 3;
  assert.throws(() => validateAiSingleTeamDay(modified, value.metadata, date), /actual lineup/);
  const missing = structuredClone(day); missing.stats.pop();
  assert.throws(() => validateAiSingleTeamDay(missing, value.metadata, date), /statistics are missing/);
  assert.equal('members' in validateAiSingleTeamDay({ ...day, members: ['PRIVATE'] }, value.metadata, date), false);
});

test('explicit postponed games contribute zero, while missing or active games never become zero', () => {
  const value = fixture(), event = value.evidence.scoreboard.events[0];
  event.status.type.completed = false; event.status.type.name = 'STATUS_POSTPONED';
  assert.throws(() => parse(value), /postponed game contains/);
  for (const row of value.evidence.pool.players) row.player.stats = [];
  for (const team of value.evidence.league.teams) for (const entry of team.roster.entries) entry.playerPoolEntry.player.stats = [];
  for (const matchup of value.evidence.league.schedule) for (const side of [matchup.home, matchup.away]) for (const entry of side.rosterForCurrentScoringPeriod.entries) entry.playerPoolEntry.player.stats = [];
  assert.equal(parse(value).scheduledPlayerIds.length, 0);
  event.status.type.state = 'in'; event.status.type.name = 'STATUS_IN_PROGRESS';
  assert.throws(() => parse(value), /not complete/);
});

function fullMetadata(): AiSingleTeamMetadata {
  const dates = Array.from({ length: 160 }, (_, index) => new Date(Date.parse(`${date}T12:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
  const players = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, slots: [0, 12], rank: null, injury: null, nbaTeamId: 1, forecast: zero() }));
  const matchups = Array.from({ length: 80 }, (_, index) => ({ id: String(index + 1), period: Math.floor(index / 4) + 1, home: String(index % 4 * 2 + 1), away: String(index % 4 * 2 + 2), start: dates[Math.floor(index / 4) * 8], end: dates[Math.floor(index / 4) * 8 + 7], playoff: index >= 72 }));
  return { ...fixture().metadata, dates, lastDate: dates.at(-1)!, players, matchups, officialAdjustments: [],
    ownerDraft: Array.from({ length: 104 }, (_, index) => ({ teamId: String(index % 8 + 1), playerId: index + 1, name: players[index].name, overallPick: index + 1, keeper: false })),
    officialScores: matchups.flatMap(row => [row.home, row.away].map(teamId => ({ period: row.period, teamId, categories: Object.fromEntries([0, 1, 2, 3, 6, 11, 17, 19, 20].map(id => [String(id), 0])) }))),
    expectedRegularRecords: Array.from({ length: 8 }, (_, index) => ({ teamId: String(index + 1), wins: 81, losses: 81, ties: 0 })),
  };
}

test('metadata cache validation strips unknown fields and requires prior forecasts and complete coverage', () => {
  const metadata = fullMetadata();
  assert.equal('members' in validateAiSingleTeamMetadata({ ...metadata, members: ['PRIVATE'] }), false);
  const future = structuredClone(metadata); future.forecastAsOf = date;
  assert.throws(() => validateAiSingleTeamMetadata(future), /calendar or player identities/);
  const missing = structuredClone(metadata); missing.officialScores.pop();
  assert.throws(() => validateAiSingleTeamMetadata(missing), /incomplete or malformed/);
  const overlap = structuredClone(metadata); overlap.matchups.slice(4, 8).forEach(row => row.start = date);
  assert.throws(() => validateAiSingleTeamMetadata(overlap), /overlap or leave gaps/);
  const currentRank = structuredClone(metadata); currentRank.players[0].rank = 1;
  assert.throws(() => validateAiSingleTeamMetadata(currentRank), /incomplete or malformed/);
  const audited = { ...metadata, officialAdjustments: [{ season: 2026, period: 18, teamId: '8', stat: 'blk', reconstructed: 20, official: 19, reason: 'Audited NBA daily/ESPN weekly discrepancy.' }] };
  assert.throws(() => validateAiSingleTeamMetadata(audited), /contradicts its official weekly source/);
  audited.officialScores.find(row => row.period === 18 && row.teamId === '8')!.categories['1'] = 19;
  assert.equal(validateAiSingleTeamMetadata(audited).officialAdjustments?.length, 1);
  audited.officialAdjustments[0].teamId = '7';
  assert.throws(() => validateAiSingleTeamMetadata(audited), /incomplete or malformed/);
});

test('an independently reconciled NBA box can account only for contributors outside the fantasy universe', () => {
  const value = fixture(); value.evidence.scoreboard.events[0].competitions[0].competitors[1].score = '16';
  const athletes = Array.from({ length: 10 }, (_, index) => ({ athlete: { id: String(index + 1) }, stats: ['2', '1', '1', '0', '0', '0', '1-1', '0-0', '0-0'] }));
  athletes.push({ athlete: { id: '12' }, stats: ['6', '3', '1', '1', '0', '0', '2-7', '2-4', '0-0'] });
  const table = (rows: typeof athletes) => ({ statistics: [{ labels: ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FG', 'FT', '3PT'], athletes: rows }] });
  const box = { header: { season: { year: 2026, type: 2 }, competitions: [{ id: '999', status: { type: { completed: true, state: 'post' } } }] }, boxscore: { players: [table(athletes.slice(0, 5)), table(athletes.slice(5))] } };
  const evidence = { ...value.evidence, boxes: { '999': box } };
  const day = parseAiSingleTeamDay(evidence, value.metadata, date, snapshotId);
  assert.equal(day.stats.length, 11);
  assert.equal(day.stats.some(row => row.playerId === 12), false);
  assert.equal(day.owners[0].stats.pts, 2);
  box.boxscore.players[1].statistics[0].athletes.at(-1)!.athlete.id = '11';
  assert.throws(() => parseAiSingleTeamDay(evidence, value.metadata, date, snapshotId), /fantasy-eligible player contribution/);
  box.boxscore.players[1].statistics[0].athletes.at(-1)!.athlete.id = '12';
  box.boxscore.players[0].statistics[0].athletes[0].stats[2] = '2';
  assert.throws(() => parseAiSingleTeamDay(evidence, value.metadata, date, snapshotId), /fantasy-eligible player contribution/);
  box.boxscore.players[0].statistics[0].athletes[0].stats[2] = '1';
  value.metadata.players.push({ ...value.metadata.players[0], id: 5091709, name: 'Lachlan Olbrich' });
  const aliasRecord = structuredClone(value.evidence.pool.players[0]); aliasRecord.id = 5091709; aliasRecord.player.id = 5091709;
  aliasRecord.player.stats[0].stats = { 0: 0, 1: 0, 2: 0, 3: 0, 6: 0, 11: 1, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0 };
  value.evidence.pool.players.push(aliasRecord);
  const aliasAthlete = { athlete: { id: '5107156', displayName: 'Lachlan Olbrich' }, stats: ['0', '0', '0', '0', '0', '1', '0-0', '0-0', '0-0'] };
  box.boxscore.players[1].statistics[0].athletes.push(aliasAthlete);
  assert.equal(parseAiSingleTeamDay(evidence, value.metadata, date, snapshotId).stats.find(row => row.playerId === 5091709)?.stats.tov, 1);
  aliasAthlete.athlete.displayName = 'Another Player';
  assert.throws(() => parseAiSingleTeamDay(evidence, value.metadata, date, snapshotId), /alias could not be verified/);
});
