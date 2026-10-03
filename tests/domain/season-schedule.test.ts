import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleInput, scheduleInstant, formatSeasonDate } from '../../src/lib/season-schedule';

test('league schedule uses the selected zone rather than the computer time zone', () => {
  assert.equal(scheduleInstant('2026-10-20T20:30', 'America/New_York'), '2026-10-21T00:30:00.000Z');
  assert.equal(scheduleInput('2026-10-21T00:30:00Z', 'America/New_York'), '2026-10-20T20:30');
  assert.equal(scheduleInstant('2026-12-20T20:30', 'America/New_York'), '2026-12-21T01:30:00.000Z');
  assert.equal(scheduleInstant('2026-10-20T20:30', 'Asia/Kolkata'), '2026-10-20T15:00:00.000Z');
});

test('DST gaps and repeated times cannot silently change the commissioner schedule', () => {
  assert.throws(() => scheduleInstant('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => scheduleInstant('2026-11-01T01:30', 'America/New_York'), /occurs twice/);
  assert.equal(scheduleInstant('2026-11-01T06:30', 'UTC'), '2026-11-01T06:30:00.000Z');
});

test('unset dates stay unknown and invalid calendar dates fail validation', () => {
  assert.equal(scheduleInstant('', 'America/New_York'), null);
  assert.equal(scheduleInput(null, 'America/New_York'), '');
  assert.equal(formatSeasonDate(null), 'Not scheduled');
  assert.throws(() => scheduleInstant('2026-02-30T12:00', 'UTC'), /valid calendar/);
  assert.throws(() => scheduleInstant('2026-10-20T20:30', 'Invalid/Zone'));
});
