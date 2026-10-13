import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftActionSchema, draftOverallPick, draftQueueActionSchema } from '../../src/lib/draft-board';

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

test('clock configuration requires bounded whole seconds and a board revision; public ticks cannot submit player choices', () => {
  const seasonId = '71000000-0000-4000-8000-000000000001';
  for (const durationSeconds of [10, 90, 600]) assert.equal(draftActionSchema.safeParse({ action: 'configure', seasonId, expectedRevision: 0, durationSeconds }).success, true);
  for (const durationSeconds of [9, 601, 30.5, '90', null]) assert.equal(draftActionSchema.safeParse({ action: 'configure', seasonId, expectedRevision: 0, durationSeconds }).success, false);
  for (const action of ['start', 'pause', 'resume']) {
    assert.equal(draftActionSchema.safeParse({ action, seasonId, expectedRevision: 1 }).success, true);
    assert.equal(draftActionSchema.safeParse({ action, seasonId }).success, false);
    assert.equal(draftActionSchema.safeParse({ action, seasonId, expectedRevision: 1, durationSeconds: 30 }).success, false);
  }
  assert.equal(draftActionSchema.safeParse({ action: 'tick', seasonId }).success, true);
  for (const extra of [{ playerId: 123 }, { deadlineAt: '2026-10-09T00:00:00Z' }, { expectedRevision: 0 }]) assert.equal(draftActionSchema.safeParse({ action: 'tick', seasonId, ...extra }).success, false);
});

test('queue writes require a revision and distinct ESPN ids while allowing an empty queue', () => {
  const id = '71000000-0000-4000-8000-000000000001';
  const base = { seasonId: id, franchiseId: id, expectedRevision: 0, playerIds: [] };
  assert.equal(draftQueueActionSchema.safeParse(base).success, true);
  assert.equal(draftQueueActionSchema.safeParse({ ...base, playerIds: [123, 456] }).success, true);
  for (const playerIds of [[123, 123], [0], [-1], ['123'], Array.from({ length: 101 }, (_, i) => i + 1)]) assert.equal(draftQueueActionSchema.safeParse({ ...base, playerIds }).success, false);
  assert.equal(draftQueueActionSchema.safeParse({ ...base, expectedRevision: undefined }).success, false);
  assert.equal(draftQueueActionSchema.safeParse({ ...base, userId: id }).success, false);
});
