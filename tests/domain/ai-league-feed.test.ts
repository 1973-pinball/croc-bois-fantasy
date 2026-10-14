import assert from 'node:assert/strict';
import test from 'node:test';
import { aiScoringDate, extractAiBoxScore, extractAiMatchups, extractAiNbaSchedule, extractAiPlayers, fetchAiDailyStats, fetchAiPlayerPool } from '../../src/lib/ai-league-feed';

const averages = { '0': 20, '1': 1, '2': 2, '3': 5, '6': 7, '11': 3, '13': 7, '14': 15, '15': 4, '16': 5, '17': 2 };
const player = (stats: unknown[], extra = {}) => ({ id: 1, player: { id: 1, fullName: 'Test Player', proTeamId: 2, eligibleSlots: [0, 5, 11, 12], injuryStatus: 'OUT', draftRanksByRankType: { ROTO: { rank: 1 } }, stats, ...extra } });
const stat = (seasonId: number, statSourceId: number, extra = {}) => ({ seasonId, statSourceId, statSplitTypeId: 0, averageStats: { ...averages, ...extra } });
const game = { id: 100, date: Date.parse('2026-10-21T02:00:00Z'), scoringPeriodId: 1, homeProTeamId: 2, awayProTeamId: 3 };
const calendar = () => ({ settings: { proTeams: [{ id: 2, proGamesByScoringPeriod: { 1: [game] } }, { id: 3, proGamesByScoringPeriod: { 1: [game] } }] } });
const athlete = (id: number, values?: string[]) => ({ athlete: { id: String(id) }, didNotPlay: !values, stats: values ?? [] });
const labels = ['PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK'];
const box = () => ({ header: { season: { year: 2026, type: 2 }, competitions: [{ id: '100', status: { type: { completed: true } } }] }, boxscore: { players: [
  { statistics: [{ labels, athletes: [athlete(1, ['20', '7-15', '2-6', '4-5', '7', '5', '3', '2', '1']), athlete(2)] }] },
  { statistics: [{ labels, athletes: [athlete(3, ['10', '4-8', '0-1', '2-2', '9', '2', '0', '0', '2'])] }] },
] } });

test('live forecasts prefer preseason projections; replay cannot ingest target-season outcomes, rankings, or injuries', () => {
  const current = { players: [player([stat(2027, 1, { '0': 25 }), stat(2026, 0, { '0': 80 })])] };
  assert.equal(extractAiPlayers(current, 2027)[0].forecast.pts, 25);
  const prior = { players: [player([stat(2025, 0, { '0': 15 }), stat(2026, 0, { '0': 99 })])] };
  const historical = extractAiPlayers(current, 2026, true, prior)[0];
  assert.equal(historical.forecast.pts, 15);
  assert.equal(historical.rank, null);
  assert.equal(historical.injury, null);
  assert.equal(extractAiPlayers(current, 2026, true)[0].forecast.pts, 0);
  assert.deepEqual(Object.keys(historical).sort(), ['forecast', 'id', 'injury', 'name', 'nbaTeamId', 'rank', 'slots']);
});

test('partial forecasts are not accepted as zero in a missing category; duplicate identities fail', () => {
  const bad = stat(2027, 1); delete (bad.averageStats as Record<string, unknown>)['13'];
  assert.equal(extractAiPlayers({ players: [player([bad, stat(2026, 0)])] }, 2027)[0].forecast.fgm, 7);
  assert.throws(() => extractAiPlayers({ players: [player([]), player([])] }, 2027), /duplicate/);
});

test('calendar deduplicates both team views and uses New York dates across UTC midnight', () => {
  const games = extractAiNbaSchedule(calendar());
  assert.equal(games.length, 1);
  assert.equal(games[0].date, '2026-10-20');
  assert.equal(aiScoringDate(games, 3), '2026-10-22');
  const invalid = calendar(); invalid.settings.proTeams[1].proGamesByScoringPeriod[1] = [{ ...game, date: game.date + 60_000 }];
  assert.throws(() => extractAiNbaSchedule(invalid), /conflicting/);
});

test('matchup boundaries follow ESPN period definitions including extended periods and playoffs', () => {
  const settings = { scheduleSettings: { matchupPeriodCount: 1, matchupPeriods: { 1: [1], 2: [2, 3] } }, scoringSettings: { scoringType: 'H2H_CATEGORY' } };
  const rows = extractAiMatchups({ id: 139935, settings, schedule: [{ id: 1, matchupPeriodId: 1, home: { teamId: 1 }, away: { teamId: 2 } }] }, extractAiNbaSchedule(calendar()), [{ id: 1, start: 1, end: 6 }, { id: 2, start: 7, end: 13 }, { id: 3, start: 14, end: 20 }]);
  assert.equal(rows[0].end, '2026-10-25');
  assert.deepEqual({ start: rows[1].start, end: rows[1].end, playoff: rows[1].playoff }, { start: '2026-10-26', end: '2026-11-08', playoff: true });
});

test('box scores preserve makes/attempts and explicit DNP zeroes for all roster participants', () => {
  const result = extractAiBoxScore(box(), '100', 2026);
  assert.equal(result.complete, true);
  assert.deepEqual(result.playerIds, [1, 2, 3]);
  assert.equal(result.stats[0].stats.fgm, 7);
  assert.equal(result.stats[0].stats.fga, 15);
  assert.equal(result.stats[0].stats.tov, 3);
  assert.equal(result.stats[1].stats.pts, 0);
});

