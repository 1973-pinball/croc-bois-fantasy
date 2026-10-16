import assert from 'node:assert/strict';
import test from 'node:test';
import analytics from '../../data/analytics.json';
import { aggregateLeagueTrades } from '../../src/lib/league-trade-analytics';
import type { TradeRecord } from '../../src/lib/types';

const finalized = (id: string, participantTeamIds: number[]): TradeRecord => ({
  id, participantTeamIds, source: 'live', status: 'finalized', parties: [], summary: '', notes: '',
});

test('new finalized trades update each involved franchise once and recompute the correlation', () => {
  const trades = [finalized('47cc6d5e', [7, 5, 7, 5]), finalized('dad5e436', [1, 2])];
  const result = aggregateLeagueTrades(analytics.winsTrades.observations, trades);
  assert.equal(result.finalizedTradeCount, 2);
  const byTeam = new Map(result.observations.map(item => [item.franchiseId, item]));
  assert.equal(byTeam.get('2')?.trades, 41);
  assert.equal(byTeam.get('1')?.trades, 36);
  assert.equal(byTeam.get('7')?.trades, 30);
  assert.equal(byTeam.get('5')?.trades, 23);
  assert.equal(byTeam.get('3')?.trades, 28);
  assert.equal(byTeam.get('2')?.archivedTrades, 40);
  assert.equal(byTeam.get('2')?.liveTrades, 1);
  assert.equal(byTeam.get('2')?.wins, 647);
  assert.equal(analytics.winsTrades.observations.find(item => item.franchiseId === '2')?.trades, 40);
  assert.ok(result.pearson !== null && Math.abs(result.pearson - 0.5018785920131459) < 1e-12);
});

test('duplicate live records, archive imports, and unfinished or voided records do not inflate totals', () => {
  const live = finalized('live-1', [1, 2]);
  const result = aggregateLeagueTrades(analytics.winsTrades.observations, [
    live, live,
    { id: '92', status: 'recorded', parties: ['Shane', 'Jon'], summary: '', notes: '' },
    { ...finalized('unattributed-import', [1, 2]), source: undefined },
    { ...finalized('review', [1, 2]), status: 'review' },
    { ...finalized('void', [1, 2]), status: 'voided' },
  ]);
  assert.equal(result.finalizedTradeCount, 1);
  assert.equal(result.observations.find(item => item.franchiseId === '1')?.liveTrades, 1);
  assert.equal(result.observations.find(item => item.franchiseId === '5')?.liveTrades, 0);
});

test('the archive-only view preserves its baseline and undefined correlations stay unknown', () => {
  const result = aggregateLeagueTrades(analytics.winsTrades.observations, []);
  assert.equal(result.finalizedTradeCount, 0);
  assert.equal(result.pearson, analytics.winsTrades.pearson);
  assert.equal(aggregateLeagueTrades([], []).pearson, null);
  assert.equal(aggregateLeagueTrades([{ franchiseId: '1', trades: 0, wins: 5 }], []).pearson, null);
  assert.equal(aggregateLeagueTrades([{ franchiseId: '1', trades: 0, wins: 5 }, { franchiseId: '2', trades: 0, wins: 7 }], []).pearson, null);
});
