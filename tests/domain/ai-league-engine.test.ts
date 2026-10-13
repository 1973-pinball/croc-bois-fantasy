import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceAiLeagueRun, createAiLeagueRun } from '../../src/lib/ai-league-engine';
import { refreshDates } from '../../src/lib/ai-league-refresh';
import type { AiGameDay, AiLeagueFeed, AiPlayer, AiStats } from '../../src/lib/ai-league-types';

const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const clubs = Array.from({ length: 8 }, (_, i) => ({ id: `team-${i + 1}`, name: `Team ${i + 1}`, shortName: `T${i + 1}`, color: '#00aa88' }));
const pool = (): AiPlayer[] => Array.from({ length: 112 }, (_, i) => ({
  id: i + 1, name: `Player ${i + 1}`, nbaTeamId: i % 30 + 1,
  slots: [i % 5, i % 5 < 2 ? 5 : 6, 11], rank: i + 1, injury: null,
  forecast: { pts: 30 - i / 5, reb: 9 - i / 20, ast: 7 - i / 30, stl: 1.8 - i / 100, blk: 1.7 - i / 100, tov: 2, three: 3 - i / 60, fgm: 8, fga: 16, ftm: 3, fta: 4 },
}));
const day = (date: string, playerIds: number[] = [], complete = true): AiGameDay => ({ date, startsAt: `${date}T23:00:00.000Z`, playerIds, stats: playerIds.map(playerId => ({ playerId, stats: zero() })), complete });
function feed(overrides: Partial<AiLeagueFeed> = {}): AiLeagueFeed {
  return {
    season: 2027, capturedAt: '2026-09-01T12:00:00.000Z', forecastAsOf: '2026-07-01T00:00:00.000Z',
    currentDate: '2026-09-01', firstDate: '2026-10-01', lastDate: '2026-10-03', players: pool(),
    matchups: [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `regular-${i}`, period: 1, home: clubs[i * 2].id, away: clubs[i * 2 + 1].id, start: '2026-10-01', end: '2026-10-01', playoff: false })),
      { id: 'actual-semi', period: 2, home: 'actual-home', away: 'actual-away', start: '2026-10-02', end: '2026-10-02', playoff: true },
      { id: 'actual-final', period: 3, home: 'actual-home', away: 'actual-away', start: '2026-10-03', end: '2026-10-03', playoff: true },
    ], days: [], limitations: [], ...overrides,
  };
}
const preseason = () => createAiLeagueRun(feed(), clubs);
function actualFeed(days: AiGameDay[], overrides: Partial<AiLeagueFeed> = {}) {
  return feed({ currentDate: '2026-10-04', capturedAt: '2026-10-04T12:00:00.000Z', days, ...overrides });
}

test('fresh snake draft is deterministic, immutable, and has exactly one owner per player', () => {
  const input = feed();
  const before = structuredClone(input);
  const run = createAiLeagueRun(input, clubs);
  const again = createAiLeagueRun(input, [...clubs].reverse());
  assert.deepEqual(input, before);
  assert.equal(run.status, 'preseason');
  assert.equal(run.decisions.length, 104);
  assert.deepEqual(run.initialPlayers, input.players);
  assert.equal(run.forecastAsOf, input.forecastAsOf);
  assert.equal(new Set(run.teams.flatMap(team => team.roster)).size, 104);
  assert.ok(run.teams.every(team => team.roster.length === 13));
  assert.deepEqual(run.draftOrder, again.draftOrder);
  assert.deepEqual(run.decisions, again.decisions);
  assert.deepEqual(run.decisions.slice(8, 16).map(item => item.teamId), [...run.draftOrder].reverse());
});

test('missing or post-cutoff forecasts cannot produce a historical draft', () => {
  for (const forecastAsOf of [undefined, '2026-10-02T12:00:00Z']) {
    const run = createAiLeagueRun(actualFeed([], { forecastAsOf }), clubs);
    assert.equal(run.status, 'needs_data');
    assert.equal(run.decisions.length, 0);
    assert.match(run.message, /forecast provenance/i);
  }
});

test('future actual statistics cannot affect the draft or first-day choices', () => {
  const ids = pool().map(player => player.id);
  const first = day('2026-10-01', ids);
  const second = structuredClone(first);
  second.stats = second.stats.map(row => ({ ...row, stats: { ...zero(), pts: row.playerId * 1000, ast: row.playerId * 100 } }));
  const a = createAiLeagueRun(actualFeed([first]), clubs);
  const b = createAiLeagueRun(actualFeed([second]), clubs);
  assert.deepEqual(a.decisions, b.decisions);
  assert.deepEqual(a.lineups, b.lineups);
  assert.notDeepEqual(a.results, b.results);
});

