import assert from 'node:assert/strict';
import test from 'node:test';
import { easternDate, nextDate, refreshDates } from '../../src/lib/ai-league-refresh';
import type { AiLeagueRun } from '../../src/lib/ai-league-types';

const lineup = (date: string, teamId = '1') => ({ date, teamId, slots: [], decidedAt: `${date}T12:00:00Z` });
function run(overrides: Partial<AiLeagueRun> = {}): AiLeagueRun {
  return {
    version: 1, season: 2027, label: 'Test', mode: 'live', policy: 'Test', status: 'active', message: '',
    createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z', dataThrough: null,
    calendarEnd: '2026-10-20', draftOrder: [], players: [], teams: [], decisions: [], lineups: [], results: [], standings: [],
    scoredDates: [], missedDates: [], waiverAvailable: {}, acquisitions: {}, champion: null, limitations: [],
    matchups: [{ id: 'regular', period: 1, home: '1', away: '2', start: '2026-10-01', end: '2026-10-10', playoff: false }],
    ...overrides,
  };
}

test('calendar helpers follow Eastern dates and remain stable across DST and month boundaries', () => {
  assert.equal(easternDate(new Date('2026-10-07T02:00:00Z')), '2026-10-06');
  assert.equal(easternDate(new Date('2026-01-07T04:30:00Z')), '2026-01-06');
  assert.equal(nextDate('2026-03-08'), '2026-03-09');
  assert.equal(nextDate('2026-10-31'), '2026-11-01');
  assert.equal(nextDate('2026-01-01', -1), '2025-12-31');
});

test('live batches reserve today before pending scores even when the limit is one', () => {
  const state = run({ lineups: [lineup('2026-10-02'), lineup('2026-10-03'), lineup('2026-10-03', '2')] });
  const before = structuredClone(state);
  assert.deepEqual(refreshDates(state, '2026-10-04', 1), ['2026-10-04']);
  assert.deepEqual(refreshDates(state, '2026-10-04', 2), ['2026-10-02', '2026-10-04']);
  assert.deepEqual(refreshDates(state, '2026-10-04', 3), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(state, before);
});

test('unused live batch space checks absent calendar dates so empty NBA days can recover', () => {
  const state = run({ scoredDates: ['2026-10-01'], lineups: [lineup('2026-10-03')] });
  assert.deepEqual(refreshDates(state, '2026-10-04', 3), ['2026-10-02', '2026-10-03', '2026-10-04']);
});

test('recorded missed locks never occupy the delayed-scoring fetch queue again', () => {
  const state = run({ scoredDates: ['2026-10-01'], missedDates: ['2026-10-02', '2026-10-03'], lineups: [lineup('2026-10-02')] });
  assert.deepEqual(refreshDates(state, '2026-10-05', 3), ['2026-10-04', '2026-10-05']);
});

test('full calendar end protects first playoff morning before preceding scores create its bracket', () => {
  const state = run({ scoredDates: Array.from({ length: 9 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`), lineups: [lineup('2026-10-10')] });
  assert.deepEqual(refreshDates(state, '2026-10-11', 3), ['2026-10-10', '2026-10-11']);
});

test('after the season all slots can settle delayed lineups without requesting a new date', () => {
  const state = run({ lineups: [lineup('2026-10-03'), lineup('2026-10-04'), lineup('2026-10-05')] });
  assert.deepEqual(refreshDates(state, '2026-10-21', 3), ['2026-10-03', '2026-10-04', '2026-10-05']);
});

test('replay batches select at most three unscored dates in chronological order', () => {
  const state = run({ mode: 'replay', scoredDates: ['2026-10-01', '2026-10-03'] });
  assert.deepEqual(refreshDates(state, '2026-11-01', 3), ['2026-10-02', '2026-10-04', '2026-10-05']);
  assert.deepEqual(refreshDates(state, '2026-11-01', 1), ['2026-10-02']);
});

test('replay advances to new playoff dates only after that simulated bracket is seeded', () => {
  const state = run({ mode: 'replay', scoredDates: Array.from({ length: 10 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`) });
  assert.deepEqual(refreshDates(state, '2026-11-01', 3), []);
  state.matchups.push({ id: 'ai-semifinal-1', period: 2, home: '3', away: '4', start: '2026-10-11', end: '2026-10-15', playoff: true });
  assert.deepEqual(refreshDates(state, '2026-11-01', 3), ['2026-10-11', '2026-10-12', '2026-10-13']);
});

test('preseason and completed runs request no dates and invalid budgets are rejected', () => {
  assert.deepEqual(refreshDates(run(), '2026-09-30', 3), []);
  assert.deepEqual(refreshDates(run({ status: 'complete' }), '2026-10-05', 3), []);
  for (const limit of [0, 4, 1.5]) assert.throws(() => refreshDates(run(), '2026-10-05', limit), /one to three/);
});
