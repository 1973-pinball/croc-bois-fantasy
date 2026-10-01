import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = id(1), otherLeague = id(2), season = id(3), rule = id(4);
const teamA = id(10), teamB = id(11), otherTeam = id(12);
const managerA = id(20), managerB = id(21), otherManager = id(22);
const historicalA = id(23), historicalB = id(24);
const userA = id(30), userB = id(31), userC = id(32), commissioner = id(33), otherCommissioner = id(34), noEmail = id(35);
type RequestRow = { id: string; league_id: string; franchise_id: string; user_id: string; applicant_email: string; display_name: string; status: string; request_note: string; review_note: string | null; manager_id: string | null; assignment_id: string | null; assigned_role: string | null; cancelled_at: string | null };

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`
    insert into auth.users(id,email) values('${userA}','applicant-a@example.invalid'),('${userB}','applicant-b@example.invalid'),('${userC}','applicant-c@example.invalid'),('${commissioner}','commissioner@example.invalid'),('${otherCommissioner}','other@example.invalid'),('${noEmail}',null);
    insert into public.leagues(id,slug,name,is_public) values('${league}','onboarding-test','League One',true),('${otherLeague}','private-test','Private League',false);
    insert into public.league_memberships(league_id,user_id,role) values('${league}','${commissioner}','commissioner'),('${otherLeague}','${otherCommissioner}','commissioner');
    insert into public.franchises(id,league_id,name) values('${teamA}','${league}','Team A'),('${teamB}','${league}','Team B'),('${otherTeam}','${otherLeague}','Other Team');
    insert into public.managers(id,league_id,display_name) values('${managerA}','${league}','Historical A'),('${managerB}','${league}','Historical B'),('${otherManager}','${otherLeague}','Other Manager');
    insert into public.manager_assignments(id,league_id,franchise_id,manager_id,historical_note) values('${historicalA}','${league}','${teamA}','${managerA}','Imported identity; dates unknown'),('${historicalB}','${league}','${teamB}','${managerB}','Imported identity; dates unknown');
    insert into public.manager_assignments(league_id,franchise_id,manager_id) values('${otherLeague}','${otherTeam}','${otherManager}');
    insert into public.rule_versions(id,league_id,version) values('${rule}','${league}',1);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count) values('${season}','${league}','2026',2026,'${rule}',2);
    insert into public.season_teams(season_id,franchise_id,league_id,display_name) values('${season}','${teamA}','${league}','Team A'),('${season}','${teamB}','${league}','Team B');
  `);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']);
  await db.exec(`set local role ${role}`);
}
async function admin() { await db.exec('reset role'); }
async function isolated(work: () => Promise<void>) { await admin(); await db.exec('begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejected(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint expected_rejection');
  try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint expected_rejection'); }
}
async function request(team = teamA, name = 'Applicant', note = '') {
  return (await db.query<{ value: RequestRow }>('select to_jsonb(public.request_team_access($1,$2,$3)) as value', [team, name, note])).rows[0].value;
}
async function review(requestId: string, action = 'approve', manager: string | null = null, role = 'manager', note = '') {
  return (await db.query<{ value: RequestRow }>('select to_jsonb(public.review_team_access($1,$2,$3,$4,$5)) as value', [requestId, action, manager, role, note])).rows[0].value;
}
async function cancel(requestId: string) {
  return (await db.query<{ value: RequestRow }>('select to_jsonb(public.cancel_team_access($1)) as value', [requestId])).rows[0].value;
}
async function revoke(assignment: string, note = 'Commissioner verified the manager handover') { return db.query('select public.revoke_team_access($1,$2)', [assignment, note]); }
async function canManage(team: string) { return (await db.query<{ allowed: boolean }>('select private.can_manage_franchise($1) as allowed', [team])).rows[0].allowed; }
async function logTrade() { return db.query('select public.create_trade($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)', [season, 'advanced', '', '[]', '[]', JSON.stringify([{ from_franchise_id: teamA, to_franchise_id: teamB, kind: 'other', terms: 'An obligation' }])]); }
async function approved(user: string, team = teamA, manager: string | null = null, role = 'manager') {
  await asUser(user); const pending = await request(team);
  await asUser(commissioner); return review(pending.id, 'approve', manager, role);
}

