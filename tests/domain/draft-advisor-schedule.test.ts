import assert from 'node:assert/strict';
import test from 'node:test';
import { draftAdvisorScheduleSchema, draftScheduleEndDate, normalizeNbaTeam, parseDraftScheduleText } from '../../src/lib/draft-advisor-schedule';
import { fetchDraftAdvisorSchedule, parseEspnDraftSchedule, parseEspnRegularSeason } from '../../src/lib/draft-advisor-schedule-server';

const options = { seasonId: 2027, startDate: '2026-10-20', fetchedAt: '2026-10-13T15:00:00.000Z' };
const abbreviations = ['ATL', 'BOS', 'NO', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MIA', 'MIL', 'MIN', 'BKN', 'NY', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'OKC', 'UTAH', 'WSH', 'TOR', 'MEM', 'CHA'];
function espnSchedule() {
  const games = Array.from({ length: 14 }, (_, index) => ({ id: index + 100, date: Date.parse('2026-10-21T01:00:00Z') + index * 86_400_000, homeProTeamId: 1, awayProTeamId: 18, scoringPeriodId: index + 1 }));
  return { settings: { proTeams: abbreviations.map((abbrev, index) => ({ id: index + 1, abbrev, proGamesByScoringPeriod: Object.fromEntries(games.filter(game => game.homeProTeamId === index + 1 || game.awayProTeamId === index + 1).map(game => [game.scoringPeriodId, [game]])) })) } };
}
function fullEspnSchedule() {
  const teams = abbreviations.map((abbrev, index) => ({ id: index + 1, abbrev, proGamesByScoringPeriod: {} as Record<string, unknown[]> }));
  for (const [index, date] of ['2026-10-21T01:00:00Z', '2027-01-21T01:00:00Z', '2027-04-12T01:00:00Z'].entries()) {
    for (let id = 1; id <= 30; id += 2) {
      const scoringPeriodId = Math.round((Date.parse(date) - Date.parse('2026-10-21T01:00:00Z')) / 86_400_000) + 1;
      const game = { id: 1000 + index * 30 + id, date: Date.parse(date), homeProTeamId: id, awayProTeamId: id + 1, scoringPeriodId };
      teams[id - 1].proGamesByScoringPeriod[String(scoringPeriodId)] = [game];
      teams[id].proGamesByScoringPeriod[String(scoringPeriodId)] = [game];
    }
  }
  return { settings: { proTeams: teams } };
}

test('schedule CSV validates actual dates, normalizes source abbreviations and selects only the chosen week', () => {
  const result = parseDraftScheduleText('\uFEFFdate,team,note\r\n2026-10-20,NY,"home, opening"\r\n2026-10-20,GS,away\r\n2026-10-27,NO,later', options);
  assert.deepEqual(result.games, [{ date: '2026-10-20', team: 'GSW' }, { date: '2026-10-20', team: 'NYK' }]);
  assert.equal(result.endDate, '2026-10-26');
  assert.equal(result.fetchedAt, options.fetchedAt);
  assert.match(result.warnings[0], /not independently verified/);
  assert.equal(normalizeNbaTeam(' utah '), 'UTA');
  assert.equal(normalizeNbaTeam('FA'), null);
});

test('tab separated schedules and leap-day windows work without local time-zone shifts', () => {
  const schedule = parseDraftScheduleText('Game Date\tNBA Team\n2028-02-29\tSA\n2028-02-29\tWSH', { seasonId: 2028, startDate: '2028-02-27' });
  assert.deepEqual(schedule.games.map(game => game.team), ['SAS', 'WAS']);
  assert.equal(draftScheduleEndDate('2028-02-27'), '2028-03-04');
});

test('schedule import rejects duplicate alias games, impossible dates, stale seasons and ambiguous headers', () => {
  for (const [text, expected] of [
    ['date,team\n2026-10-20,NY\n2026-10-20,NYK', /repeats/],
    ['date,team\n2026-02-30,BOS', /valid date/],
    ['date,team\n2025-10-20,BOS', /another NBA season/],
    ['date,team\n2026-10-20,XYZ', /unrecognized/],
    ['date,date,team\n2026-10-20,2026-10-20,BOS', /exactly one/],
    ['date,team\n2026-10-20,"BOS', /unclosed/],
    ['date,team\n2026-10-20,"BOS"wrong', /after a quoted/],
    ['date,team\n2026-11-01,BOS', /no games/],
    ['date,team\n2026-10-20,BOS,extra', /number of columns/],
  ] as const) assert.throws(() => parseDraftScheduleText(text, options), expected);
  assert.throws(() => parseDraftScheduleText('date,team\n2026-10-20,BOS', { ...options, endDate: '2026-10-25' }), /seven-day/);
  assert.throws(() => parseDraftScheduleText('date,team\n2026-10-20,BOS', { ...options, startDate: '2027-06-29' }), /outside/);
});

test('ESPN NBA schedule uses Eastern dates, all verified teams, deduplicates both team views and exposes publication limits', () => {
  const result = parseEspnDraftSchedule(espnSchedule(), options);
  assert.equal(result.games.length, 14);
  assert.deepEqual(result.games[0], { date: '2026-10-20', team: 'ATL' });
  assert.deepEqual(result.games[1], { date: '2026-10-20', team: 'NYK' });
  assert.equal(result.games.at(-1)?.date, '2026-10-26');
  assert.match(result.warnings.join(' '), /not published 82 games/);
  assert.equal(draftAdvisorScheduleSchema.safeParse(result).success, true);
});

test('ESPN default starts at next published date, or labels historical opening week', () => {
  const next = parseEspnDraftSchedule(espnSchedule(), { seasonId: 2027, today: '2026-10-22' });
  assert.equal(next.startDate, '2026-10-22');
  const past = parseEspnDraftSchedule(espnSchedule(), { seasonId: 2027, today: '2027-10-13' });
  assert.equal(past.startDate, '2026-10-20');
  assert.match(past.warnings.join(' '), /no remaining published games/);
});

test('ESPN rejects incomplete teams, wrong-season games and unpublished portions of a requested window', () => {
  const incomplete = espnSchedule(); incomplete.settings.proTeams.pop();
  assert.throws(() => parseEspnDraftSchedule(incomplete, options), /all 30 teams/);
  assert.throws(() => parseEspnDraftSchedule(espnSchedule(), { ...options, seasonId: 2026 }), /requested season/);
  assert.throws(() => parseEspnDraftSchedule(espnSchedule(), { ...options, startDate: '2026-10-19' }), /published NBA schedule covers/);
  assert.throws(() => parseEspnDraftSchedule(espnSchedule(), { ...options, startDate: '2026-11-01' }), /published NBA schedule covers/);
  const conflicting = espnSchedule(); conflicting.settings.proTeams[17].proGamesByScoringPeriod['1'][0].date += 1;
  // Fixtures share object references in this helper, so explicitly introduce disagreement.
  conflicting.settings.proTeams[17].proGamesByScoringPeriod['1'] = [{ ...conflicting.settings.proTeams[17].proGamesByScoringPeriod['1'][0], date: Date.parse('2026-10-21T02:00:00Z') }];
  assert.throws(() => parseEspnDraftSchedule(conflicting, options), /conflicting games/);
});

test('response schema refuses out-of-window or duplicate team games', () => {
  const schedule = parseEspnDraftSchedule(espnSchedule(), options);
  assert.equal(draftAdvisorScheduleSchema.safeParse({ ...schedule, games: [...schedule.games, schedule.games[0]] }).success, false);
  assert.equal(draftAdvisorScheduleSchema.safeParse({ ...schedule, games: [{ date: '2026-11-20', team: 'BOS' }] }).success, false);
});

test('NBA fetch uses only the fixed public endpoint without cookies and rejects redirects or invalid seasons', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      calls += 1;
      assert.equal(String(input), 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027?view=proTeamSchedules_wl');
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).has('cookie'), false);
      return new Response(JSON.stringify(espnSchedule()), { status: 200 });
    };
    assert.equal((await fetchDraftAdvisorSchedule(options)).games.length, 14);
    await assert.rejects(() => fetchDraftAdvisorSchedule({ seasonId: 2027.1 }), /valid NBA season/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('', { status: 302, headers: { Location: 'https://example.com' } });
    await assert.rejects(() => fetchDraftAdvisorSchedule(options), /could not provide/);
  } finally { globalThis.fetch = originalFetch; }
});

