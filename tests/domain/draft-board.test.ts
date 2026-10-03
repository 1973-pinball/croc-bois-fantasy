import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftActionSchema, draftOverallPick } from '../../src/lib/draft-board';

test('snake positions reverse by original franchise, and linear positions do not', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => draftOverallPick(1, i + 1, 8)), [1,2,3,4,5,6,7,8]);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => draftOverallPick(2, i + 1, 8)), [16,15,14,13,12,11,10,9]);
  assert.equal(draftOverallPick(3, 1, 8), 17); assert.equal(draftOverallPick(2, 1, 8, 'linear'), 9);
  for (const position of [0, 9, 1.5]) assert.throws(() => draftOverallPick(1, position, 8));
});

test('draft requests require revision, official numeric player identity and correction reasons; extra fields are rejected', () => {
  const id = '71000000-0000-4000-8000-000000000001';
  const base = { action: 'record', seasonId: id, expectedRevision: 0, pickId: id, playerId: 123 };
  assert.equal(draftActionSchema.safeParse(base).success, true);
  assert.equal(draftActionSchema.safeParse({ ...base, playerName: 'Untrusted name' }).success, false);
  assert.equal(draftActionSchema.safeParse({ ...base, expectedRevision: undefined }).success, false);
  assert.equal(draftActionSchema.safeParse({ ...base, playerId: '123' }).success, false);
  assert.equal(draftActionSchema.safeParse({ ...base, action: 'correct', note: '  ' }).success, false);
  assert.equal(draftActionSchema.safeParse({ ...base, action: 'correct', note: 'Corrected the player.' }).success, true);
  assert.equal(draftActionSchema.safeParse({ action: 'undo', seasonId: id, expectedRevision: 2, pickId: id, note: 'Undo duplicate entry.' }).success, true);
});
