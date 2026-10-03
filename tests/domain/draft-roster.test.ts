import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftRosters } from '../../src/lib/draft-roster';
import type { DraftBoard, DraftBoardPick } from '../../src/lib/draft-board';
import type { DraftRosterEligibility, DraftRosterSettings } from '../../src/lib/espn-roster-settings';

const teamA = '71000000-0000-4000-8000-000000000001';
const teamB = '71000000-0000-4000-8000-000000000002';
const labels: Record<number, string> = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 11: 'UTIL', 12: 'BE', 13: 'IR' };
const source = { sha256: 'a'.repeat(64), url: 'https://example.com/fixture', capturedAt: '2026-10-03T00:00:00Z' };
function settings(counts: Record<number, number>): DraftRosterSettings {
  const slots = Object.entries(counts).map(([id, count]) => ({ slotId: Number(id), label: labels[Number(id)], count, kind: Number(id) === 13 ? 'reserve' as const : 'normal' as const }));
  return { version: 1, leagueId: 139935, espnSeasonId: 2027, source, slots, slotDefinitionsSource: source, positionLimitsSource: source,
    slotDefinitions: slots.map(slot => ({ slotId: slot.slotId, label: slot.label, name: slot.label, bench: slot.slotId === 12, reserve: slot.kind === 'reserve', lineupSlotEligible: true })),
    normalCapacity: slots.filter(slot => slot.kind === 'normal').reduce((sum, slot) => sum + slot.count, 0),
    reserveCapacity: slots.filter(slot => slot.kind === 'reserve').reduce((sum, slot) => sum + slot.count, 0),
    lineupSlotCounts: Object.fromEntries(Object.entries(counts)), positionLimits: { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1 }, isBenchUnlimited: true,
    primaryPositionLimits: [1, 2, 3, 4, 5].map(positionId => ({ positionId, label: labels[positionId - 1], maximum: null })), limitations: [],
  };
}
function eligibility(slots: number[][]): DraftRosterEligibility {
  return { version: 1, leagueId: 139935, espnSeasonId: 2027, source, players: slots.map((eligibleSlots, index) => ({
    id: index + 1, name: `Player ${index + 1}`, eligibleSlots, primaryPositionId: 1, injuryStatus: index === 0 ? 'OUT' : 'ACTIVE', active: true, poolStatus: 'ONTEAM',
  })) };
}
function pick(playerId: number, overrides: Partial<DraftBoardPick> = {}): DraftBoardPick {
  return { id: `pick-${playerId}`, round: playerId, overallPick: playerId, originalFranchiseId: teamA, currentOwnerId: teamA, status: 'selected',
    playerId, playerName: `Player ${playerId}`, selectionId: `selection-${playerId}`, ...overrides };
}
function board(picks: DraftBoardPick[]): DraftBoard {
  return { seasonId: '72000000-0000-4000-8000-000000000001', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13, revision: 1,
    keepersRevealedAt: '2026-10-03T00:00:00Z', orderComplete: true, orderLocked: true, nextPickId: null,
    teams: [{ franchiseId: teamA, espnTeamId: 1, displayName: 'A', draftPosition: 1 }, { franchiseId: teamB, espnTeamId: 2, displayName: 'B', draftPosition: 2 }], picks };
}

test('fills active slots before bench and avoids the PG/SG flex trap', () => {
  const result = buildDraftRosters(board([pick(1), pick(2)]), settings({ 0: 1, 1: 1, 12: 1 }), eligibility([[0, 1, 12], [0, 12]])).teams[0];
  assert.deepEqual(result.slots.map(slot => [slot.label, slot.player?.id ?? null]), [['PG', 2], ['SG', 1], ['BE', null]]);
  assert.equal(result.totalPlayers, 2); assert.equal(result.remainingCapacity, 1); assert.equal(result.unplaced.length, 0);
  assert.deepEqual(result.slotCounts.map(slot => [slot.label, slot.filled, slot.total]), [['PG', 1, 1], ['SG', 1, 1], ['BE', 0, 1]]);
});

test('fills PG and SG before using flexible G or UTIL slots', () => {
  const result = buildDraftRosters(board([pick(1), pick(2)]), settings({ 0: 1, 1: 1, 5: 1, 11: 1, 12: 1 }), eligibility([[0, 1, 5, 11, 12], [0, 5, 11, 12]])).teams[0];
  assert.deepEqual(result.slots.map(slot => [slot.label, slot.player?.id ?? null]), [['PG', 2], ['SG', 1], ['G', null], ['UTIL', null], ['BE', null]]);
});