test('lineup matching keeps rigid positions open and assigns each player once', () => {
  const run = preseason();
  const team = run.teams[0];
  const [flexible, rigid] = team.roster;
  run.players.find(player => player.id === flexible)!.slots = [0, 1, 11];
  run.players.find(player => player.id === rigid)!.slots = [0];
  const live = feed({ currentDate: '2026-10-01', capturedAt: '2026-10-01T12:00:00Z', days: [day('2026-10-01', [flexible, rigid], false)] });
  const updated = advanceAiLeagueRun(run, live);
  const lineup = updated.lineups.find(item => item.teamId === team.id)!;
  assert.equal(lineup.slots.length, 2);
  assert.equal(lineup.slots.find(slot => slot.playerId === rigid)?.slot, 0);
  for (const item of updated.lineups) {
    assert.equal(new Set(item.slots.map(slot => slot.playerId)).size, item.slots.length);
    assert.ok(item.slots.every(slot => updated.players.find(player => player.id === slot.playerId)!.slots.includes(slot.slot)));
    assert.ok(Date.parse(item.decidedAt) < Date.parse(live.days[0].startsAt));
  }
});

test('live locks never backfill hindsight decisions, but later on-time management continues', () => {
  const run = preseason();
  const ids = pool().map(player => player.id);
  const current = feed({
    currentDate: '2026-10-02', capturedAt: '2026-10-02T12:00:00Z',
    matchups: feed().matchups.filter(item => !item.playoff).map(item => ({ ...item, end: '2026-10-02' })),
    days: [day('2026-10-01', ids), day('2026-10-02', ids, false)],
  });
  run.matchups = current.matchups;
  const updated = advanceAiLeagueRun(run, current);
  assert.equal(updated.status, 'needs_data');
  assert.match(updated.message, /missed live lineup lock/i);
  assert.equal(updated.lineups.filter(lineup => lineup.date === '2026-10-01').length, 0);
  assert.equal(updated.lineups.filter(lineup => lineup.date === '2026-10-02').length, 8);
  assert.equal(updated.scoredDates.includes('2026-10-01'), false);
  assert.deepEqual(updated.missedDates, ['2026-10-01']);
  assert.ok(updated.standings.every(row => row.played === 0));
});

test('replay stops at missing earlier data rather than learning future outcomes first', () => {
  const run = createAiLeagueRun(actualFeed([day('2026-10-02', pool().map(player => player.id))]), clubs);
  assert.equal(run.status, 'needs_data');
  assert.equal(run.lineups.length, 0);
  assert.equal(run.scoredDates.length, 0);
  const partial = createAiLeagueRun(actualFeed([day('2026-10-01', [1], false), day('2026-10-02', [1])]), clubs);
  assert.equal(partial.scoredDates.length, 0);
  assert.ok(partial.lineups.every(lineup => lineup.date === '2026-10-01'));
  assert.match(partial.message, /^Incomplete game statistics for 2026-10-01\./);
});

test('completed scoring sums shooting makes/attempts, reverses turnovers, and excludes live standings', () => {
  const run = preseason();
  const home = run.teams.find(team => team.id === 'team-1')!;
  const away = run.teams.find(team => team.id === 'team-2')!;
  const selected = [home.roster[0], home.roster[1], away.roster[0]];
  const current = feed({ currentDate: '2026-10-01', capturedAt: '2026-10-01T12:00:00Z', days: [day('2026-10-01', selected, false)] });
  const pending = advanceAiLeagueRun(run, current);
  assert.ok(pending.standings.every(row => row.played === 0));
  const finishedDay = day('2026-10-01', selected);
  finishedDay.stats = [
    { playerId: selected[0], stats: { ...zero(), fgm: 1, fga: 1, ftm: 1, fta: 1, tov: 1 } },
    { playerId: selected[1], stats: { ...zero(), fgm: 1, fga: 9, ftm: 1, fta: 9, tov: 1 } },
    { playerId: selected[2], stats: { ...zero(), fgm: 4, fga: 10, ftm: 4, fta: 10, tov: 3 } },
  ];
  const result = advanceAiLeagueRun(pending, { ...current, capturedAt: '2026-10-02T06:00:00Z', days: [finishedDay] });
  const matchup = result.results.find(item => item.matchupId === 'regular-0')!;
  assert.equal(matchup.homeStats.fgm, 2);
  assert.equal(matchup.homeStats.fga, 10);
  assert.equal(matchup.homeWins, 1);
  assert.equal(matchup.awayWins, 2);
  assert.equal(matchup.ties, 6);
  assert.equal(matchup.complete, true);
  assert.deepEqual(result.initialPlayers, run.initialPlayers);
  assert.equal(result.standings.find(row => row.teamId === home.id)?.wins, 1);
  assert.deepEqual(advanceAiLeagueRun(result, { ...current, capturedAt: '2026-10-02T06:00:00Z', days: [finishedDay] }), result);
});

