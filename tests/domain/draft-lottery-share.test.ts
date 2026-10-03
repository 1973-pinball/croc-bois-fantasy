import test from 'node:test';
import assert from 'node:assert/strict';
import { draftLotteryShareRequestSchema, draftLotteryShareSchema } from '../../src/lib/draft-lottery-share';

test('a share request cannot choose its link, names, dates, or result', () => {
  const request = { seasonId: '74000000-0000-4000-8000-000000000001' };
  assert.equal(draftLotteryShareRequestSchema.safeParse(request).success, true);
  for (const key of ['shareId', 'order', 'managerLabel', 'drawnAt', 'result']) assert.equal(draftLotteryShareRequestSchema.safeParse({ ...request, [key]: 'chosen' }).success, false);
});

test('public replay parsing allows only safe snapshot fields and requires eight ordered priorities', () => {
  const replay = { shareId: '74000000-0000-4000-8000-000000000001', draftYear: 2026,
    drawnAt: '2026-10-03T14:00:00Z', sharedAt: '2026-10-03T15:00:00Z',
    order: Array.from({ length: 8 }, (_, index) => ({ priority: index + 1, managerLabel: `Manager ${index + 1}`, teamName: `Team ${index + 1}` })),
  };
  assert.deepEqual(draftLotteryShareSchema.parse({ ...replay, privateAudit: 'sensitive', order: replay.order.map(row => ({ ...row, email: 'hidden@example.test' })) }), replay);
  assert.equal(draftLotteryShareSchema.safeParse({ ...replay, order: replay.order.slice(1) }).success, false);
  assert.equal(draftLotteryShareSchema.safeParse({ ...replay, order: [...replay.order].reverse() }).success, false);
  assert.equal(draftLotteryShareSchema.safeParse({ ...replay, order: replay.order.map(row => ({ ...row, managerLabel: '' })) }).success, false);
});
