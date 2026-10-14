import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftAdvisorTeam } from '../../src/lib/draft-advisor';
import type { DraftProjectionStats } from '../../src/lib/draft-projections';
import { buildDraftTeamValues, type DraftTeamValue } from '../../src/lib/draft-team-values';

const stats = (overrides: Partial<DraftProjectionStats> = {}): DraftProjectionStats => ({
  pts: 100, three: 10, reb: 40, ast: 20, stl: 5, blk: 4, tov: 10, fgm: 40, fga: 80, ftm: 16, fta: 20, ...overrides,
});
function team(franchiseId: string, overrides: Partial<DraftProjectionStats> = {}): DraftAdvisorTeam {
  return {
    franchiseId, displayName: franchiseId,
    roster: {
      franchiseId, displayName: franchiseId, totalPlayers: 1, keptPlayers: 0, draftedPlayers: 1,
      normalCapacity: 13, reserveCapacity: 2, remainingCapacity: 12, overflow: 0,
      players: [], slots: [], reserveSlots: [], slotCounts: [], eligiblePositionCounts: [], unplaced: [], issues: [],
    },
    coverage: { projected: 1, total: 1, missing: [] }, totals: stats(overrides), categories: [], scheduleTotals: stats(overrides), scheduleCategories: [], categoryWinRate: null, scheduleWinRate: null,
  };
}
const category = (team: DraftTeamValue, id: number) => team.categories.find(value => value.id === id)!.zValue;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${actual} to be near ${expected}`);

test('uses canonical category labels and weekly totals, with higher value for fewer turnovers', () => {
  const input = [team('a', { pts: 90, tov: 2 }), team('b', { pts: 110, tov: 12 })];
  const before = structuredClone(input), result = buildDraftTeamValues(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.teams.map(row => row.franchiseId), ['a', 'b']);
  assert.deepEqual(result.teams[0].categories.map(({ id, label, valueLabel }) => [id, label, valueLabel]), [
    [0, 'PTS', 'pV'], [17, '3PM', '3V'], [6, 'REB', 'rV'], [3, 'AST', 'aV'], [2, 'STL', 'sV'],
    [1, 'BLK', 'bV'], [19, 'FG%', 'fg%V'], [20, 'FT%', 'ft%V'], [11, 'TO', 'toV'],
  ]);
  assert.equal(category(result.teams[0], 0), -1);
  assert.equal(category(result.teams[0], 11), 1);
  assert.equal(category(result.teams[1], 11), -1);
  assert.equal(result.teams[0].value, 0);
  assert.ok(result.methodology.some(line => line.includes('not a win probability')));
  assert.ok(result.methodology.some(line => line.includes('partial rosters')));
});

test('shooting impact rewards more attempts at the same above-average percentage', () => {
  const input = [
    team('high-volume', { fgm: 60, fga: 100, ftm: 80, fta: 100 }),
    team('low-volume', { fgm: 6, fga: 10, ftm: 8, fta: 10 }),
    team('below-average', { fgm: 40, fga: 100, ftm: 60, fta: 100 }),
  ];
  const { teams } = buildDraftTeamValues(input);
  for (const id of [19, 20]) {
    assert.ok(category(teams[0], id)! > category(teams[1], id)!);
    assert.ok(category(teams[1], id)! > 0);
    assert.ok(category(teams[2], id)! < 0);
    near(teams.reduce((sum, row) => sum + category(row, id)!, 0), 0);
  }
  const pooled = 106 / 210;
  const impacts = [60 - pooled * 100, 6 - pooled * 10, 40 - pooled * 100];
  const sd = Math.sqrt(impacts.reduce((sum, impact) => sum + impact ** 2, 0) / 3);
  near(category(teams[0], 19)!, impacts[0] / sd);
});

test('all-category ties return zero, including equal percentages at different volumes', () => {
  const { teams } = buildDraftTeamValues([
    team('a', { fgm: 21, fga: 30, ftm: 27, fta: 30 }),
    team('b', { fgm: 0.7, fga: 1, ftm: 0.9, fta: 1 }),
    team('c', { fgm: 49, fga: 70, ftm: 63, fta: 70 }),
  ]);
  for (const row of teams) {
    assert.ok(row.categories.every(value => value.zValue === 0));
    assert.equal(row.value, 0);
  }
});

test('category population z-scores have mean zero and overall value sums all nine', () => {
  const { teams } = buildDraftTeamValues([
    team('a', { pts: 50, three: 3, reb: 55, ast: 12, stl: 4, blk: 6, tov: 12, fgm: 22, fga: 50, ftm: 20, fta: 30 }),
    team('b', { pts: 90, three: 10, reb: 40, ast: 20, stl: 5, blk: 7, tov: 16, fgm: 40, fga: 80, ftm: 9, fta: 10 }),
    team('c', { pts: 150, three: 15, reb: 22, ast: 30, stl: 7, blk: 2, tov: 6, fgm: 62, fga: 130, ftm: 16, fta: 20 }),
  ]);
  for (const { id } of teams[0].categories) {
    const values = teams.map(row => category(row, id)!);
    near(values.reduce((sum, value) => sum + value, 0) / values.length, 0);
    near(values.reduce((sum, value) => sum + value ** 2, 0) / values.length, 1);
  }
  for (const row of teams) near(row.value!, row.categories.reduce((sum, value) => sum + value.zValue!, 0));
  near(teams.reduce((sum, row) => sum + row.value!, 0), 0);
});

test('values are invariant to input order and a common positive scaling of weekly totals', () => {
  const input = [team('a', { pts: 60, tov: 3, fgm: 30, fga: 70 }), team('b', { pts: 120, tov: 10 }), team('c', { pts: 150, tov: 20, ftm: 18 })];
  const original = buildDraftTeamValues(input), scaled = structuredClone(input).reverse();
  for (const row of scaled) {
    for (const key of Object.keys(row.totals!) as (keyof DraftProjectionStats)[]) row.totals![key] *= 4.2;
  }
  const result = buildDraftTeamValues(scaled);
  for (const row of original.teams) {
    const comparison = result.teams.find(candidate => candidate.franchiseId === row.franchiseId)!;
    near(row.value!, comparison.value!);
    for (const value of row.categories) near(value.zValue!, category(comparison, value.id)!);
  }
});

test('missing, incomplete, empty and invalid totals are excluded from comparisons', () => {
  const missing = team('missing', { pts: 999 }); missing.totals = null;
  const incomplete = team('incomplete', { pts: 999 }); incomplete.coverage = { projected: 1, total: 2, missing: [{ id: 2, name: 'Missing' }] };
  const conflictingCoverage = team('coverage'); conflictingCoverage.coverage.missing = [{ id: 2, name: 'Missing' }];
  const empty = team('empty'); empty.coverage = { projected: 0, total: 0, missing: [] };
  const invalid = team('invalid', { fgm: 81 });
  const nonfinite = team('nonfinite', { pts: NaN });
  const input = [team('a', { pts: 80 }), team('b', { pts: 120 }), missing, incomplete, conflictingCoverage, empty, invalid, nonfinite];
  const { teams } = buildDraftTeamValues(input);
  assert.equal(category(teams[0], 0), -1);
  assert.equal(category(teams[1], 0), 1);
  assert.ok(teams.slice(2).every(row => row.value === null && row.categories.every(value => value.zValue === null)));
});

test('fewer than two comparable teams keeps category and aggregate values unavailable', () => {
  const missing = team('missing'); missing.totals = null;
  for (const input of [[team('a')], [team('a'), missing]]) {
    const { teams } = buildDraftTeamValues(input);
    assert.ok(teams.every(row => row.value === null && row.categories.every(value => value.zValue === null)));
  }
  assert.deepEqual(buildDraftTeamValues([]).teams, []);
});

test('zero shot attempts suppress only the affected percentage and aggregate values', () => {
  const input = [team('no-fg', { fgm: 0, fga: 0, three: 0 }), team('b'), team('c', { fgm: 50, fga: 80 })];
  const { teams } = buildDraftTeamValues(input);
  assert.equal(category(teams[0], 19), null);
  assert.equal(teams[0].value, null);
  assert.equal(category(teams[0], 20), 0);
  assert.ok(category(teams[0], 17)! < 0);
  assert.equal(category(teams[1], 19), -1);
  assert.equal(category(teams[2], 19), 1);
  assert.notEqual(teams[1].value, null);
  input[2].totals!.fgm = 0; input[2].totals!.fga = 0;
  assert.ok(buildDraftTeamValues(input).teams.every(row => category(row, 19) === null && row.value === null));
});