test('handles a multi-hop flex reassignment and preserves stable assignments when no move is needed', () => {
  const config = settings({ 0: 1, 1: 1, 2: 1, 12: 1 });
  const pool = eligibility([[0, 1, 12], [1, 2, 12], [0, 12], [12]]);
  const result = buildDraftRosters(board([pick(1), pick(2), pick(3)]), config, pool).teams[0];
  assert.deepEqual(result.slots.map(slot => slot.player?.id ?? null), [3, 1, 2, null]);
  const added = buildDraftRosters(board([pick(4), pick(3), pick(1), pick(2)]), config, pool).teams[0];
  assert.deepEqual(added.slots.map(slot => slot.player?.id ?? null), [3, 1, 2, 4]);
  assert.deepEqual(added, buildDraftRosters(board([pick(1), pick(2), pick(3), pick(4)]), config, pool).teams[0]);
});

test('can move a bench-eligible incumbent to fit a player without bench eligibility', () => {
  const result = buildDraftRosters(board([pick(1), pick(2)]), settings({ 0: 1, 12: 1 }), eligibility([[0, 12], [0]])).teams[0];
  assert.deepEqual(result.slots.map(slot => slot.player?.id), [2, 1]);
  assert.equal(result.unplaced.length, 0);
});

test('the fit maximizes specific positions, active slots, then total players against exhaustive small cases', () => {
  function optimum(candidates: number[][]) {
    let best = [0, 0, 0];
    function visit(player: number, used: Set<number>, specific: number, active: number, total: number) {
      if (player === candidates.length) {
        if (specific > best[0] || (specific === best[0] && (active > best[1] || (active === best[1] && total > best[2])))) best = [specific, active, total];
        return;
      }
      visit(player + 1, used, specific, active, total);
      for (const slot of candidates[player]) if (!used.has(slot)) { used.add(slot); visit(player + 1, used, specific + (slot <= 4 ? 1 : 0), active + (slot === 12 ? 0 : 1), total + 1); used.delete(slot); }
    }
    visit(0, new Set(), 0, 0, 0); return best;
  }
  for (const slotIds of [[0, 1, 12], [0, 5, 12]]) {
    const config = settings(Object.fromEntries(slotIds.map(id => [id, 1])));
    for (let masks = 0; masks < 512; masks++) {
      const candidates = Array.from({ length: 3 }, (_, player) => slotIds.filter((_, bit) => ((masks >> (player * 3)) & (1 << bit)) !== 0));
      const fitted = buildDraftRosters(board([pick(1), pick(2), pick(3)]), config, eligibility(candidates)).teams[0];
      const score = [fitted.slots.filter(slot => slot.slotId <= 4 && slot.player).length, fitted.slots.filter(slot => slot.slotId !== 12 && slot.player).length, fitted.slots.filter(slot => slot.player).length];
      assert.deepEqual(score, optimum(candidates), JSON.stringify(candidates));
      const assigned = fitted.slots.flatMap(slot => slot.player ? [slot.player.id] : []);
      assert.equal(new Set(assigned).size, assigned.length);
    }
  }
});

test('uses current owners, replaces corrected players, and removes undone or available picks', () => {
  const config = settings({ 0: 1, 12: 2 }); const pool = eligibility([[0, 12], [0, 12], [12]]);
  const traded = pick(1, { currentOwnerId: teamB });
  const original = buildDraftRosters(board([traded, pick(2, { status: 'keeper' }), pick(3, { status: 'available' })]), config, pool);
  assert.deepEqual(original.teams.map(team => [team.totalPlayers, team.keptPlayers, team.draftedPlayers]), [[1, 1, 0], [1, 0, 1]]);
  assert.deepEqual(original.teams[1].players.map(player => player.id), [1]);
  const corrected = buildDraftRosters(board([{ ...traded, playerId: 3, playerName: 'Player 3' }, pick(2, { status: 'keeper' })]), config, pool);
  assert.deepEqual(corrected.teams[1].players.map(player => player.id), [3]);
  const undone = buildDraftRosters(board([{ ...traded, status: 'available', playerId: null, playerName: null }]), config, pool);
  assert.equal(undone.teams.reduce((sum, team) => sum + team.totalPlayers, 0), 0);
});