test('requests use authenticated identity and server email, remain private, and grant no access', () => isolated(async () => {
  await asUser(userA);
  const pending = await request(teamA, '  Applicant A  ', 'Please link my account.');
  assert.equal(pending.user_id, userA);
  assert.equal(pending.applicant_email, 'applicant-a@example.invalid');
  assert.equal(pending.display_name, 'Applicant A');
  assert.equal(pending.league_id, league);
  assert.equal(pending.status, 'pending');
  assert.equal(await canManage(teamA), false);
  assert.equal((await db.query('select * from public.league_memberships')).rows.length, 0);
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 1);
  await rejected(() => review(pending.id), /Commissioner access required/);
  await rejected(() => db.query("update public.team_access_requests set status='approved' where id=$1", [pending.id]), /permission denied/);
  await rejected(() => db.query("insert into public.league_memberships(league_id,user_id,role) values($1,$2,'commissioner')", [league, userA]), /permission denied/);
  await rejected(() => db.query('update public.manager_assignments set user_id=$1 where id=$2', [userA, historicalA]), /permission denied/);
  await asUser(userB);
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 0);
  await rejected(() => cancel(pending.id), /Only the applicant/);
  await asUser(commissioner);
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 1);
  await asUser(null, 'anon');
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 0);
  await rejected(() => request(), /permission denied/);
  await asUser(null);
  await rejected(() => request(), /Sign in/);
  await asUser(noEmail);
  await rejected(() => request(), /email address is required/);
}));

test('one pending request per league, rejection reason, cancellation, and retry preserve the full audit history', () => isolated(async () => {
  await asUser(userA); const first = await request();
  await rejected(() => request(teamB), /already have a pending/);
  await asUser(commissioner);
  await rejected(() => review(first.id, 'reject'), /rejection reason/);
  assert.equal((await review(first.id, 'reject', null, 'manager', 'Confirm the intended team')).status, 'rejected');
  await rejected(() => review(first.id), /no longer pending/);
  await asUser(userA); const second = await request(teamB);
  const cancelled = await cancel(second.id);
  assert.equal(cancelled.status, 'cancelled'); assert.notEqual(cancelled.cancelled_at, null);
  await rejected(() => cancel(second.id), /no longer pending/);
  const third = await request(); assert.equal(third.status, 'pending');
  await asUser(commissioner);
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 3);
  assert.equal((await db.query("select * from public.audit_events where event_type like 'team_access_%'")).rows.length, 5);
  await admin();
  await rejected(() => db.query('insert into public.team_access_requests(league_id,franchise_id,user_id,applicant_email,display_name) values($1,$2,$3,$4,$5)', [league, teamB, userA, 'applicant-a@example.invalid', 'Duplicate']), /one_pending_team_access_request/);
}));

test('approval links a dated assignment without rewriting imported history, and repeated approval grants nothing twice', () => isolated(async () => {
  const result = await approved(userA, teamA, managerA);
  assert.equal(result.status, 'approved'); assert.equal(result.manager_id, managerA); assert.equal(result.assigned_role, 'manager');
  assert.ok(result.assignment_id);
  await rejected(() => review(result.id), /no longer pending/);
  await asUser(userA);
  assert.equal(await canManage(teamA), true);
  assert.equal(await canManage(teamB), false);
  const membership = (await db.query('select role,active from public.league_memberships')).rows;
  assert.deepEqual(membership, [{ role: 'manager', active: true }]);
  await rejected(() => request(), /already exists/);
  await admin();
  assert.equal((await db.query('select * from public.manager_assignments where user_id=$1', [userA])).rows.length, 1);
  assert.deepEqual((await db.query('select user_id,effective_from,effective_to,historical_note from public.manager_assignments where id=$1', [historicalA])).rows[0], { user_id: null, effective_from: null, effective_to: null, historical_note: 'Imported identity; dates unknown' });
}));

