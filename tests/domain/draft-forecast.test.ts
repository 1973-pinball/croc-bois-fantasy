import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDraftForecast, summarizeDraftCandidateScenarios, type DraftForecastInput } from '../../src/lib/draft-forecast';
import { prepareDraftCompletion, completeDraftScenario } from '../../src/lib/draft-completion';
import { createDraftRosterEvaluator } from '../../src/lib/draft-advisor';
import type { DraftBoardPick } from '../../src/lib/draft-board';
import type { DraftProjectionStats } from '../../src/lib/draft-projections';

const a = '71000000-0000-4000-8000-000000000001', b = '71000000-0000-4000-8000-000000000002';
const source = { sha256: 'a'.repeat(64), url: 'https://example.com/forecast-fixture', capturedAt: '2026-10-16T00:00:00Z' };
const stats = (): DraftProjectionStats => ({ pts: 15, reb: 5, ast: 3, stl: 1, blk: 1, tov: 2, three: 1, fgm: 5, fga: 10, ftm: 3, fta: 4 });
function fixture(capacity = 3): DraftForecastInput {
  const count = capacity * 2 + 12;
  const picks: DraftBoardPick[] = Array.from({ length: capacity * 2 }, (_, index) => {
    const round = Math.floor(index / 2) + 1;
    const owner = (round % 2 === 1 ? index % 2 === 0 : index % 2 !== 0) ? a : b;
    return { id: `pick-${index + 1}`, round, overallPick: index + 1, originalFranchiseId: owner, currentOwnerId: owner,
      status: index < 2 ? 'keeper' : 'available', playerId: index < 2 ? index + 1 : null, playerName: index < 2 ? `Player ${index + 1}` : null, selectionId: null };
  });
  return {
    franchiseId: a, scenarios: 3,
    board: { seasonId: '72000000-0000-4000-8000-000000000001', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: capacity, revision: 1,
      clock: { status: 'waiting', durationSeconds: 90, remainingSeconds: null, deadlineAt: null, startedAt: null, serverNow: source.capturedAt },
      keepersRevealedAt: source.capturedAt, orderComplete: true, orderLocked: true, nextPickId: 'pick-3',
      teams: [{ franchiseId: a, espnTeamId: 1, displayName: 'A', draftPosition: 1 }, { franchiseId: b, espnTeamId: 2, displayName: 'B', draftPosition: 2 }], picks },
    settings: { version: 1, leagueId: 139935, espnSeasonId: 2027, source, slotDefinitionsSource: source, positionLimitsSource: source,
      slots: [{ slotId: 11, label: 'UTIL', count: capacity - 1, kind: 'normal' }, { slotId: 12, label: 'BE', count: 1, kind: 'normal' }, { slotId: 13, label: 'IR', count: 2, kind: 'reserve' }],
      slotDefinitions: [11, 12, 13].map(slotId => ({ slotId, label: slotId === 11 ? 'UTIL' : slotId === 12 ? 'BE' : 'IR', name: 'Slot', bench: slotId === 12, reserve: slotId === 13, lineupSlotEligible: true })),
      normalCapacity: capacity, reserveCapacity: 2, lineupSlotCounts: { 11: capacity - 1, 12: 1, 13: 2 }, positionLimits: { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1 }, isBenchUnlimited: true,
      primaryPositionLimits: [1, 2, 3, 4, 5].map(positionId => ({ positionId, label: 'Position', maximum: null })), limitations: [] },
    eligibility: { version: 1, leagueId: 139935, espnSeasonId: 2027, source, players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, eligibleSlots: [0, 11, 12, 13], primaryPositionId: 1, injuryStatus: 'ACTIVE', active: true, poolStatus: 'FREEAGENT' })) },
    catalog: { version: 1, leagueId: 139935, espnSeasonId: 2027, fetchedAt: source.capturedAt, source,
      rankingSource: { field: 'ROTO', label: 'ESPN category rankings', rankType: 'ROTO', customLeagueWeighting: false, limitations: [] },
      categories: [{ id: 0, label: 'PTS' }, { id: 6, label: 'REB' }, { id: 3, label: 'AST' }, { id: 2, label: 'STL' }, { id: 1, label: 'BLK' }, { id: 17, label: '3PM' }, { id: 11, label: 'TO' }, { id: 19, label: 'FG%' }, { id: 20, label: 'FT%' }].map(category => ({ ...category, lowerIsBetter: category.id === 11 })),
      coverage: { players: count, ranked: count, unranked: 0, selectable: count, unsigned: 0 },
      players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, nbaTeam: index % 2 ? 'BOS' : 'ATL', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: index + 1, rankSource: 'ROTO', active: true, selectable: true })) },
    projections: { source: 'espn', sourceLabel: 'ESPN fixture', seasonId: 2027, importedAt: source.capturedAt, warnings: [], players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, games: 82, stats: stats() })) },
    schedule: { scope: 'season', seasonId: 2027, startDate: '2026-10-20', endDate: '2027-04-11', fetchedAt: source.capturedAt, sourceLabel: 'Full-season fixture', warnings: [], games: ['2026-10-20', '2026-10-27'].flatMap(date => (['ATL', 'BOS'] as const).map(team => ({ date, team }))) },
  };
}

