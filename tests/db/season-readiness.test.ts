import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { seasonReadinessSchema, type SeasonReadiness } from '../../src/lib/season-readiness';

const db = new PGlite();
const commissioner = '70000000-0000-4000-8000-000000000001', owner = '70000000-0000-4000-8000-000000000002', coManager = '70000000-0000-4000-8000-000000000003', outsider = '70000000-0000-4000-8000-000000000004';
let league: string, season: string, teams: string[], managers: string[];
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
  teams = (await db.query<{ id: string }>('select id from public.franchises order by id')).rows.map(r => r.id);
  managers = (await db.query<{ id: string }>('select id from public.managers order by id')).rows.map(r => r.id);
  await db.query('insert into auth.users(id,email) values($1,$5),($2,$5),($3,$5),($4,$5)', [commissioner, owner, coManager, outsider, 'private@example.invalid']);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true),($1,$4,'manager',true)", [league, commissioner, owner, coManager]);
  await db.query("insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,role,effective_from) values($1,$2,$3,$4,'manager','2020-01-01'),($1,$2,$3,$5,'co_manager','2020-01-01')", [league, teams[0], managers[0], owner, coManager]);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']);
  await db.exec(`set local role ${role}`);
}
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); }
}
async function readiness(): Promise<SeasonReadiness> { return seasonReadinessSchema.parse((await db.query<{ value: unknown }>('select public.get_season_readiness($1) as value', [season])).rows[0].value); }
async function schedule(revision: number | null, deadline: string | null = '2020-01-01T18:00:00Z', draft: string | null = '2020-01-02T18:00:00Z', zone: string | null = 'America/New_York') {
  return (await db.query<{ value: { schedule_revision: number; phase: string } }>('select public.update_schedule($1,$2,$3,$4,$5,$6) as value', [season, revision, deadline, draft, zone, 'Commissioner verified the published times.'])).rows[0].value;
}

test('readiness includes every team and hides private counts from managers, strangers and anonymous visitors', () => isolated(async () => {
  for (const user of [owner, coManager, outsider]) { await asUser(user); await rejects(readiness, /Commissioner access required/); }
  await asUser(null, 'anon'); await rejects(readiness, /permission denied/);
  await asUser(outsider);
  await db.query('select public.request_team_access($1,$2,$3)', [teams[1], 'Applicant', 'Private request note']);
  await asUser(commissioner);
  const value = await readiness();
  assert.equal(value.teams.length, 8); assert.equal(value.registeredCount, 8);
  assert.equal(value.teams.every(t => t.status === 'missing' && t.revision === null), true);
  assert.equal(value.teams.find(t => t.franchiseId === teams[0])?.activeManagerCount, 2);
  assert.equal(value.teams.find(t => t.franchiseId === teams[1])?.pendingAccessCount, 1);
  assert.equal(value.teams.reduce((sum, t) => sum + t.playerCount, 0), 111);
  assert.equal(value.hasFrozenSnapshot, true);
  assert.equal(value.keeperDeadline, null); assert.equal(value.draftAt, null); assert.equal(value.seasonTimeZone, null);
  assert.doesNotMatch(JSON.stringify(value), /private@example|Private request note|player_id|assignments|review_note|user_id/);
}));

test('readiness preserves traded holdings and detects incomplete original inventories and missing profiles', () => isolated(async () => {
  await asUser(commissioner);
  let value = await readiness();
  assert.equal(value.inventoryComplete, true); assert.equal(value.totalPickCount, 104); assert.equal(value.expectedTotalPickCount, 104);
  assert.equal(value.teams.every(t => t.originalPickCount === 13), true);
  assert.equal(value.teams.some(t => t.pickCount !== t.expectedPickCount), true);
  await db.exec('reset role');
  await db.exec('delete from public.draft_picks where id=(select id from public.draft_picks limit 1)');
  await db.exec('delete from public.keeper_profiles where player_id=(select player_id from public.keeper_profiles limit 1)');
  await asUser(commissioner); value = await readiness();
  assert.equal(value.inventoryComplete, false); assert.equal(value.totalPickCount, 103);
  assert.equal(value.teams.reduce((sum, t) => sum + t.profileCounts.missing, 0), 1);
  assert.equal(value.teams.reduce((sum, t) => sum + Object.values(t.profileCounts).reduce((a, b) => a + b, 0), 0), 111);
}));

test('schedule changes require commissioner authority, valid values and current revisions, and are audited without auto-locking', () => isolated(async () => {
  await asUser(owner); await rejects(() => schedule(0), /Commissioner access required/);
  await asUser(commissioner);
  await rejects(() => schedule(null), /schedule changed/);
  await rejects(() => schedule(0, '2020-01-03', '2020-01-02'), /draft cannot/);
  await rejects(() => schedule(0, 'infinity'), /finite dates/);
  await rejects(() => schedule(0, undefined, undefined, 'Mars/Olympus'), /IANA timezone/);
  await rejects(() => schedule(0, undefined, undefined, null), /timezone before/);
  const saved = await schedule(0); assert.equal(saved.schedule_revision, 1); assert.equal(saved.phase, 'setup');
  await rejects(() => schedule(0), /schedule changed/);
  const audit = (await db.query<{ detail: { previous: { keeper_deadline: null }; updated: { schedule_revision: number } } }>("select detail from public.audit_events where event_type='season_schedule_updated'")).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].detail.previous.keeper_deadline, null); assert.equal(audit[0].detail.updated.schedule_revision, 1);
  await db.query('select public.open_keeper_selection($1,$2)', [season, 'Verified season setup.']);
  await asUser(owner);
  await db.query('select public.save_keeper_submission($1,$2,0,$3::jsonb)', [season, teams[0], '[]']);
  await asUser(commissioner);
  assert.equal((await readiness()).teams.find(t => t.franchiseId === teams[0])?.status, 'draft');
  await schedule(1, null, null, null);
  assert.equal((await readiness()).keeperDeadline, null);
}));

test('empty keeper submissions progress through readiness and reveal only after the final lock', () => isolated(async () => {
  await asUser(commissioner);
  await db.query('select public.open_keeper_selection($1,$2)', [season, 'Verified season setup.']);
  for (const [index, team] of teams.entries()) {
    const saved = (await db.query<{ value: { id: string } }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, team, '[]'])).rows[0].value;
    for (const action of ['submit', 'approve', 'lock']) await db.query('select public.transition_keeper_submission($1,1,$2,null)', [saved.id, action]);
    const value = await readiness();
    assert.equal(value.teams.find(t => t.franchiseId === team)?.status, 'locked');
    if (index < teams.length - 1) { assert.equal(value.keepersRevealedAt, null); assert.equal(value.teams.filter(t => t.status === 'missing').length, teams.length - index - 1); }
    else { assert.ok(value.keepersRevealedAt); assert.equal(value.phase, 'draft_ready'); }
  }
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length, 0);
}));

test('an assignment ended after a transaction began cannot retain keeper access through the transaction clock', () => isolated(async () => {
  await db.query("update public.seasons set phase='keeper_selection' where id=$1", [season]);
  // Keep the membership active: another team assignment must not preserve access to this team.
  await db.query("insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values($1,$2,$3,$4,'2020-01-01')", [league, teams[1], managers[0], owner]);
  await db.exec('select pg_sleep(0.01)');
  await db.query('update public.manager_assignments set effective_to=clock_timestamp() where user_id=$1 and franchise_id=$2', [owner, teams[0]]);
  await asUser(owner);
  await rejects(() => db.query('select public.save_keeper_submission($1,$2,0,$3::jsonb)', [season, teams[0], '[]']), /Only an assigned manager/);
}));
