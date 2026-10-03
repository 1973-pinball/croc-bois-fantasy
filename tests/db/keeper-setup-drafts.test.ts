import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const commissioner = '72000000-0000-4000-8000-000000000001', owner = '72000000-0000-4000-8000-000000000002';
const coManager = '72000000-0000-4000-8000-000000000003', otherOwner = '72000000-0000-4000-8000-000000000004';
const unassigned = '72000000-0000-4000-8000-000000000005', outsider = '72000000-0000-4000-8000-000000000006';
let league: string, season: string, teams: string[];
type Assignment = { player_id: number; pick_id: string };
type Submission = { id: string; revision: number; status: string };
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8'));
  ({ id: league } = (await db.query<{ id: string }>('select id from public.leagues')).rows[0]);
  ({ id: season } = (await db.query<{ id: string }>('select id from public.seasons')).rows[0]);
  teams = (await db.query<{ id: string }>('select id from public.franchises order by espn_team_id')).rows.map(r => r.id);
  const managers = (await db.query<{ id: string }>('select id from public.managers order by id')).rows.map(r => r.id);
  for (const user of [commissioner, owner, coManager, otherOwner, unassigned, outsider]) await db.query('insert into auth.users(id) values($1)', [user]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true),($1,$4,'manager',true),($1,$5,'manager',true),($1,$6,'manager',true)", [league, commissioner, owner, coManager, otherOwner, unassigned]);
  await db.query(`insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,role,effective_from)
    values($1,$2,$4,$6,'manager','2020-01-01'),($1,$2,$4,$7,'co_manager','2020-01-01'),($1,$3,$5,$8,'manager','2020-01-01')`, [league, teams[0], teams[1], managers[0], managers[1], owner, coManager, otherOwner]);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') {
  await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']); await db.exec(`set local role ${role}`);
}
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint rejected'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejected'); }
}
async function candidate(team = teams[0]): Promise<Assignment> {
  return (await db.query<Assignment>(`select kp.player_id,p.id as pick_id from public.keeper_profiles kp
    join public.player_ownerships o on o.season_id=kp.season_id and o.player_id=kp.player_id
    join public.draft_picks p on p.season_id=kp.season_id and p.current_owner_id=o.franchise_id and p.round=kp.base_round
    where kp.season_id=$1 and o.franchise_id=$2 and kp.verification='confirmed' and kp.tenure_years<5 limit 1`, [season, team])).rows[0];
}
async function save(assignments: Assignment[], revision: number | null = 0, team = teams[0]): Promise<Submission> {
  return (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,$3,$4::jsonb) as value', [season, team, revision, JSON.stringify(assignments)])).rows[0].value;
}

test('owners save private setup drafts without submitting, reserving picks, opening trading, or publishing selections', () => isolated(async () => {
  const assignment = await candidate();
  await asUser(owner); const saved = await save([assignment]);
  assert.equal(saved.status, 'draft'); assert.equal(saved.revision, 1);
  assert.equal((await db.query('select id from public.keeper_submissions')).rows.length, 1);
  assert.equal((await db.query<{ reserved: boolean }>('select reserved from public.keeper_assignments')).rows[0].reserved, false);
  for (const user of [otherOwner, unassigned, outsider]) {
    await asUser(user);
    assert.equal((await db.query('select id from public.keeper_submissions')).rows.length, 0);
    assert.equal((await db.query('select id from public.keeper_assignments')).rows.length, 0);
  }
  await asUser(null, 'anon');
  assert.equal((await db.query('select id from public.keeper_submissions')).rows.length, 0);
  const publicBoard = (await db.query<{ value: { picks: { playerId: number | null }[] } }>('select public.get_draft_board($1) as value', [season])).rows[0].value;
  assert.ok(publicBoard.picks.every(p => p.playerId === null));
  await asUser(coManager); assert.equal((await db.query('select id from public.keeper_submissions')).rows.length, 1);
  await asUser(commissioner); assert.equal((await db.query('select id from public.keeper_submissions')).rows.length, 1);
  assert.equal((await db.query("select id from public.audit_events where event_type='keeper_draft_saved'")).rows.length, 1);
  assert.equal((await db.query('select player_id from public.keeper_season_records')).rows.length, 0);
  assert.equal((await db.query<{ status: string }>('select status from public.draft_picks where id=$1', [assignment.pick_id])).rows[0].status, 'available');
  assert.deepEqual((await db.query('select phase,trading_opened_at,keepers_revealed_at from public.seasons where id=$1', [season])).rows[0], { phase: 'setup', trading_opened_at: null, keepers_revealed_at: null });
}));