test('full-season CSV includes every date and infers bounds, with explicit coverage warnings', () => {
  const result = parseDraftScheduleText('date,team\n2027-04-11,BOS\n2026-10-20,ATL\n2027-01-20,BOS', { seasonId: 2027, scope: 'season' });
  assert.equal(result.scope, 'season'); assert.equal(result.startDate, '2026-10-20'); assert.equal(result.endDate, '2027-04-11');
  assert.equal(result.games.length, 3);
  assert.ok(result.warnings.some(warning => warning.includes('82 games')));
  assert.ok(result.warnings.some(warning => warning.includes('No games were supplied')));
  assert.equal(draftAdvisorScheduleSchema.safeParse(result).success, true);
  assert.equal(draftAdvisorScheduleSchema.safeParse({ ...result, scope: 'week' }).success, false);
  assert.throws(() => parseDraftScheduleText('date,team\n2025-10-20,BOS', { seasonId: 2027, scope: 'season' }), /another NBA season/);
});

test('full ESPN season includes October, January and April regardless of today and rejects absent teams', () => {
  const result = parseEspnDraftSchedule(fullEspnSchedule(), { seasonId: 2027, scope: 'season', today: '2027-01-01' });
  assert.equal(result.scope, 'season'); assert.equal(result.startDate, '2026-10-20'); assert.equal(result.endDate, '2027-04-11');
  assert.equal(result.games.length, 90); assert.equal(new Set(result.games.map(game => game.team)).size, 30);
  assert.ok(result.warnings.some(warning => warning.includes('Monday–Sunday')));
  assert.ok(result.warnings.some(warning => warning.includes('not published 82 games')));
  assert.throws(() => parseEspnDraftSchedule(espnSchedule(), { seasonId: 2027, scope: 'season' }), /missing teams/);
});