test('competing primary approvals require an explicit co-manager decision and cannot claim another linked identity', () => isolated(async () => {
  await asUser(userA); const a = await request();
  await asUser(userB); const b = await request();
  await asUser(commissioner); const first = await review(a.id, 'approve', managerA);
  await rejected(() => review(b.id), /already has a primary manager/);
  await rejected(() => review(b.id, 'approve', managerA, 'co_manager'), /already linked to another/);
  assert.equal((await db.query<{ status: string }>('select status from public.team_access_requests where id=$1', [b.id])).rows[0].status, 'pending');
  const second = await review(b.id, 'approve', null, 'co_manager');
  assert.notEqual(second.manager_id, first.manager_id);
  assert.equal(second.assigned_role, 'co_manager');
  await asUser(userA); assert.equal(await canManage(teamA), true);
  await asUser(userB); assert.equal(await canManage(teamA), true);
  await asUser(commissioner);
  assert.equal((await db.query('select * from public.manager_assignments where franchise_id=$1 and user_id is not null and effective_to is null', [teamA])).rows.length, 2);
}));

test('franchise, commissioner, and persistent-manager identities cannot cross leagues or teams', () => isolated(async () => {
  await asUser(userA);
  await rejected(() => request(otherTeam), /not available/);
  const pending = await request();
  await asUser(otherCommissioner);
  assert.equal((await db.query('select * from public.team_access_requests')).rows.length, 0);
  await rejected(() => review(pending.id), /Commissioner access required/);
  await asUser(commissioner);
  await rejected(() => review(pending.id, 'approve', otherManager), /must already belong/);
  await rejected(() => review(pending.id, 'approve', managerB), /must already belong/);
  await rejected(() => review(pending.id, 'approve', null, 'commissioner'), /Choose manager or co_manager/);
  await rejected(() => review(pending.id, 'unknown'), /Choose approve or reject/);
  assert.equal((await db.query('select * from public.manager_assignments where user_id=$1', [userA])).rows.length, 0);
  assert.equal((await db.query('select * from public.league_memberships where user_id=$1', [userA])).rows.length, 0);
}));

test('revocation preserves co-managers and history while removing the former manager’s league-wide trade rights', () => isolated(async () => {
  const primary = await approved(userA, teamA, managerA);
  const co = await approved(userB, teamA, null, 'co_manager');
  await asUser(userB);
  await rejected(() => revoke(primary.assignment_id!), /Commissioner access required/);
  await asUser(commissioner);
  await rejected(() => revoke(primary.assignment_id!, ''), /revocation reason/);
  await revoke(primary.assignment_id!);
  await rejected(() => revoke(primary.assignment_id!), /already ended or cancelled/);
  await rejected(() => revoke(historicalA), /historical assignment/);
  await asUser(userA);
  assert.equal(await canManage(teamA), false);
  assert.deepEqual((await db.query('select role,active from public.league_memberships')).rows, [{ role: 'viewer', active: true }]);
  await rejected(logTrade, /Current league manager access/);
  await asUser(userB); assert.equal(await canManage(teamA), true);
  await asUser(commissioner);
  const coRow = (await db.query<{ effective_to: string | null }>('select effective_to from public.manager_assignments where id=$1', [co.assignment_id])).rows[0];
  assert.equal(coRow.effective_to, null);
  assert.equal((await db.query('select * from public.manager_assignments where id=$1', [primary.assignment_id])).rows.length, 1, 'Revocation never deletes ownership history');
  assert.equal((await db.query("select * from public.audit_events where event_type='team_access_revoked'")).rows.length, 1);
}));

test('remaining active and future assignments preserve membership; cancelling the last future interval grants no scheduled access', () => isolated(async () => {
  const a = await approved(userA, teamA, managerA);
  const b = await approved(userA, teamB, managerB);
  await asUser(commissioner); await revoke(a.assignment_id!);
  await asUser(userA);
  assert.equal(await canManage(teamA), false); assert.equal(await canManage(teamB), true);
  assert.equal((await db.query<{ role: string }>('select role from public.league_memberships')).rows[0].role, 'manager');
  await admin();
  await db.query("update public.manager_assignments set effective_from=now()+interval '7 days' where id=$1", [b.assignment_id]);
  const future = (await db.query<{ effective_from: Date }>('select effective_from from public.manager_assignments where id=$1', [b.assignment_id])).rows[0].effective_from;
  await asUser(userA); assert.equal(await canManage(teamB), false);
  await rejected(() => request(teamB), /already exists/);
  await asUser(commissioner); await revoke(b.assignment_id!);
  const ended = (await db.query<{ effective_from: Date; effective_to: Date }>('select effective_from,effective_to from public.manager_assignments where id=$1', [b.assignment_id])).rows[0];
  assert.deepEqual(ended.effective_from, future); assert.deepEqual(ended.effective_to, future);
  await asUser(userA);
  assert.equal((await db.query<{ role: string }>('select role from public.league_memberships')).rows[0].role, 'viewer');
  assert.equal(await canManage(teamB), false);
  assert.equal((await request(teamB)).status, 'pending', 'Cancelled empty intervals do not block a new request');
}));

