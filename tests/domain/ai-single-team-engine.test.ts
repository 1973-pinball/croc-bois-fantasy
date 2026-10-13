import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiSingleTeamReport } from '../../src/lib/ai-single-team-engine';
import type { AiStats } from '../../src/lib/ai-league-types';
import type { AiSingleTeamInput, AiSingleTeamScenario } from '../../src/lib/ai-single-team-types';

const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const keys = Object.keys(zero()) as (keyof AiStats)[];
const teams = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: `Team ${i + 1}`, shortName: `T${i + 1}`, color: '#123456' }));
const now = '2026-10-01T12:00:00Z';
const date = (day: number) => `2025-10-${String(day).padStart(2, '0')}`;
const performance = (quality: number): AiStats => ({ pts: quality * 10, reb: quality * 2, ast: quality, stl: quality, blk: quality, tov: 10 - quality, three: quality, fgm: 40 + quality, fga: 100, ftm: 50 + quality, fta: 100 });

/** Independent source reconstruction, so tests do not use engine scores as their expected baseline. */
function reconcile(input: AiSingleTeamInput) {
  for (const day of input.days) {
    const stats = new Map(day.stats.map(row => [row.playerId, row.stats]));
    for (const owner of day.owners) {
      owner.stats = zero();
      for (const slot of owner.lineup.filter(slot => slot.slot < 12)) for (const key of keys) owner.stats[key] += stats.get(slot.playerId)![key];
    }
  }
  const periods = [...new Map(input.matchups.map(matchup => [matchup.period, matchup])).values()];
  input.officialScores = periods.flatMap(period => teams.map(team => {
    const stats = zero();
    for (const day of input.days.filter(day => day.date >= period.start && day.date <= period.end)) for (const key of keys) stats[key] += day.owners.find(owner => owner.teamId === team.id)!.stats[key];
    return { period: period.period, teamId: team.id, categories: { '0': stats.pts, '1': stats.blk, '2': stats.stl, '3': stats.ast, '6': stats.reb, '11': stats.tov, '17': stats.three, '19': stats.fga ? stats.fgm / stats.fga : 0, '20': stats.fta ? stats.ftm / stats.fta : 0 } };
  }));
  return input;
}

function fixture(regularDays = 1): AiSingleTeamInput {
  const players = Array.from({ length: 128 }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, nbaTeamId: index % 30 + 1, slots: [index % 5, index % 5 < 2 ? 5 : 6, 11], rank: null, injury: null, forecast: { ...performance(5), pts: 15 + index / 20, reb: 5, ast: 3, stl: 1, blk: 1, three: 2, tov: 2, fgm: 5, fga: 10, ftm: 2, fta: 3 } }));
  const input: AiSingleTeamInput = {
    season: 2026, firstDate: date(1), lastDate: date(regularDays + 2), forecastAsOf: '2025-07-01T00:00:00Z', players,
    matchups: [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `regular-${i}`, period: 1, home: String(i + 1), away: String(8 - i), start: date(1), end: date(regularDays), playoff: false })),
      { id: 'actual-semi', period: 2, home: '1', away: '4', start: date(regularDays + 1), end: date(regularDays + 1), playoff: true },
      { id: 'actual-final', period: 3, home: '1', away: '2', start: date(regularDays + 2), end: date(regularDays + 2), playoff: true },
    ],
    days: Array.from({ length: regularDays + 2 }, (_, index) => ({
      date: date(index + 1), startsAt: `${date(index + 1)}T23:00:00Z`, complete: true, snapshotId: `snapshot-${index + 1}`, season: 2026, scoringPeriodId: index + 1,
      availablePlayerIds: players.slice(104).map(player => player.id), scheduledPlayerIds: players.map(player => player.id),
      stats: players.map(player => ({ playerId: player.id, stats: performance(player.id <= 104 ? 8 - Math.floor((player.id - 1) / 13) : 5) })),
      owners: teams.map((team, teamIndex) => {
        const roster = players.slice(teamIndex * 13, (teamIndex + 1) * 13).map(player => player.id);
        return { teamId: team.id, roster, lineup: roster.map((playerId, index) => ({ playerId, slot: index === 0 ? 0 : 12 })), stats: zero(), complete: true };
      }),
    })),
    ownerDraft: players.slice(0, 104).map((player, index) => ({ teamId: String(Math.floor(index / 13) + 1), playerId: player.id, name: player.name, overallPick: index + 1, keeper: index % 3 === 0 })),
    expectedRegularRecords: teams.map((team, index) => ({ teamId: team.id, wins: index < 4 ? 9 : 0, losses: index < 4 ? 0 : 9, ties: 0 })),
    officialScores: [], actualChampion: '1', limitations: [],
  };
  return reconcile(input);
}