test('traded 12/14 pick inventories complete to 13 each without giving identical players phantom category wins', () => {
  const input = fixture(13);
  input.board.picks[24].currentOwnerId = b;
  const before = structuredClone(input);
  const context = prepareDraftCompletion({ ...input, espnRanks: undefined, scheduledTeams: new Set(['ATL', 'BOS']), scenarioCount: 3 });
  assert.equal(context.available, true, context.unavailableReason ?? '');
  for (let scenario = 0; scenario < 3; scenario++) {
    const completed = completeDraftScenario(context, scenario);
    assert.equal(completed.valid, true, completed.reason ?? '');
    assert.deepEqual([...completed.teams.values()].map(players => players.length), [13, 13]);
    assert.equal(new Set([...completed.teams.values()].flat()).size, 26);
    assert.ok(completed.teams.get(a)!.includes(1)); assert.ok(completed.teams.get(b)!.includes(2));
    assert.equal(completed.additions.filter(row => row.franchiseId === a).length, 1);
    assert.equal(completed.cuts.filter(row => row.franchiseId === b).length, 1);
    assert.ok(completed.cuts.every(row => !row.wasFixed));
  }
  const report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  assert.equal(report.forecast.rosterSize, 13);
  assert.deepEqual(report.forecast.completionAdjustments, [{ franchiseId: a, added: 1, cut: 0 }, { franchiseId: b, added: 0, cut: 1 }]);
  for (const team of report.teams) assert.ok(Math.abs(team.scheduleWinRate! - 0.5) < 1e-12);
  assert.ok(report.candidates.filter(row => !row.blocked).every(row => Math.abs(row.scheduleGain!) < 1e-12));
  assert.deepEqual(input, before);
});

test('the forecast uses the next owned pick and does not restore players selected by intervening teams', () => {
  const input = fixture(); input.scenarios = 1;
  const report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  assert.equal(report.forecast.targetPick!.id, 'pick-4');
  const taken = report.candidates.find(row => row.player.id === 3)!;
  assert.equal(taken.blocked, true); assert.equal(taken.scheduleWinRate, null);
  assert.equal(report.forecast.candidateRanges.find(row => row.playerId === 3)!.availableScenarios, 0);
  const present = report.forecast.candidateRanges.find(row => row.playerId === 4)!;
  assert.equal(present.availableScenarios, 1); assert.equal(present.conditionalGain, 0);
});

test('an already completed 12/14-player draft is normalized hypothetically without editing recorded selections', () => {
  const input = fixture(13); input.scenarios = 1; input.board.nextPickId = null;
  input.board.picks.forEach((pick, index) => {
    pick.status = index < 2 ? 'keeper' : 'selected'; pick.playerId = index + 1; pick.playerName = `Player ${index + 1}`;
  });
  input.board.picks[24].currentOwnerId = b;
  const before = structuredClone(input);
  const context = prepareDraftCompletion({ ...input, espnRanks: undefined, scheduledTeams: new Set(['ATL', 'BOS']), scenarioCount: 1 });
  assert.equal(context.available, true, context.unavailableReason ?? '');
  const completed = completeDraftScenario(context, 0);
  assert.equal(completed.valid, true, completed.reason ?? '');
  assert.deepEqual([...completed.teams.values()].map(players => players.length), [13, 13]);
  assert.deepEqual(completed.cuts.map(row => [row.franchiseId, row.playerId, row.wasFixed]), [[b, 26, true]]);
  assert.equal(completed.additions[0].franchiseId, a);
  const report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  assert.equal(report.forecast.targetPick, null); assert.equal(report.scheduleRecommendation, null);
  assert.ok(Math.abs(report.selectedTeam!.scheduleWinRate! - 0.5) < 1e-12);
  assert.deepEqual(input, before);
  assert.ok(input.board.picks.some(pick => pick.playerId === 26));
});

test('fallback plans and conditional gains compare exactly the same scenarios', () => {
  const summary = summarizeDraftCandidateScenarios([0.2, 0.8], [0.3, null]);
  assert.ok(Math.abs(summary.winRate - 0.55) < 1e-12);
  assert.ok(Math.abs(summary.gain - 0.05) < 1e-12);
  assert.ok(Math.abs(summary.conditionalGain! - 0.1) < 1e-12);
  assert.equal(summary.conditionalWinRate, 0.3); assert.equal(summary.availableScenarios, 1);
  const absent = summarizeDraftCandidateScenarios([0.2, 0.8], [null, null]);
  assert.equal(absent.winRate, 0.5); assert.equal(absent.gain, 0); assert.equal(absent.conditionalWinRate, null); assert.equal(absent.conditionalGain, null);
  assert.throws(() => summarizeDraftCandidateScenarios([0.5], [0.4, null]), /match/);
  assert.throws(() => summarizeDraftCandidateScenarios([0.5], [Number.NaN]));
  assert.throws(() => summarizeDraftCandidateScenarios([0.5], [Number.POSITIVE_INFINITY]));
});

