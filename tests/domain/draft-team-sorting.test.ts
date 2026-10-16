import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftAdvisorCategory } from '../../src/lib/draft-advisor';
import type { DraftTeamValue } from '../../src/lib/draft-team-values';
import { defaultDraftTeamSortDirection, sortDraftTeamProjections, sortDraftTeamValues } from '../../src/lib/draft-team-sorting';

const categoryIds = [0, 17, 6, 3, 2, 1, 19, 20, 11];
const categories = (win: number | null, production: number | null): DraftAdvisorCategory[] => categoryIds.map(id => ({
  id, label: `Category ${id}`, lowerIsBetter: id === 11, winProbability: win, projectedValue: production, opponentsCompared: 3,
}));
const team = (franchiseId: string, displayName: string, overall: number | null, win: number | null, production: number | null) => ({
  franchiseId, displayName, categoryWinRate: overall, categories: categories(win, production),
});
const ids = (rows: { franchiseId: string }[]) => rows.map(row => row.franchiseId);

test('projection sorts use exact numbers for overall and every category metric, retaining missing values last in both directions', () => {
  const teams = [team('missing', 'Missing', null, null, null), team('b', 'Beta', .5002, .2, 120), team('a', 'Alpha', .5001, .8, 40)];
  const before = structuredClone(teams);
  assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: 'overall', direction: 'descending' })), ['b', 'a', 'missing']);
  assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: 'overall', direction: 'ascending' })), ['a', 'b', 'missing']);
  for (const id of categoryIds) {
    assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: `win:${id}`, direction: 'descending' })), ['a', 'b', 'missing']);
    assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: `win:${id}`, direction: 'ascending' })), ['b', 'a', 'missing']);
    assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: `production:${id}`, direction: 'descending' })), ['b', 'a', 'missing']);
    assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: `production:${id}`, direction: 'ascending' })), ['a', 'b', 'missing']);
  }
  assert.deepEqual(teams, before);
});

test('team-name sorting reverses alphabetically while numerical ties use deterministic name then franchise order', () => {
  const teams = [team('z', 'Beta', .5, .5, 100), team('b', 'Alpha', .5, .5, 100), team('a', 'Alpha', .5, .5, 100)];
  assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: 'team', direction: 'ascending' })), ['a', 'b', 'z']);
  assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: 'team', direction: 'descending' })), ['z', 'a', 'b']);
  for (const direction of ['ascending', 'descending'] as const) {
    assert.deepEqual(ids(sortDraftTeamProjections(teams, { column: 'overall', direction })), ['a', 'b', 'z']);
  }
});

test('missing categories and nonfinite estimates cannot sort ahead of a valid zero', () => {
  const teams = [team('absent', 'Absent', NaN, NaN, Infinity), team('zero', 'Zero', 0, 0, 0), team('omitted', 'Omitted', null, null, null)];
  teams[2].categories = [];
  for (const direction of ['ascending', 'descending'] as const) {
    for (const column of ['overall', 'win:0', 'production:0'] as const) {
      assert.deepEqual(ids(sortDraftTeamProjections(teams, { column, direction })), ['zero', 'absent', 'omitted']);
    }
  }
});

test('all z-score columns sort signed values numerically, with missing values last and original data intact', () => {
  const row = (franchiseId: string, value: number | null): DraftTeamValue => ({ franchiseId, value,
    categories: categoryIds.map(id => ({ id, label: `Category ${id}`, valueLabel: `v${id}`, zValue: value })),
  });
  const rows = [row('missing', null), row('negative', -1.2), row('positive', 1.1), row('zero', 0)];
  const names = new Map([['missing', 'Missing'], ['negative', 'Alpha'], ['positive', 'Zulu'], ['zero', 'Beta']]);
  const before = structuredClone(rows);
  for (const column of ['value' as const, ...categoryIds.map(id => `category:${id}` as const)]) {
    assert.deepEqual(ids(sortDraftTeamValues(rows, names, { column, direction: 'descending' })), ['positive', 'zero', 'negative', 'missing']);
    assert.deepEqual(ids(sortDraftTeamValues(rows, names, { column, direction: 'ascending' })), ['negative', 'zero', 'positive', 'missing']);
  }
  assert.deepEqual(ids(sortDraftTeamValues(rows, names, { column: 'team', direction: 'ascending' })), ['negative', 'zero', 'missing', 'positive']);
  assert.deepEqual(ids(sortDraftTeamValues(rows, names, { column: 'team', direction: 'descending' })), ['positive', 'missing', 'zero', 'negative']);
  assert.deepEqual(rows, before);
});

test('default directions distinguish raw turnovers from favorable turnover win rates and z-scores', () => {
  assert.equal(defaultDraftTeamSortDirection('team'), 'ascending');
  assert.equal(defaultDraftTeamSortDirection('overall'), 'descending');
  assert.equal(defaultDraftTeamSortDirection('value'), 'descending');
  for (const id of categoryIds) {
    assert.equal(defaultDraftTeamSortDirection(`production:${id}`), id === 11 ? 'ascending' : 'descending');
    assert.equal(defaultDraftTeamSortDirection(`win:${id}`), 'descending');
    assert.equal(defaultDraftTeamSortDirection(`category:${id}`), 'descending');
  }
});