const scenario = (report: ReturnType<typeof buildAiSingleTeamReport>, teamId = '1', mode: AiSingleTeamScenario['mode'] = 'post_draft') => report.scenarios.find(item => item.teamId === teamId && item.mode === mode)!;

test('certifies the independently known baseline and builds sixteen immutable independent experiments', () => {
  const input = fixture(); const before = structuredClone(input);
  const report = buildAiSingleTeamReport(input, teams, now);
  assert.deepEqual(input, before);
  assert.equal(report.status, 'complete', report.baseline.issues.join('\n'));
  assert.equal(report.baseline.verified, true);
  assert.equal(report.baseline.champion, '1');
  assert.equal(report.baseline.results.length, 7);
  assert.deepEqual(report.baseline.results.find(result => result.matchupId === 'single-final') && [report.baseline.results.at(-1)!.homeWins, report.baseline.results.at(-1)!.awayWins], [9, 0]);
  assert.equal(new Set(report.scenarios.map(item => `${item.mode}:${item.teamId}`)).size, 16);
  assert.ok(report.scenarios.every(item => item.status === 'complete' && item.scoredDates.length === 3));
  assert.deepEqual(buildAiSingleTeamReport(input, [...teams].reverse(), now).scenarios.sort((a, b) => `${a.teamId}:${a.mode}`.localeCompare(`${b.teamId}:${b.mode}`)), [...report.scenarios].sort((a, b) => `${a.teamId}:${a.mode}`.localeCompare(`${b.teamId}:${b.mode}`)));
  for (const item of report.scenarios) {
    assert.equal(item.standings.reduce((sum, row) => sum + row.wins, 0), item.standings.reduce((sum, row) => sum + row.losses, 0));
    for (const result of item.results) for (const [teamId, stats] of [[result.home, result.homeStats], [result.away, result.awayStats]] as const) {
      if (teamId === item.teamId) continue;
      const source = input.days[result.period - 1].owners.find(owner => owner.teamId === teamId)!;
      assert.deepEqual(stats, source.stats, 'Frozen opponents retain exact original daily totals in every experiment');
    }
  }
});

test('same-day and future scores cannot affect drafts or earlier manager decisions', () => {
  const input = fixture(); const changed = structuredClone(input);
  for (const day of changed.days) for (const row of day.stats) row.stats = performance(row.playerId % 7 + 1);
  changed.expectedRegularRecords = undefined; changed.actualChampion = null; reconcile(changed);
  const before = buildAiSingleTeamReport(input, teams, now); const after = buildAiSingleTeamReport(changed, teams, now);
  for (const old of before.scenarios) {
    const fresh = scenario(after, old.teamId, old.mode);
    assert.deepEqual(fresh.initialRoster, old.initialRoster);
    assert.deepEqual(fresh.decisions.filter(item => item.date === input.firstDate), old.decisions.filter(item => item.date === input.firstDate));
    assert.deepEqual(fresh.lineups[0], old.lineups[0]);
  }
  assert.notDeepEqual(after.scenarios[0].results, before.scenarios[0].results);
});

test('lineups are legal, target ownership is exclusive, and changed qualifiers use their frozen postseason lineups', () => {
  const input = fixture(); const report = buildAiSingleTeamReport(input, teams, now);
  for (const item of report.scenarios) {
    let roster = [...item.initialRoster];
    for (const decision of item.decisions.filter(item => item.kind !== 'draft')) {
      if (decision.droppedId !== undefined) roster = roster.filter(id => id !== decision.droppedId);
      if (decision.kind === 'add_drop') roster.push(...decision.playerIds);
      assert.ok(roster.length <= 13);
      assert.equal(new Set(roster).size, roster.length);
      if (decision.kind !== 'lineup') continue;
      const day = input.days.find(day => day.date === decision.date)!;
      const other = new Set(day.owners.filter(owner => owner.teamId !== item.teamId).flatMap(owner => owner.roster));
      assert.ok(roster.every(id => !other.has(id)));
      const lineup = item.lineups.find(lineup => lineup.date === decision.date)!;
      assert.ok(lineup.slots.length <= 10);
      assert.equal(new Set(lineup.slots.map(slot => slot.playerId)).size, lineup.slots.length);
      assert.ok(Date.parse(lineup.decidedAt) < Date.parse(day.startsAt));
      for (const slot of lineup.slots) assert.ok(roster.includes(slot.playerId) && input.players.find(player => player.id === slot.playerId)!.slots.includes(slot.slot));
    }
    assert.deepEqual(roster, item.finalRoster);
  }
  const formerlyLast = scenario(report, '8');
  assert.ok(formerlyLast.results.some(result => result.playoff && (result.home === '8' || result.away === '8')), 'A new qualifier replaces an actual playoff team');
  assert.ok(formerlyLast.standings.find(row => row.teamId === '8')!.wins > report.baseline.standings.find(row => row.teamId === '8')!.wins);
});