test('fixed-player coverage failures clear every partial-roster rate and recommendation', () => {
  const input = fixture(); input.projections!.players = input.projections!.players.filter(player => player.id !== 2);
  const report = buildDraftForecast(input);
  assert.equal(report.available, false); assert.equal(report.forecast.status, 'unavailable');
  assert.match(report.unavailableReason!, /complete projection/);
  assert.equal(report.categoryRecommendation, null); assert.equal(report.scheduleRecommendation, null); assert.equal(report.fitRecommendation, null);
  assert.equal(report.scheduleMatchups.length, 0);
  for (const team of report.teams) {
    assert.equal(team.scheduleWinRate, null); assert.equal(team.categoryWinRate, null);
    assert.equal(team.scheduleTotals, null); assert.equal(team.totals, null);
    assert.ok(team.scheduleCategories.every(category => category.winProbability === null));
  }
  assert.ok(report.candidates.every(candidate => candidate.scheduleWinRate === null));
});

test('a team with no remaining owned pick still gets a complete forecast but no pick recommendation', () => {
  const input = fixture();
  input.board.picks.filter(pick => pick.status === 'available').forEach(pick => { pick.currentOwnerId = b; });
  const report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  assert.equal(report.forecast.targetPick, null); assert.equal(report.evaluatedCandidates, 0);
  assert.equal(report.categoryRecommendation, null); assert.equal(report.scheduleRecommendation, null); assert.equal(report.fitRecommendation, null);
  assert.ok(Math.abs(report.selectedTeam!.scheduleWinRate! - 0.5) < 1e-12);
  assert.deepEqual(report.forecast.completionAdjustments, [{ franchiseId: a, added: 2, cut: 0 }, { franchiseId: b, added: 0, cut: 2 }]);
});

test('scenario evaluation is deterministic, candidate-order independent, and averages per-scenario probabilities', () => {
  const input = fixture(); input.scenarios = 4;
  input.projections!.players.forEach(player => { player.stats.pts += player.id; player.stats.reb += player.id / 5; });
  const before = structuredClone(input), report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  const reordered = structuredClone(input); reordered.catalog.players.reverse(); reordered.projections!.players.reverse(); reordered.eligibility.players.reverse();
  const repeated = buildDraftForecast(reordered);
  assert.deepEqual(report.forecast.candidateRanges.slice().sort((x, y) => x.playerId - y.playerId), repeated.forecast.candidateRanges.slice().sort((x, y) => x.playerId - y.playerId));
  const evaluator = createDraftRosterEvaluator(input)!;
  const context = prepareDraftCompletion({ ...input, espnRanks: undefined, scheduledTeams: evaluator.scheduledTeams, scenarioCount: input.scenarios });
  const probabilities = Array.from({ length: input.scenarios! }, (_, scenario) => {
    const completed = completeDraftScenario(context, scenario);
    return evaluator.compare(evaluator.evaluate(completed.teams.get(a)!), [evaluator.evaluate(completed.teams.get(b)!)]).winRate!;
  });
  assert.ok(Math.abs(report.selectedTeam!.scheduleWinRate! - probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length) < 1e-12);
  assert.ok(Math.abs(report.teams.reduce((sum, team) => sum + team.scheduleWinRate!, 0) / 2 - 0.5) < 1e-12);
  assert.deepEqual(input, before);
});

test('opposing weekly schedule swings are averaged as probabilities rather than pooled season totals', () => {
  const input = fixture(); input.scenarios = 1;
  input.settings.slots = [{ slotId: 11, label: 'UTIL', count: 3, kind: 'normal' }];
  input.settings.normalCapacity = 3; input.settings.reserveCapacity = 0; input.settings.lineupSlotCounts = { 11: 3 };
  input.catalog.players.forEach(player => { player.nbaTeam = player.id === 2 ? 'BOS' : 'ATL'; });
  input.schedule!.games = [
    ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-27'].map(date => ({ date, team: 'ATL' as const })),
    ...['2026-10-20', '2026-10-27', '2026-10-28', '2026-10-29'].map(date => ({ date, team: 'BOS' as const })),
  ];
  const report = buildDraftForecast(input);
  assert.equal(report.available, true, report.unavailableReason ?? '');
  const own = report.teams.find(team => team.franchiseId === a)!, opponent = report.teams.find(team => team.franchiseId === b)!;
  assert.equal(own.scheduleTotals!.pts, opponent.scheduleTotals!.pts);
  assert.ok(own.scheduleCategories.find(category => category.id === 0)!.winProbability! < 0.49);
  assert.ok(opponent.scheduleCategories.find(category => category.id === 0)!.winProbability! > 0.51);
});