test('all assigned owners and co-managers can save their team, while cross-team, unassigned, anonymous and revoked writes remain forbidden', () => isolated(async () => {
  const own = await candidate(), other = await candidate(teams[1]);
  for (const user of [otherOwner, unassigned, outsider]) { await asUser(user); await rejects(() => save([own]), /Only an assigned manager/); }
  await asUser(null, 'anon'); await rejects(() => save([own]), /permission denied/);
  await asUser(otherOwner); assert.equal((await save([other], 0, teams[1])).status, 'draft');
  await asUser(coManager); assert.equal((await save([own])).revision, 1);
  await asUser(owner); assert.equal((await save([], 1)).revision, 2);
  await db.exec('reset role'); await db.query('update public.manager_assignments set effective_to=clock_timestamp() where user_id=$1', [owner]);
  await asUser(owner); await rejects(() => save([own], 2), /Only an assigned manager/);
  await asUser(coManager); assert.equal((await save([own], 2)).revision, 3);
  await asUser(commissioner); assert.equal((await save([], 0, teams[2])).revision, 1);
}));

test('setup drafts retain optimistic revision protection and failed writes leave the current selection intact', () => isolated(async () => {
  const assignment = await candidate();
  await asUser(owner); await rejects(() => save([assignment], null), /Submission changed/);
  const initial = await save([assignment]);
  await asUser(coManager); const newer = await save([], 1);
  await asUser(owner); await rejects(() => save([assignment], initial.revision), /Submission changed/);
  await rejects(() => save([assignment], null), /Submission changed/);
  await rejects(() => save([assignment], -1), /Submission changed/);
  assert.deepEqual((await db.query('select id,revision from public.keeper_submissions where is_current')).rows[0], { id: newer.id, revision: 2 });
  assert.equal((await db.query('select id from public.keeper_assignments where submission_id=$1', [newer.id])).rows.length, 0);
  await asUser(commissioner); assert.equal((await db.query("select id from public.audit_events where event_type='keeper_draft_saved'")).rows.length, 2);
}));

test('official transitions stay blocked during setup and a saved private draft submits after explicit commissioner opening', () => isolated(async () => {
  const assignment = await candidate();
  await asUser(owner); const saved = await save([assignment]);
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'submit',null)", [saved.id]), /Keeper submission is locked/);
  await asUser(commissioner);
  for (const action of ['submit', 'approve', 'reject', 'lock']) await rejects(() => db.query('select public.transition_keeper_submission($1,1,$2,$3)', [saved.id, action, 'Reviewed setup fixture']), /Keeper submission is locked/);
  await db.query('select public.open_keeper_selection($1,$2)', [season, 'Commissioner checked the roster and picks.']);
  await asUser(owner);
  const result = (await db.query<{ value: Submission }>("select public.transition_keeper_submission($1,1,'submit',null) as value", [saved.id])).rows[0].value;
  assert.equal(result.id, saved.id); assert.equal(result.status, 'submitted'); assert.equal(result.revision, 1);
  assert.deepEqual((await db.query('select phase,trading_opened_at,keepers_revealed_at from public.seasons where id=$1', [season])).rows[0], { phase: 'keeper_selection', trading_opened_at: null, keepers_revealed_at: null });
}));

test('setup saving requires owned available picks and the frozen keeper pool, and remains closed after reveal or season progression', () => isolated(async () => {
  const assignment = await candidate(), other = await candidate(teams[1]);
  await asUser(owner);
  await rejects(() => save([{ ...assignment, player_id: other.player_id }]), /frozen keeper pool/);
  await rejects(() => save([{ ...assignment, pick_id: other.pick_id }]), /not available to this team/);
  await db.exec('reset role');
  const snapshot = '72000000-0000-4000-8000-000000000050';
  await db.query("insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,source_sha256) values($1,$2,$3,'2026-03-29',$4)", [snapshot, league, season, 'b'.repeat(64)]);
  await db.query("insert into public.roster_entries(snapshot_id,season_id,franchise_id,player_id,lineup_slot,source_pointer) values($1,$2,$3,$4,12,'/unfrozen-fixture')", [snapshot, season, teams[0], assignment.player_id]);
  await db.query('update public.player_ownerships set source_snapshot_id=$1 where season_id=$2 and player_id=$3', [snapshot, season, assignment.player_id]);
  await asUser(owner); await rejects(() => save([assignment]), /frozen keeper pool/);
  for (const phase of ['draft_ready', 'in_season', 'archived']) {
    await db.exec('reset role'); await db.query('update public.seasons set phase=$2 where id=$1', [season, phase]);
    await asUser(owner); await rejects(() => save([]), /Private keeper drafts can only be saved/);
  }
  await db.exec('reset role'); await db.query("update public.seasons set phase='setup',keepers_revealed_at=now() where id=$1", [season]);
  await asUser(owner); await rejects(() => save([]), /Private keeper drafts can only be saved/);
}));
