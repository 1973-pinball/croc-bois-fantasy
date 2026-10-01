import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownTeamIds, teamAccessActionSchema } from '../../src/lib/team-access';

test('team access input cannot specify another applicant or grant a commissioner role', () => {
  const franchiseId = 'a0000000-0000-4000-8000-000000000001';
  assert.equal(teamAccessActionSchema.safeParse({ action: 'request', franchiseId, displayName: 'Owner', userId: franchiseId }).success, false);
  assert.equal(teamAccessActionSchema.safeParse({ action: 'request', franchiseId, displayName: 'Owner', applicantEmail: 'other@example.com' }).success, false);
  assert.equal(teamAccessActionSchema.safeParse({ action: 'approve', requestId: franchiseId, role: 'commissioner' }).success, false);
  assert.equal(teamAccessActionSchema.safeParse({ action: 'reject', requestId: franchiseId, note: '  ' }).success, false);
  assert.equal(teamAccessActionSchema.safeParse({ action: 'revoke', assignmentId: franchiseId, note: '' }).success, false);
});

test('My Team uses current explicit assignments, including co-managers and expansion handles', () => {
  const league_id = 'league';
  const assignments = [
    { league_id, franchise_id: 'own', effective_from: '2026-01-01', effective_to: null },
    { league_id, franchise_id: 'old', effective_from: '2025-01-01', effective_to: '2026-01-01' },
    { league_id, franchise_id: 'future', effective_from: '2027-01-01', effective_to: null },
    { league_id: 'other', franchise_id: 'elsewhere', effective_from: '2026-01-01', effective_to: null },
  ];
  const map = { '1': 'old', '2': 'future', '-1': 'own', '3': 'elsewhere' };
  const now = Date.parse('2026-10-01');
  for (const role of ['manager', 'commissioner']) assert.deepEqual(ownTeamIds(league_id, [{ league_id, role }], assignments, map, now), [-1]);
  assert.deepEqual(ownTeamIds(league_id, [{ league_id, role: 'viewer' }], assignments, map, now), []);
  assert.deepEqual(ownTeamIds(league_id, [{ league_id, role: 'commissioner' }], [], map, now), []);
});