test('commissioner authority survives linking and revocation; inactive commissioner authority cannot be silently reactivated', () => isolated(async () => {
  await asUser(commissioner); const own = await request(); const linked = await review(own.id);
  assert.equal((await db.query<{ role: string }>('select role from public.league_memberships where user_id=$1', [commissioner])).rows[0].role, 'commissioner');
  await revoke(linked.assignment_id!);
  assert.equal((await db.query<{ role: string }>('select role from public.league_memberships where user_id=$1', [commissioner])).rows[0].role, 'commissioner');
  await admin();
  await db.query("insert into public.league_memberships(league_id,user_id,role,active) values($1,$2,'commissioner',false)", [league, userC]);
  await asUser(userC); const pending = await request(teamB);
  await asUser(commissioner);
  await rejected(() => review(pending.id), /inactive commissioner membership/);
  assert.equal((await db.query<{ active: boolean }>('select active from public.league_memberships where user_id=$1', [userC])).rows[0].active, false);
}));

test('approval does not silently reactivate unrelated assignments from an inactive membership', () => isolated(async () => {
  const previous = await approved(userA, teamA, managerA);
  await admin(); await db.query('update public.league_memberships set active=false where user_id=$1', [userA]);
  await asUser(userA); const pending = await request(teamB);
  await asUser(commissioner);
  await rejected(() => review(pending.id, 'approve', managerB), /inactive account's existing assignments/);
  await revoke(previous.assignment_id!);
  const granted = await review(pending.id, 'approve', managerB);
  assert.equal(granted.status, 'approved');
  await asUser(userA);
  assert.equal(await canManage(teamA), false); assert.equal(await canManage(teamB), true);
}));

test('an assignment added after a request is detected again at approval, without partial grants', () => isolated(async () => {
  await asUser(userA); const pending = await request();
  await admin();
  await db.query("insert into public.league_memberships(league_id,user_id,role) values($1,$2,'manager')", [league, userA]);
  await db.query("insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values($1,$2,$3,$4,now()+interval '1 day')", [league, teamA, managerA, userA]);
  await asUser(commissioner);
  await rejected(() => review(pending.id), /already exists/);
  assert.equal((await db.query<{ status: string }>('select status from public.team_access_requests where id=$1', [pending.id])).rows[0].status, 'pending');
  assert.equal((await db.query('select * from public.manager_assignments where user_id=$1', [userA])).rows.length, 1);
}));

test('future-only assignments retain membership but cannot log or read pending trades before their start', () => isolated(async () => {
  const current = await approved(userA, teamA, managerA);
  const scheduled = await approved(userA, teamB, managerB);
  await asUser(userA); await logTrade();
  assert.equal((await db.query('select * from public.trades')).rows.length, 1);
  await admin(); await db.query("update public.manager_assignments set effective_from=now()+interval '7 days' where id=$1", [scheduled.assignment_id]);
  await asUser(commissioner); await revoke(current.assignment_id!);
  await asUser(userA);
  assert.equal((await db.query<{ role: string }>('select role from public.league_memberships')).rows[0].role, 'manager');
  assert.equal(await canManage(teamA), false); assert.equal(await canManage(teamB), false);
  await rejected(logTrade, /Current league manager access/);
  assert.equal((await db.query('select * from public.trades')).rows.length, 0);
  assert.equal((await db.query('select * from public.trade_obligations')).rows.length, 0);
  await asUser(commissioner); assert.equal((await db.query('select * from public.trades')).rows.length, 1);
  await admin(); await db.query("update public.manager_assignments set effective_from=now()-interval '1 hour' where id=$1", [scheduled.assignment_id]);
  await asUser(userA); assert.equal(await canManage(teamB), true);
  assert.equal((await db.query('select * from public.trades')).rows.length, 1);
  await logTrade();
  assert.equal((await db.query('select * from public.trades')).rows.length, 2);
}));