test('final box scores cannot silently score missing categories, absent teams, or another season', () => {
  const missing = box(); missing.boxscore.players[0].statistics[0].labels = labels.filter(label => label !== 'FT');
  assert.throws(() => extractAiBoxScore(missing, '100', 2026), /category/);
  const truncated = box(); truncated.boxscore.players.pop();
  assert.throws(() => extractAiBoxScore(truncated, '100', 2026), /incomplete/);
  assert.throws(() => extractAiBoxScore(box(), '100', 2027), /another game or season/);
});

test('unidentified empty DNP roster stubs are harmless, but unidentified scoring participants stop ingestion', () => {
  const source = box();
  const stub = source.boxscore.players[0].statistics[0].athletes[1];
  delete (stub.athlete as { id?: string }).id;
  const result = extractAiBoxScore(source, '100', 2026);
  assert.deepEqual(result.playerIds, [1, 3]);
  assert.equal(result.complete, true);
  stub.didNotPlay = false;
  assert.throws(() => extractAiBoxScore(source, '100', 2026), /invalid identifier/);
  stub.didNotPlay = true;
  stub.stats = ['1'];
  assert.throws(() => extractAiBoxScore(source, '100', 2026), /invalid identifier/);
  const table = source.boxscore.players[0].statistics[0];
  table.labels = ['MIN', ...labels];
  table.athletes[0].stats.unshift('35');
  stub.didNotPlay = false;
  stub.stats = ['--', '0', '0-0', '0-0', '0-0', '0', '0', '0', '0', '0'];
  assert.deepEqual(extractAiBoxScore(source, '100', 2026).playerIds, [1, 3]);
  stub.stats[1] = '1';
  assert.throws(() => extractAiBoxScore(source, '100', 2026), /invalid identifier/);
});

test('read-only credential fetch uses the fixed league URL, blocks redirects, and emits no source body in errors', async () => {
  const original = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { captured = { url: String(url), init }; return new Response('private-member-data', { status: 302 }); }) as typeof fetch;
  try {
    await assert.rejects(fetchAiPlayerPool(2027, { espnS2: 'example-s2', swid: 'example-swid' }), error => error instanceof Error && error.message.includes('302') && !error.message.includes('private-member'));
    assert.equal(captured?.url, 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/139935?view=kona_player_info');
    assert.equal(captured?.init?.redirect, 'manual');
    assert.equal(captured?.init?.cache, 'no-store');
  } finally { globalThis.fetch = original; }
});

test('player pool fetch preserves raw ESPN ROTO draft ranks for projection imports', async () => {
  const original = globalThis.fetch;
  const payload = { players: [player([], { draftRanksByRankType: { ROTO: { rank: 42, rankType: 'ROTO', slotId: 0, published: false }, STANDARD: { rank: 3 } } })] };
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  try {
    assert.deepEqual(await fetchAiPlayerPool(2027, { espnS2: 'example-s2', swid: 'example-swid' }), payload);
  } finally { globalThis.fetch = original; }
});

test('public daily stats never receive ESPN cookies and empty scheduled days are explicit', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).Cookie, undefined);
    return Response.json({ events: [] });
  }) as typeof fetch;
  try {
    const day = await fetchAiDailyStats('2026-10-21', 2027, []);
    assert.deepEqual(day.playerIds, []);
    assert.deepEqual(day.stats, []);
    assert.equal(day.complete, true);
    await assert.rejects(fetchAiDailyStats('2026-10-20', 2027, [], false, extractAiNbaSchedule(calendar())), /does not reconcile/);
  } finally { globalThis.fetch = original; }
});

test('NBA Cup final and All-Star events do not count as fantasy games despite the regular-season label', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ events: [
    { id: '10', season: { year: 2026, type: 2 }, competitions: [{ type: { id: '39', abbreviation: 'CC' } }] },
    { id: '11', season: { year: 2026, type: 2 }, competitions: [{ type: { id: '4', abbreviation: 'ALLSTAR' } }] },
  ] })) as typeof fetch;
  try {
    const day = await fetchAiDailyStats('2025-12-16', 2026, [], true, []);
    assert.equal(day.complete, true);
    assert.deepEqual(day.stats, []);
    globalThis.fetch = (async () => Response.json({ events: [{ id: '10', season: { year: 2026, type: 2 }, competitions: [{ type: { id: '1', abbreviation: 'STD' } }] }] })) as typeof fetch;
    await assert.rejects(fetchAiDailyStats('2025-12-16', 2026, [], true, []), /does not reconcile/);
  } finally { globalThis.fetch = original; }
});

test('explicitly postponed games with no contribution finish their original date, while active games remain pending', () => {
  const source = { header: { season: { year: 2026, type: 2 }, competitions: [{ id: '100', status: { type: { name: 'STATUS_POSTPONED', state: 'post', completed: false } } }] }, boxscore: { players: [] as unknown[] } };
  assert.deepEqual(extractAiBoxScore(source, '100', 2026), { complete: true, playerIds: [], stats: [] });
  source.header.competitions[0].status.type = { name: 'STATUS_SCHEDULED', state: 'pre', completed: false };
  assert.equal(extractAiBoxScore(source, '100', 2026).complete, false);
  source.header.competitions[0].status.type = { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false };
  assert.equal(extractAiBoxScore(source, '100', 2026).complete, false);
  source.header.competitions[0].status.type = { name: 'STATUS_POSTPONED', state: 'post', completed: false };
  source.boxscore.players = [{ statistics: [{ athletes: [{ stats: ['0', '0-0', '--'] }] }] }];
  assert.equal(extractAiBoxScore(source, '100', 2026).complete, true);
  source.boxscore.players = box().boxscore.players;
  assert.throws(() => extractAiBoxScore(source, '100', 2026), /contains statistics/);
});
