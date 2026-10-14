import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidKeeperPaymentAllocation, keeperPaymentOptions, type KeeperPaymentOptionsInput, type PaymentAssignment } from '../../src/lib/keeper-payment-options';
import { finalizeTradeSchema, reassignPaymentsSchema } from '../../src/lib/keeper-payment-contract';

const pick = (id: string, round: number, ownerTeamId = 1, season = 2026) => ({ id, round, ownerTeamId, season, originalTeamId: ownerTeamId });
const base = (overrides: Partial<KeeperPaymentOptionsInput> = {}): KeeperPaymentOptionsInput => ({
  season: 2026, teamId: 1, keepers: [{ playerId: 101, baseRound: 5, pickId: 'five' }],
  picks: [pick('five', 5), pick('other-five', 5), pick('four', 4)], ...overrides,
});

test('only legal current-season owned picks are offered, with submitted cost fixed', () => {
  const input = base({ picks: [...base().picks, pick('too-late', 6), pick('not-owned', 5, 2), pick('future', 5, 1, 2027), pick('draft-used', 5)], usedPickIds: ['draft-used'] });
  assert.deepEqual(keeperPaymentOptions(input).options[101].map(option => option.pickId).sort(), ['five', 'other-five']);
  assert.deepEqual(keeperPaymentOptions(base({ keepers: [{ playerId: 101, baseRound: null, pickId: 'five' }] })).options[101], []);
});

test('a choice can swap two keepers together without offering an illegal intermediate payment', () => {
  const input = base({ keepers: [{ playerId: 101, baseRound: 5, pickId: 'five' }, { playerId: 102, baseRound: 5, pickId: 'four' }], picks: [pick('five', 5), pick('four', 4)] });
  const four = keeperPaymentOptions(input).options[101].find(option => option.pickId === 'four');
  assert.deepEqual(four?.assignments, [{ playerId: 101, pickId: 'four' }, { playerId: 102, pickId: 'five' }]);
  assert.equal(isValidKeeperPaymentAllocation(input, four!.assignments), true);
});

test('keeper-used picks can be reassigned while draft-used picks remain unavailable', () => {
  const input = base({ usedPickIds: ['five', 'other-five'], reusablePickIds: ['five'] });
  assert.deepEqual(keeperPaymentOptions(input).options[101].map(option => option.pickId), ['five']);
});

test('prospective trade owners produce a complete replacement and do not mutate source picks', () => {
  const input = base({ picks: [pick('five', 5, 2), pick('received-five', 5), pick('four', 4)] });
  const snapshot = JSON.stringify(input);
  const result = keeperPaymentOptions(input);
  assert.deepEqual(result.assignments, [{ playerId: 101, pickId: 'received-five' }]);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(result.options[101].some(option => option.pickId === 'five'), false);
});

test('deadline ownership excludes later acquisitions even when they are currently owned or reusable', () => {
  const input = base({
    picks: [pick('retained', 4), pick('acquired-after-deadline', 5), pick('traded-away', 5, 2)],
    deadlinePicks: [pick('retained', 4), pick('acquired-after-deadline', 5, 2), pick('traded-away', 5)],
    usedPickIds: ['acquired-after-deadline'], reusablePickIds: ['acquired-after-deadline'],
  });
  assert.deepEqual(keeperPaymentOptions(input).assignments, [{ playerId: 101, pickId: 'retained' }]);
  assert.deepEqual(keeperPaymentOptions(input).options[101].map(option => option.pickId), ['retained']);
  assert.equal(isValidKeeperPaymentAllocation(input, [{ playerId: 101, pickId: 'acquired-after-deadline' }]), false);
});

test('missing deadline inventory fails closed while previews use current ownership', () => {
  const pending = base({ deadlinePicks: null });
  assert.equal(keeperPaymentOptions(pending).assignments, null);
  assert.deepEqual(keeperPaymentOptions(pending).options[101], []);
  assert.equal(keeperPaymentOptions(base({ deadlinePicks: [] })).assignments, null);
  assert.deepEqual(keeperPaymentOptions(base()).assignments, [{ playerId: 101, pickId: 'five' }]);
});