test('extra opening IR player produces an explicit cut and redraft preserves traded pick counts without opponent selections', () => {
  const input = fixture();
  input.players.find(player => player.id === 128)!.forecast = zero();
  input.days[0].owners[0].roster.push(128); input.days[0].owners[0].lineup.push({ playerId: 128, slot: 13 });
  input.ownerDraft![13].teamId = '1';
  reconcile(input);
  const report = buildAiSingleTeamReport(input, teams, now);
  assert.equal(report.status, 'complete', report.baseline.issues.join('\n'));
  assert.equal(scenario(report).actualOpeningRoster.length, 14);
  assert.deepEqual(scenario(report).initialCuts, [128]);
  assert.equal(scenario(report).decisions[0].kind, 'initial_drop');
  for (const id of ['1', '2']) {
    const item = scenario(report, id, 'redraft');
    const picks = input.ownerDraft!.filter(pick => pick.teamId === id);
    const reserved = new Set(input.ownerDraft!.filter(pick => pick.teamId !== id).map(pick => pick.playerId));
    assert.equal(item.initialRoster.length, picks.length);
    assert.ok(item.initialRoster.every(playerId => !reserved.has(playerId)));
    assert.deepEqual(item.decisions.filter(decision => decision.kind === 'draft').map(decision => decision.overallPick), picks.map(pick => pick.overallPick));
  }
  assert.equal(scenario(report, '1', 'redraft').initialCuts.length, 1);
  assert.equal(scenario(report, '2', 'redraft').initialRoster.length, 12);
  assert.ok(scenario(report, '2', 'redraft').decisions.some(decision => decision.kind === 'add_drop' && decision.droppedId === undefined));
});

test('fixed opponent claims force returns and replacement pickups obey four per period and one per date', () => {
  const input = fixture(6);
  for (const player of input.players) player.forecast = player.id <= 13 ? performance(8) : zero();
  // Five core players are claimed by an opponent on successive dates, while actual target moves are ignored.
  for (let index = 1; index < input.days.length; index++) {
    const claims = Array.from({ length: Math.min(index, 5) }, (_, i) => i + 1);
    const own = input.days[index].owners[0]; const other = input.days[index].owners[1];
    own.roster = own.roster.filter(id => !claims.includes(id)); own.lineup = own.lineup.filter(slot => !claims.includes(slot.playerId));
    other.roster = [...other.roster.slice(0, 13 - claims.length), ...claims];
    other.lineup = other.roster.map((playerId, i) => ({ playerId, slot: i ? 12 : 0 }));
  }
  input.expectedRegularRecords = undefined; input.actualChampion = null; reconcile(input);
  const item = scenario(buildAiSingleTeamReport(input, teams, now));
  assert.equal(item.forcedReturns, 5);
  assert.equal(item.acquisitionsByPeriod['1'], 4);
  assert.ok(Object.values(item.acquisitionsByPeriod).every(count => count <= 4));
  const moves = item.decisions.filter(decision => decision.kind === 'add_drop');
  assert.equal(new Set(moves.map(decision => decision.date)).size, moves.length);
  assert.ok(item.decisions.filter(decision => decision.kind === 'forced_return').every(decision => decision.claimedByTeamId === '2'));
  const lastRegular = item.decisions.filter(decision => decision.date <= date(6));
  let roster = [...item.initialRoster];
  for (const decision of lastRegular) {
    if (decision.droppedId !== undefined) roster = roster.filter(id => id !== decision.droppedId);
    if (decision.kind === 'add_drop') roster.push(...decision.playerIds);
  }
  assert.ok(roster.length < 13, 'Exhausted acquisition budget leaves an explicit roster vacancy');
});

test('missing dates, incomplete player rows, ownership conflicts and malformed schedules never certify or produce a champion', () => {
  const cases = [
    (input: AiSingleTeamInput) => { input.days.splice(1, 1); },
    (input: AiSingleTeamInput) => { input.days.push(structuredClone(input.days[0])); },
    (input: AiSingleTeamInput) => { input.days[1].stats.pop(); },
    (input: AiSingleTeamInput) => { input.days[1].owners[1].roster.push(input.days[1].owners[0].roster[0]); },
    (input: AiSingleTeamInput) => { input.matchups.splice(0, 1); input.expectedRegularRecords = undefined; },
    (input: AiSingleTeamInput) => { input.forecastAsOf = `${input.firstDate}T01:00:00Z`; },
    (input: AiSingleTeamInput) => { input.days[1].owners.pop(); },
  ];
  for (const change of cases) {
    const input = fixture(); change(input);
    const report = buildAiSingleTeamReport(input, teams, now);
    assert.equal(report.status, 'incomplete'); assert.equal(report.baseline.verified, false); assert.equal(report.baseline.champion, null);
    assert.ok(report.baseline.issues.length > 0);
    assert.ok(report.scenarios.every(item => item.champion === null && item.status === 'incomplete' && item.scoredDates.length < 3));
  }
});