test('full-season fetching verifies official regular-season boundaries and trims preseason/postseason fixtures', async () => {
  const bounds = { id: '2', type: 2, year: 2027, startDate: '2026-10-20T07:00Z', endDate: '2027-04-12T06:59Z' };
  const payload = fullEspnSchedule();
  for (const [index, date] of ['2026-10-10T01:00:00Z', '2027-04-20T01:00:00Z'].entries()) {
    const game = { id: 5000 + index, date: Date.parse(date), homeProTeamId: 1, awayProTeamId: 2, scoringPeriodId: 200 + index };
    payload.settings.proTeams[0].proGamesByScoringPeriod[String(game.scoringPeriodId)] = [game];
    payload.settings.proTeams[1].proGamesByScoringPeriod[String(game.scoringPeriodId)] = [game];
  }
  const original = globalThis.fetch; const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url)); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
      return new Response(JSON.stringify(String(url).startsWith('https://sports.core.api.espn.com/') ? bounds : payload));
    };
    const result = await fetchDraftAdvisorSchedule({ seasonId: 2027, scope: 'season' });
    assert.equal(calls.length, 2); assert.equal(result.games.length, 90);
    assert.equal(result.startDate, '2026-10-20'); assert.equal(result.endDate, '2027-04-11');
    assert.ok(calls.includes('https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/types/2'));
    globalThis.fetch = async url => new Response(JSON.stringify(String(url).startsWith('https://sports.core.api.espn.com/') ? { ...bounds, type: 3 } : payload));
    await assert.rejects(fetchDraftAdvisorSchedule({ seasonId: 2027, scope: 'season' }), /regular-season dates/);
  } finally { globalThis.fetch = original; }
  assert.throws(() => parseEspnRegularSeason({ ...bounds, year: 2026 }, 2027), /regular-season dates/);
  assert.throws(() => parseEspnRegularSeason({ ...bounds, endDate: 'invalid' }, 2027), /regular-season dates/);
});