test('never includes a keeper before public reveal, even if its pick is supplied', () => {
  const current = board([pick(1, { status: 'keeper' }), pick(2)]); current.keepersRevealedAt = null;
  const result = buildDraftRosters(current, settings({ 0: 1, 12: 1 }), eligibility([[0, 12], [0, 12]]));
  assert.deepEqual(result.teams[0].players.map(player => player.id), [2]);
  assert.equal(JSON.stringify(result).includes('Player 1'), false);
});

test('does not turn raw IR eligibility or injury status into an extra draft slot', () => {
  const result = buildDraftRosters(board([pick(1), pick(2), pick(3)]), settings({ 0: 1, 12: 1, 13: 2 }), eligibility([[0, 12, 13], [12, 13], [13]])).teams[0];
  assert.equal(result.normalCapacity, 2); assert.equal(result.reserveCapacity, 2); assert.equal(result.overflow, 1);
  assert.equal(result.reserveSlots.every(slot => slot.player === null), true);
  assert.equal(result.slotCounts.find(slot => slot.slotId === 13)?.filled, 0);
  assert.equal(result.unplaced[0].reason, 'no_normal_slot_eligibility');
  assert.equal(result.players.flatMap(player => player.eligibleLabels).includes('IR'), false);
  assert.equal(result.eligiblePositionCounts.some(slot => slot.slotId === 13), false);
});

test('shows unknown eligibility and missing lineup fit without declaring roster illegality', () => {
  const result = buildDraftRosters(board([pick(1), pick(2), pick(3), pick(4)]), settings({ 0: 1, 1: 1, 12: 1 }), eligibility([[0], [0], []])).teams[0];
  assert.equal(result.totalPlayers, 4); assert.equal(result.overflow, 1); assert.equal(result.remainingCapacity, 0);
  assert.deepEqual(result.unplaced.map(item => item.reason), ['no_suggested_slot', 'missing_eligibility', 'missing_eligibility']);
  assert.equal(result.slotCounts.find(slot => slot.slotId === 1)?.open, 1);
  assert.equal(result.slotCounts.find(slot => slot.slotId === 12)?.open, 1);
  assert.equal(result.players.find(player => player.id === 4)?.eligibleSlots, null);
});

test('counts multi-position eligibility separately from unique players and assigned slots', () => {
  const result = buildDraftRosters(board([pick(1)]), settings({ 0: 1, 1: 1, 5: 1, 11: 1, 12: 1 }), eligibility([[0, 1, 5, 11, 12, 13]])).teams[0];
  assert.equal(result.totalPlayers, 1);
  assert.equal(result.slotCounts.reduce((sum, slot) => sum + slot.filled, 0), 1);
  assert.deepEqual(result.eligiblePositionCounts.map(slot => slot.count), [1, 1, 1, 1, 1]);
  assert.deepEqual(result.players[0].eligibleLabels, ['PG', 'SG', 'G', 'UTIL', 'BE']);
});

test('deduplicates repeated picks, rejects ambiguous ownership, and does not guess unknown owners', () => {
  const config = settings({ 0: 1, 12: 1 }); const pool = eligibility([[0, 12]]);
  const duplicate = buildDraftRosters(board([pick(1), pick(1, { id: 'later', overallPick: 2 })]), config, pool);
  assert.equal(duplicate.teams[0].totalPlayers, 1); assert.equal(duplicate.teams[0].issues.length, 1);
  const ambiguous = buildDraftRosters(board([pick(1), pick(1, { id: 'later', overallPick: 2, currentOwnerId: teamB })]), config, pool);
  assert.deepEqual(ambiguous.teams.map(team => team.totalPlayers), [0, 0]); assert.equal(ambiguous.issues.length, 1);
  const missing = buildDraftRosters(board([pick(1, { currentOwnerId: null })]), config, pool);
  assert.equal(missing.teams[0].totalPlayers, 0); assert.equal(missing.issues.length, 1);
});

test('does not apply a different season snapshot or inconsistent slot capacity', () => {
  const current = board([]); const config = settings({ 0: 1 }); const pool = eligibility([[0]]);
  assert.equal(buildDraftRosters({ ...current, draftYear: 2025 }, config, pool).available, false);
  assert.equal(buildDraftRosters(current, { ...config, normalCapacity: 9 }, pool).available, false);
  assert.equal(buildDraftRosters(current, config, { ...pool, players: [pool.players[0], pool.players[0]] }).available, false);
});
