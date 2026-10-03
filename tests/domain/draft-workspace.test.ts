import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignDraftSlot, readDraftShortlist } from '../../src/lib/draft-workspace';

test('exchanging occupied draft slots preserves every franchise without mutating the draft', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(assignDraftSlot(order, 0, 'd'), ['d', 'b', 'c', 'a']);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.deepEqual(assignDraftSlot(order, 2, 'c'), order);
});

test('draft assignment handles empty slots, clearing and invalid positions', () => {
  assert.deepEqual(assignDraftSlot(['a', '', 'c'], 1, 'a'), ['', 'a', 'c']);
  assert.deepEqual(assignDraftSlot(['a', 'b', 'c'], 1, ''), ['a', '', 'c']);
  assert.deepEqual(assignDraftSlot(['a', '', 'c'], 1, 'b'), ['a', 'b', 'c']);
  assert.deepEqual(assignDraftSlot(['a', 'b'], -1, 'b'), ['a', 'b']);
  assert.deepEqual(assignDraftSlot(['a', 'b'], 0.5, 'b'), ['a', 'b']);
});

test('local draft shortlists ignore malformed and retired entries and preserve saved ordering', () => {
  const catalog = new Set([1, 2, 3]);
  assert.deepEqual(readDraftShortlist('[3,1,3,"2",null,-1,4]', catalog), [3, 1]);
  for (const value of [null, '{', '{}', 'null']) assert.deepEqual(readDraftShortlist(value, catalog), []);
});