test('post-deadline trades can replace payments only with retained deadline-owned picks', () => {
  const input = base({ picks: [pick('five', 5, 2), pick('other-five', 5), pick('incoming-five', 5)], deadlinePicks: [pick('five', 5), pick('other-five', 5), pick('incoming-five', 5, 2)] });
  assert.deepEqual(keeperPaymentOptions(input).assignments, [{ playerId: 101, pickId: 'other-five' }]);
  assert.deepEqual(keeperPaymentOptions(input).options[101].map(option => option.pickId), ['other-five']);
});

test('insufficient picks offer no invalid fallback and fixed players cannot be removed or added', () => {
  const input = base({ keepers: [{ playerId: 101, baseRound: 5, pickId: 'five' }, { playerId: 102, baseRound: 5, pickId: 'four' }], picks: [pick('five', 5)] });
  assert.equal(keeperPaymentOptions(input).assignments, null);
  assert.deepEqual(keeperPaymentOptions(input).options, { 101: [], 102: [] });
  assert.equal(isValidKeeperPaymentAllocation(base(), []), false);
  assert.equal(isValidKeeperPaymentAllocation(base(), [{ playerId: 999, pickId: 'five' }]), false);
});

test('offered choices match exhaustive legal full allocations across constrained payment sets', () => {
  for (const costs of [[2, 2], [2, 3], [3, 2], [1, 3], [2, 2, 3]]) {
    for (const rounds of [[1, 2, 3], [1, 2, 2], [1, 1, 3], [2, 2, 3], [1, 2, 3, 3]]) {
      const input = base({ keepers: costs.map((baseRound, i) => ({ playerId: i + 1, baseRound, pickId: `p${i}` })), picks: rounds.map((round, i) => pick(`p${i}`, round)) });
      const valid: PaymentAssignment[][] = [];
      const walk = (assignments: PaymentAssignment[]) => {
        if (assignments.length === costs.length) { if (isValidKeeperPaymentAllocation(input, assignments)) valid.push(assignments); return; }
        for (const candidate of input.picks) if (!assignments.some(a => a.pickId === candidate.id)) walk([...assignments, { playerId: assignments.length + 1, pickId: candidate.id }]);
      };
      walk([]);
      const result = keeperPaymentOptions(input);
      assert.equal(result.assignments !== null, valid.length > 0);
      for (const keeper of input.keepers) assert.deepEqual(result.options[keeper.playerId].map(o => o.pickId).sort(), [...new Set(valid.map(a => a.find(row => row.playerId === keeper.playerId)!.pickId))].sort(), JSON.stringify({ costs, rounds, playerId: keeper.playerId }));
    }
  }
});

test('HTTP contracts require a reason for early review or payment changes and preserve default review', () => {
  const tradeId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const payment = { submissionId: tradeId, expectedRevision: 2, assignments: [{ playerId: 101, pickId: 'bbbbbbbb-1111-4111-8111-111111111111' }] };
  assert.deepEqual(finalizeTradeSchema.parse({ tradeId }), { tradeId, keeperPayments: [], overrideReview: false });
  assert.equal(finalizeTradeSchema.safeParse({ tradeId, overrideReview: true }).success, false);
  assert.equal(finalizeTradeSchema.safeParse({ tradeId, keeperPayments: [payment] }).success, false);
  assert.equal(finalizeTradeSchema.safeParse({ tradeId, keeperPayments: [payment, payment], note: 'Pick swap' }).success, false);
  assert.equal(finalizeTradeSchema.safeParse({ tradeId, overrideReview: true, note: 'Both teams agreed' }).success, true);
  assert.equal(reassignPaymentsSchema.safeParse({ ...payment, action: 'reassign_payments', note: 'Pick swap', players: [999] }).success, false);
  assert.equal(reassignPaymentsSchema.safeParse({ ...payment, action: 'reassign_payments', note: 'Pick swap' }).success, true);
});
