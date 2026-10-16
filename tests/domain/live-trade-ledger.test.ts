import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFinalizedTradeLedger, type FinalizedTradeRow } from '../../src/lib/live-trade-ledger';
import type { TradeRecord } from '../../src/lib/types';

const archive: TradeRecord[] = [{ id: '103', parties: ['Old manager', 'Other manager'], status: 'recorded', summary: 'Original terms', notes: 'Preserved notes' }];
const teams = [{ franchiseId: 'arod', teamId: 2, name: 'Bizarre Bazaar' }, { franchiseId: 'jon', teamId: 1, name: 'Lo Fi Hip Hop Beats to Win To' }];
const seasons = [{ id: 'current', draft_year: 2026 }, { id: 'future', draft_year: 2027 }];
const trade: FinalizedTradeRow = {
  id: 'dad5e436-b751-477a-b257-89bff16a82fd', season_id: 'current', status: 'finalized', application_mode: 'live', terms: '', created_at: '2026-10-08T12:42:47Z', finalized_at: '2026-10-09T01:05:21Z',
  trade_participants: [{ franchise_id: 'arod' }, { franchise_id: 'jon' }], trade_player_transfers: [], trade_obligations: [],
  trade_pick_transfers: [
    { pick_id: 'future-third', from_franchise_id: 'arod', to_franchise_id: 'jon', draft_picks: { round: 3, season_id: 'future', original_franchise_id: 'arod' } },
    { pick_id: 'current-third', from_franchise_id: 'jon', to_franchise_id: 'arod', draft_picks: { round: 3, season_id: 'current', original_franchise_id: 'arod' } },
  ],
};

test('public ledger appends finalized transfers while preserving year, direction, and original owner', () => {
  const rows = mergeFinalizedTradeLedger(archive, [trade], teams, seasons);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], archive[0]);
  assert.equal(rows[1].status, 'finalized');
  assert.equal(rows[1].source, 'live');
  assert.deepEqual(rows[1].participantTeamIds, [2, 1]);
  assert.deepEqual(rows[1].transferLines, [
    'Bizarre Bazaar → Lo Fi Hip Hop Beats to Win To: 2027 round 3 (originally Bizarre Bazaar)',
    'Lo Fi Hip Hop Beats to Win To → Bizarre Bazaar: 2026 round 3 (originally Bizarre Bazaar)',
  ]);
  assert.equal(rows[1].notes, '');
  assert.match(rows[1].summary, /2027 round 3/);
});

test('private proposals, withdrawals, and imported record-only trades never enter the public live overlay', () => {
  const rows = mergeFinalizedTradeLedger(archive, [
    { ...trade, status: 'proposed', terms: 'Private proposed terms' },
    { ...trade, status: 'cancelled' }, { ...trade, application_mode: 'record_only' },
  ], teams, seasons);
  assert.deepEqual(rows, archive);
});

test('duplicate live IDs count once and newest completed records appear last for newest-first views', () => {
  const newer = { ...trade, id: 'newer', created_at: '2026-10-15T21:34:37Z', finalized_at: '2026-10-16T03:07:26Z' };
  const rows = mergeFinalizedTradeLedger(archive, [newer, trade, trade], teams, seasons);
  assert.deepEqual(rows.map(row => row.id), ['103', trade.id, 'newer']);
  assert.deepEqual(mergeFinalizedTradeLedger(rows, [trade, newer], teams, seasons), rows);
});

test('missing public transfer context fails explicitly instead of showing incomplete pick labels', () => {
  assert.throws(() => mergeFinalizedTradeLedger(archive, [trade], teams, seasons.slice(0, 1)), /unknown draft season/);
  assert.throws(() => mergeFinalizedTradeLedger(archive, [{ ...trade, trade_pick_transfers: [{ ...trade.trade_pick_transfers[0], draft_picks: null }] }], teams, seasons), /missing its original pick/);
});

test('player and obligation transfers remain visible even after players leave the current roster', () => {
  const rows = mergeFinalizedTradeLedger(archive, [{ ...trade, terms: 'Agreed conditions', trade_pick_transfers: [],
    trade_player_transfers: [{ player_id: 123, from_franchise_id: 'arod', to_franchise_id: 'jon', players: { full_name: 'Former Player' } }],
    trade_obligations: [{ from_franchise_id: 'jon', to_franchise_id: 'arod', kind: 'loan_return', terms: 'Return next season', status: 'open' }],
  }], teams, seasons);
  assert.deepEqual(rows[1].transferLines, ['Bizarre Bazaar → Lo Fi Hip Hop Beats to Win To: Former Player', 'Lo Fi Hip Hop Beats to Win To → Bizarre Bazaar: Return next season (open)']);
  assert.equal(rows[1].notes, 'Agreed conditions');
});
