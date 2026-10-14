import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperPaymentInventory } from '../../src/lib/keeper-payment-inventory';
const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = () => ({ deadline: '2026-10-15T23:59:00-04:00', capturedAt: '2026-10-16T04:00:00Z', picks: [
  { id: id(1), seasonId: id(2), ownerId: id(3), originalOwnerId: id(4), round: 5, status: 'available' },
  { id: id(5), seasonId: id(2), ownerId: id(4), originalOwnerId: id(4), round: 6, status: 'used' },
] });
test('deadline inventory retains cutoff owners and only the then-available pick budget', () => {
  const raw = snapshot();
  assert.deepEqual(parseKeeperPaymentInventory(raw, id(2), 2026, { 1: id(3), 2: id(4) }), {
    deadline: raw.deadline, capturedAt: raw.capturedAt, picks: [{ id: id(1), season: 2026, round: 5, ownerTeamId: 1, originalTeamId: 2 }],
  });
  assert.equal(parseKeeperPaymentInventory(null, id(2), 2026, {}), null);
});
test('invalid season, duplicate picks and unknown owners cannot become a payment budget', () => {
  const parse = (raw: unknown) => parseKeeperPaymentInventory(raw, id(2), 2026, { 1: id(3), 2: id(4) });
  const wrong = snapshot(); wrong.picks[0].seasonId = id(20); assert.throws(() => parse(wrong));
  const duplicate = snapshot(); duplicate.picks.push(duplicate.picks[0]); assert.throws(() => parse(duplicate));
  const unknown = snapshot(); unknown.picks[0].ownerId = id(20); assert.throws(() => parse(unknown));
});