test('official baseline mismatch blocks publication, and missing actual draft blocks only redraft results', () => {
  const input = fixture(); input.officialScores[0].categories['0']++;
  let report = buildAiSingleTeamReport(input, teams, now);
  assert.equal(report.status, 'incomplete'); assert.equal(report.baseline.verified, false);
  assert.match(report.baseline.issues.join(' '), /Official category 0 mismatch/);
  assert.ok(report.scenarios.every(item => !item.champion));
  const missingDraft = fixture(); missingDraft.ownerDraft = null;
  report = buildAiSingleTeamReport(missingDraft, teams, now);
  assert.equal(report.baseline.verified, true); assert.equal(report.status, 'incomplete');
  assert.ok(report.scenarios.filter(item => item.mode === 'post_draft').every(item => item.status === 'complete'));
  assert.ok(report.scenarios.filter(item => item.mode === 'redraft').every(item => item.status === 'incomplete' && item.decisions.length === 0));
});

test('zero-attempt percentages tie and completed empty NBA dates still count toward the full calendar', () => {
  const input = fixture();
  input.days[1].scheduledPlayerIds = [];
  for (const row of input.days[1].stats) row.stats = zero();
  input.actualChampion = null; reconcile(input);
  const report = buildAiSingleTeamReport(input, teams, now);
  assert.equal(report.status, 'complete', report.baseline.issues.join('\n'));
  assert.ok(report.baseline.results.filter(result => result.period === 2).every(result => result.ties === 9 && result.complete));
  assert.ok(report.scenarios.every(item => item.scoredDates.includes(date(2)) && item.lineups.find(lineup => lineup.date === date(2))!.slots.length === 0));
});

test('documented official residual changes only frozen period totals, never controlled scores, forecasts or decisions', () => {
  const input = fixture();
  for (const matchup of input.matchups) matchup.period += 17;
  const actualStarter = input.days[0].owners[7].lineup.find(slot => slot.slot < 12)!.playerId;
  input.days[0].stats.find(row => row.playerId === actualStarter)!.stats.blk = 20;
  input.expectedRegularRecords = undefined; input.actualChampion = null; reconcile(input);
  input.officialScores.find(row => row.period === 18 && row.teamId === '8')!.categories['1'] = 19;
  const unadjusted = buildAiSingleTeamReport(input, teams, now);
  assert.equal(unadjusted.baseline.verified, false);
  input.officialAdjustments = [{ season: 2026, period: 18, teamId: '8', stat: 'blk', reconstructed: 20, official: 19, reason: 'Verified daily NBA records total 20; official frozen fantasy total is 19.' }];
  const before = structuredClone(input);
  const report = buildAiSingleTeamReport(input, teams, now);
  assert.deepEqual(input, before);
  assert.equal(report.status, 'complete', report.baseline.issues.join('\n'));
  assert.equal(report.baseline.results.find(result => result.period === 18 && result.away === '8')!.awayStats.blk, 19);
  assert.deepEqual(report.officialAdjustments, input.officialAdjustments);
  assert.match(report.limitations.join(' '), /source versions/);
  for (const item of report.scenarios) {
    const unchanged = scenario(unadjusted, item.teamId, item.mode);
    assert.deepEqual(item.decisions, unchanged.decisions, 'The residual never feeds the numerical manager');
    assert.deepEqual(item.lineups, unchanged.lineups);
    const result = item.results.find(result => result.period === 18 && result.away === '8')!;
    if (item.teamId === '8') {
      const actual = new Map(input.days[0].stats.map(row => [row.playerId, row.stats]));
      const blocks = item.lineups[0].slots.reduce((sum, slot) => sum + actual.get(slot.playerId)!.blk, 0);
      assert.equal(result.awayStats.blk, blocks, 'Controlled team 8 is scored exclusively from its chosen player rows');
    } else assert.equal(result.awayStats.blk, 19);
  }
  // A source refresh that changes either side of this exact residual must fail closed.
  const changed = structuredClone(input); changed.days[0].stats.find(row => row.playerId === actualStarter)!.stats.blk = 21;
  reconcile(changed); changed.officialScores.find(row => row.period === 18 && row.teamId === '8')!.categories['1'] = 19;
  const rejected = buildAiSingleTeamReport(changed, teams, now);
  assert.equal(rejected.status, 'incomplete'); assert.match(rejected.baseline.issues.join(' '), /exact raw and official values/);
  const unauthorized = structuredClone(input); unauthorized.officialAdjustments![0].teamId = '7';
  assert.equal(buildAiSingleTeamReport(unauthorized, teams, now).baseline.verified, false);
});
