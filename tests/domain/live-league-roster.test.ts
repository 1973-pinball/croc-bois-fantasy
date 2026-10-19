import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLiveLeaguePlayers, mergeFinalizedDraftArchive, type FinalizedDraftSelection } from '../../src/lib/live-league-roster';
import type { HistoricalDraft, LeaguePlayer } from '../../src/lib/types';

const prior: LeaguePlayer = { id: 1, name: 'Retained player', teamId: 1, baseCost: 8, tenure: 2, status: 'eligible', reason: '2026 eligibility', wasKept: false, previousRound: 9, rosterSlot: 'IR' };
const retained: FinalizedDraftSelection = { player_id: 1, franchise_id: 'a', round: 5, overall_pick: 1, was_keeper: true,
  source_metadata: { original_franchise_id: 'a', roster_franchise_id: 'b' }, players: { full_name: 'Retained player' } };
const drafted: FinalizedDraftSelection = { player_id: 2, franchise_id: 'a', round: 1, overall_pick: 2, was_keeper: false,
  source_metadata: { original_franchise_id: 'b', roster_franchise_id: 'a' }, players: { full_name: 'New draft player' } };
const teams = new Map([['a', 1], ['b', 2]]);
const names = new Map([[1, 'Retained player'], [2, 'New draft player']]);
const finalized = {
  ownership: [{ player_id: 1, franchise_id: 'b' }, { player_id: 2, franchise_id: 'a' }],
  profiles: [
    { player_id: 1, base_round: 7, tenure_years: 3, verification: 'confirmed', explanation: '2027 cost follows nominal keeper round 8, not payment round 5.' },
    { player_id: 2, base_round: null, tenure_years: 1, verification: 'ineligible', explanation: 'Fresh round-one draft in 2026.' },
  ],
  names, roster: [
    { player_id: 1, lineup_slot: 13, snapshot_id: 'keeper-pool' },
    { player_id: 1, lineup_slot: -1, snapshot_id: 'draft-roster' }, { player_id: 2, lineup_slot: -1, snapshot_id: 'draft-roster' },
  ], snapshotId: 'draft-roster', teamIds: teams, previewPlayers: [prior], finalizedDraft: [retained, drafted],
};

test('finalized rosters use next-year keeper profiles and current owners, including newly drafted players absent from the old pool', () => {
  const players = buildLiveLeaguePlayers(finalized);
  assert.equal(players.length, 2);
  assert.deepEqual(players.map(player => [player.id, player.teamId, player.baseCost, player.tenure, player.status, player.wasKept, player.previousRound, player.rosterSlot]), [
    [1, 2, 7, 3, 'eligible', true, 5, 'Unassigned'],
    [2, 1, null, 1, 'ineligible', false, 1, 'Unassigned'],
  ]);
  assert.equal(players[0].reason, finalized.profiles[0].explanation);
  assert.equal(prior.baseCost, 8, 'Reading the new roster preserves the original eligibility evidence.');
});

test('before finalization the frozen keeper pool retains its current-season profile and imported draft context', () => {
  const players = buildLiveLeaguePlayers({ ...finalized, ownership: [{ player_id: 1, franchise_id: 'a' }],
    profiles: [{ player_id: 1, base_round: 8, tenure_years: 2, verification: 'confirmed', explanation: prior.reason }],
    snapshotId: 'keeper-pool', finalizedDraft: null });
  assert.deepEqual(players, [prior]);
});

test('missing finalized history, next-year profile, or selected snapshot entry fails instead of falling back to old eligibility', () => {
  for (const input of [
    { ...finalized, profiles: finalized.profiles.slice(1) },
    { ...finalized, finalizedDraft: [drafted] },
    { ...finalized, finalizedDraft: [{ ...retained, was_keeper: null }, drafted] },
    { ...finalized, roster: finalized.roster.filter(row => row.snapshot_id === 'keeper-pool') },
  ]) assert.throws(() => buildLiveLeaguePlayers(input), /missing/);
});

test('finalized history preserves old years and records drafting owners separately from final roster owners', () => {
  const old: HistoricalDraft = { year: 2025, selections: [{ round: 1, pick: 1, originalOwner: 'Former owner', owner: 'Former owner', player: 'Archived player', kept: false }] };
  const placeholder: HistoricalDraft = { year: 2026, selections: [] };
  const result = mergeFinalizedDraftArchive([old, placeholder], 2026, [drafted, { ...retained, round: 1 }], new Map([['a', 'Team A'], ['b', 'Team B']]), 2);
  assert.equal(result.length, 2); assert.equal(result[0], old);
  assert.deepEqual(result[1], { year: 2026, selections: [
    { round: 1, pick: 1, originalOwner: 'Team A', owner: 'Team A', player: 'Retained player', kept: true },
    { round: 1, pick: 2, originalOwner: 'Team B', owner: 'Team A', player: 'New draft player', kept: false },
  ] });
});

test('incomplete finalized history and missing player or original-owner context never produce a partial archive', () => {
  const franchiseNames = new Map([['a', 'Team A'], ['b', 'Team B']]);
  for (const rows of [[retained], [retained, retained], [retained, { ...drafted, overall_pick: 3 }],
    [retained, { ...drafted, players: null }], [retained, { ...drafted, source_metadata: {} }]]) {
    assert.throws(() => mergeFinalizedDraftArchive([], 2026, rows, franchiseNames, 2), /history/);
  }
});
