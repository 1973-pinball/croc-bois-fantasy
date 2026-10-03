import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSeasonTimeZone, seasonActionSchema, seasonReadinessSchema } from '../../src/lib/season-readiness';

const schedule = { action: 'update_schedule', seasonId: '10000000-0000-4000-8000-000000000001', expectedRevision: 0, keeperDeadline: null, draftAt: null, seasonTimeZone: null, note: 'Dates await commissioner confirmation.' };

test('schedule input preserves unset dates and requires explicit valid timezone and chronology', () => {
  assert.equal(seasonActionSchema.safeParse(schedule).success, true);
  const dates = { ...schedule, keeperDeadline: '2026-10-10T18:00:00-04:00', draftAt: '2026-10-11T18:00:00-04:00', seasonTimeZone: 'America/New_York' };
  assert.equal(seasonActionSchema.safeParse(dates).success, true);
  for (const invalid of [
    { ...dates, seasonTimeZone: null }, { ...dates, seasonTimeZone: 'Mars/Olympus' },
    { ...dates, draftAt: '2026-10-09T18:00:00-04:00' }, { ...dates, keeperDeadline: '2026-02-30T18:00:00Z' },
    { ...dates, keeperDeadline: '2026-10-10T18:00' }, { ...dates, expectedRevision: -1 },
    { ...dates, note: ' ' }, { ...dates, lockAutomatically: true },
  ]) assert.equal(seasonActionSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  assert.equal(isSeasonTimeZone('UTC'), true);
  assert.equal(isSeasonTimeZone('EST'), false);
  assert.equal(isSeasonTimeZone('posix/America/New_York'), false);
});

test('readiness rejects private selection fields instead of passing them through', () => {
  const readiness = { seasonId: schedule.seasonId, leagueId: schedule.seasonId, phase: 'setup', participantCount: 2, registeredCount: 2, hasFrozenSnapshot: false, inventoryComplete: false, totalPickCount: 0, expectedTotalPickCount: 26, keeperDeadline: null, draftAt: null, seasonTimeZone: null, scheduleRevision: 0, tradingOpenedAt: null, keepersRevealedAt: null, teams: [{ franchiseId: schedule.seasonId, displayName: 'Team', status: 'missing', revision: null, activeManagerCount: 0, pendingAccessCount: 0, playerCount: 0, profileCounts: { confirmed: 0, provisional: 0, unresolved: 0, ineligible: 0, missing: 0 }, pickCount: 0, originalPickCount: 0, expectedPickCount: 13 }] };
  assert.equal(seasonReadinessSchema.safeParse(readiness).success, true);
  assert.equal(seasonReadinessSchema.safeParse({ ...readiness, teams: [{ ...readiness.teams[0], assignments: [{ playerId: 123 }] }] }).success, false);
  assert.equal(seasonReadinessSchema.safeParse({ ...readiness, applicantEmail: 'private@example.invalid' }).success, false);
});