test('shared pickups preserve ownership, dropped-player cooldown, and four-acquisition period limit', () => {
  let run = preseason();
  const regular = feed().matchups.filter(item => !item.playoff).map(item => ({ ...item, end: '2026-10-06' }));
  run.matchups = regular;
  // Isolate acquisition fairness: all players have identical safe prior value.
  for (const player of run.players) player.forecast = { ...zero(), pts: 10, reb: 5, ast: 3, fgm: 4, fga: 8, ftm: 2, fta: 3 };
  const history: AiGameDay[] = [];
  for (let index = 1; index <= 6; index++) {
    const date = `2026-10-0${index}`;
    const owned = new Set(run.teams.flatMap(team => team.roster));
    const free = run.players.filter(player => !owned.has(player.id)).map(player => player.id);
    const next = day(date, free, false);
    const current = feed({ firstDate: '2026-10-01', lastDate: '2026-10-08', currentDate: date, capturedAt: `${date}T12:00:00Z`, matchups: regular, days: [...history, next] });
    const original = run;
    const before = structuredClone(original);
    run = advanceAiLeagueRun(run, current);
    assert.deepEqual(original, before);
    assert.equal(new Set(run.teams.flatMap(team => team.roster)).size, 104);
    const moves = run.decisions.filter(decision => decision.kind === 'add_drop' && decision.date === date);
    assert.equal(new Set(moves.map(move => move.playerIds[0])).size, moves.length);
    assert.ok(moves.every(move => free.includes(move.playerIds[0])));
    assert.ok(Object.values(run.acquisitions).every(count => count <= 4));
    history.push({ ...next, complete: true });
    run = advanceAiLeagueRun(run, { ...current, capturedAt: `${date}T23:59:59Z`, days: history });
  }
  assert.ok(run.decisions.some(decision => decision.kind === 'add_drop'));
  assert.ok(Object.values(run.acquisitions).some(count => count === 4));
});

test('playoffs seed simulated standings and name a champion only after the final is scored', () => {
  const regular = day('2026-10-01');
  const semifinal = day('2026-10-02');
  const final = day('2026-10-03');
  const initial = createAiLeagueRun(actualFeed([regular, semifinal]), clubs);
  assert.equal(initial.champion, null);
  const bracket = initial.matchups.filter(matchup => matchup.playoff);
  assert.equal(bracket.length, 3);
  assert.ok(bracket.every(matchup => !matchup.home.startsWith('actual') && !matchup.away.startsWith('actual')));
  assert.equal(bracket.find(matchup => matchup.id === 'ai-semifinal-1')?.home, initial.standings[0].teamId);
  assert.equal(bracket.find(matchup => matchup.id === 'ai-semifinal-1')?.away, initial.standings[3].teamId);
  const before = structuredClone(initial);
  const complete = advanceAiLeagueRun(initial, actualFeed([regular, semifinal, final]));
  assert.deepEqual(initial, before);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.champion, complete.standings[0].teamId);
  assert.equal(complete.scoredDates.length, 3);
  assert.ok(complete.standings.every(row => row.played === 1));
  assert.deepEqual(advanceAiLeagueRun(complete, actualFeed([regular, semifinal, final])), complete);
});

test('zero-attempt percentages explicitly tie instead of producing NaN or an arbitrary winner', () => {
  const complete = createAiLeagueRun(actualFeed([day('2026-10-01'), day('2026-10-02'), day('2026-10-03')]), clubs);
  assert.ok(complete.results.every(result => result.homeWins === 0 && result.awayWins === 0 && result.ties === 9));
  assert.match(complete.limitations.join(' '), /zero attempts/);
});

test('new live signings can enter the shared market without replacing saved forecasts', () => {
  const run = preseason();
  const originalForecast = structuredClone(run.players[0].forecast);
  const updatedPlayers = pool();
  updatedPlayers[0].forecast.pts = 999;
  updatedPlayers.push({ ...pool()[0], id: 999, name: 'New signing' });
  const live = feed({ currentDate: '2026-10-01', capturedAt: '2026-10-01T12:00:00Z', players: updatedPlayers, days: [day('2026-10-01', [999], false)] });
  const updated = advanceAiLeagueRun(run, live);
  assert.ok(updated.players.some(player => player.id === 999));
  assert.deepEqual(updated.players[0].forecast, originalForecast);
  assert.equal(new Set(updated.teams.flatMap(team => team.roster)).size, 104);
  const replay = createAiLeagueRun(actualFeed([day('2026-10-01', [1])]), clubs);
  const replayUpdated = advanceAiLeagueRun(replay, actualFeed([day('2026-10-01', [1]), day('2026-10-02', [999])], { players: updatedPlayers }));
  assert.equal(replayUpdated.players.some(player => player.id === 999), false);
});

test('a missed empty NBA day is recovered without inventing after-lock decisions', () => {
  const run = preseason();
  run.matchups = run.matchups.map(matchup => ({ ...matchup, end: '2026-10-02' }));
  assert.deepEqual(refreshDates(run, '2026-10-02', 3), ['2026-10-01', '2026-10-02']);
  const current = feed({
    currentDate: '2026-10-02', capturedAt: '2026-10-02T12:00:00Z', matchups: run.matchups,
    days: [day('2026-10-01'), day('2026-10-02', pool().map(player => player.id), false)],
  });
  const updated = advanceAiLeagueRun(run, current);
  assert.ok(updated.scoredDates.includes('2026-10-01'));
  assert.equal(updated.lineups.some(lineup => lineup.date === '2026-10-01'), false);
  assert.equal(updated.lineups.filter(lineup => lineup.date === '2026-10-02').length, 8);
  assert.deepEqual(updated.missedDates, []);
});
