import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uuid = (n: number) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = '4bda6ccb-0b37-47b2-8d9e-fe452603738d', season = uuid(2), rules = uuid(3), snapshot = uuid(4), a = uuid(10), b = uuid(11);
const owner = uuid(20), otherOwner = uuid(21), commissioner = uuid(22), coOwner = uuid(23);
const pick = (team: 'a' | 'b', round: number) => uuid((team === 'a' ? 100 : 200) + round);
type Submission = { id: string; revision: number; status: string; [key: string]: unknown };
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users(id) values('${owner}'),('${otherOwner}'),('${commissioner}'),('${coOwner}');
    insert into public.leagues(id,slug,name) values('${league}','payment-test','Payment Test');
    insert into public.league_memberships values('${league}','${owner}','manager',true),('${league}','${otherOwner}','manager',true),('${league}','${commissioner}','commissioner',true),('${league}','${coOwner}','manager',true);
    insert into public.franchises(id,league_id,name) values('${a}','${league}','A'),('${b}','${league}','B');
    insert into public.managers(id,league_id,display_name) values('${owner}','${league}','A'),('${otherOwner}','${league}','B'),('${coOwner}','${league}','Co-A');
    insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values('${league}','${a}','${owner}','${owner}','2020-01-01'),('${league}','${b}','${otherOwner}','${otherOwner}','2020-01-01'),('${league}','${a}','${coOwner}','${coOwner}','2020-01-01');
    insert into public.rule_versions(id,league_id,version) values('${rules}','${league}',1);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count,phase) values('${season}','${league}','2026-27',2026,'${rules}',2,'keeper_selection');
    insert into public.season_teams(season_id,franchise_id,league_id,display_name,draft_position) values('${season}','${a}','${league}','A',1),('${season}','${b}','${league}','B',2);
    insert into public.players(id,full_name) values(101,'One'),(102,'Two'),(103,'Three');
    insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,scoring_period,source_sha256) values('${snapshot}','${league}','${season}','2026-03-29',160,repeat('a',64));
    insert into public.roster_entries values('${snapshot}','${season}','${a}',101,0,'/test',null,null),('${snapshot}','${season}','${a}',102,0,'/test',null,null),('${snapshot}','${season}','${b}',103,0,'/test',null,null);
    update public.roster_snapshots set frozen_at=now() where id='${snapshot}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id) values('${season}',101,'${a}','${snapshot}'),('${season}',102,'${a}','${snapshot}'),('${season}',103,'${b}','${snapshot}');
    insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation) values('${season}',101,'${league}','${rules}',5,1,'confirmed','Test'),('${season}',102,'${league}','${rules}',5,2,'confirmed','Test'),('${season}',103,'${league}','${rules}',5,1,'confirmed','Test');
    insert into public.draft_player_catalog values(201,'Draft player',true,repeat('a',64),2027);`);
  for (const team of ['a', 'b'] as const) for (let round = 1; round <= 13; round++) await db.query('insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round) values($1,$2,$3,$3,$4)', [pick(team, round), season, team === 'a' ? a : b, round]);
  await db.query("update public.seasons set keeper_deadline=now()+interval '1 day',season_time_zone='America/New_York' where id=$1", [season]);
  await db.query('select private.apply_keeper_deadline_payment_rule_20261014()');
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function user(id = commissioner, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]); await db.exec(`set local role ${role}`); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
const assignment = (player_id: number, pick_id: string) => ({ player_id, pick_id });
const initialA = () => [assignment(101, pick('a', 5)), assignment(102, pick('a', 4))];
const swappedA = () => [assignment(101, pick('a', 4)), assignment(102, pick('a', 5))];
async function official(team: string, assignments: ReturnType<typeof assignment>[], status: 'submitted' | 'approved' | 'locked' = 'submitted') {
  await user(team === a ? owner : otherOwner);
  const saved = (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, team, JSON.stringify(assignments)])).rows[0].value;
  await db.query("select public.transition_keeper_submission($1,1,'submit',null)", [saved.id]);
  if (status !== 'submitted') { await user(); await db.query("select public.transition_keeper_submission($1,1,'approve',null)", [saved.id]); }
  if (status === 'locked') await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [saved.id]);
  return (await db.query<Submission>('select * from public.keeper_submissions where id=$1', [saved.id])).rows[0];
}
async function amend(k: Submission, assignments = swappedA(), note = 'Payment picks agreed after the deadline.') {
  return (await db.query<{ value: Submission }>('select public.reassign_keeper_payments($1,$2,$3::jsonb,$4) as value', [k.id, k.revision, JSON.stringify(assignments), note])).rows[0].value;
}
async function deadlinePassed() { await db.exec('reset role'); await db.query("update public.seasons set keeper_deadline=now()-interval '1 minute',season_time_zone='America/New_York' where id=$1", [season]); }
async function assignments(id: string) { return (await db.query<Record<string, unknown>>('select * from public.keeper_assignments where submission_id=$1 order by player_id', [id])).rows; }
async function state() {
  await db.exec('reset role');
  return { picks: (await db.query('select * from public.draft_picks order by id')).rows, keepers: (await db.query('select * from public.keeper_submissions order by id')).rows,
    assignments: (await db.query('select * from public.keeper_assignments order by id')).rows, records: (await db.query('select * from public.keeper_season_records order by player_id')).rows,
    seasons: (await db.query('select * from public.seasons order by id')).rows, audit: (await db.query('select * from public.audit_events order by id')).rows,
    deadline: (await db.query('select * from public.keeper_payment_deadline_snapshots order by season_id')).rows, inventory: (await db.query('select * from public.keeper_deadline_pick_owners order by pick_id')).rows, amendments: (await db.query('select * from public.keeper_payment_amendments order by id')).rows, trades: (await db.query('select * from public.trades order by id')).rows };
}
async function trade(fromA = pick('a', 5), fromB = pick('b', 5), mature = true) {
  await user();
  const transfers = [{ pick_id: fromA, from_franchise_id: a, to_franchise_id: b }, { pick_id: fromB, from_franchise_id: b, to_franchise_id: a }];
  const id = (await db.query<{ value: string }>("select public.create_trade($1,'advanced','Audited pick swap','[]',$2::jsonb,'[]') as value", [season, JSON.stringify(transfers)])).rows[0].value;
  if (mature) { await db.exec('reset role'); await db.query("update public.trades set created_at=now()-interval '25 hours',review_deadline=now()-interval '1 hour' where id=$1", [id]); await user(); }
  return id;
}
const change = (k: Submission, rows: ReturnType<typeof assignment>[]) => ({ submission_id: k.id, expected_revision: k.revision, assignments: rows });
async function finalize(id: string, changes: ReturnType<typeof change>[] = [], note: string | null = null, override = false) {
  return db.query('select public.finalize_trade($1,$2::jsonb,$3,$4)', [id, JSON.stringify(changes), note, override]);
}

test('the charter creates an immutable version without changing costs, and adoption is idempotent', () => isolated(async () => {
  const current = (await db.query<{ rule_version_id: string }>('select rule_version_id from public.seasons where id=$1', [season])).rows[0].rule_version_id;
  assert.notEqual(current, rules);
  assert.equal((await db.query<{ timing: string }>("select rules->>'keeper_payment_timing' timing from public.rule_versions where id=$1", [current])).rows[0].timing, 'deadline_after_all_submissions');
  assert.equal((await db.query('select id from public.rule_versions where id=$1', [rules])).rows.length, 1);
  assert.equal((await db.query<{ value: { adopted: number } }>('select private.apply_keeper_deadline_payment_rule_20261014() value')).rows[0].value.adopted, 0);
  assert.ok((await db.query<{ base_round: number; rule_version_id: string }>('select base_round,rule_version_id from public.keeper_profiles')).rows.every(row => row.base_round === 5 && row.rule_version_id === current));
}));

test('all submitted and approved before the deadline incur no reservations or keeper history', () => isolated(async () => {
  const ka = await official(a, initialA(), 'approved'); await official(b, [], 'approved');
  assert.ok((await assignments(ka.id)).every(row => !row.reserved));
  assert.equal((await db.query("select id from public.draft_picks where status='used'")).rows.length, 0);
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length, 0);
  await user(); await rejects(() => db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]), /before the configured keeper deadline/);
  assert.equal((await db.query<{ value: unknown }>('select public.get_keeper_payment_inventory($1) value', [season])).rows[0].value, null);
}));

test('the deadline alone cannot commit payments before every team submits', () => isolated(async () => {
  const ka = await official(a, initialA()); await deadlinePassed(); await user();
  await db.query("select public.transition_keeper_submission($1,1,'approve',null)", [ka.id]);
  assert.ok((await assignments(ka.id)).every(row => !row.reserved));
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]), /Every participating team must submit/);
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length, 0);
}));

test('after both gates, locking uses deadline-owned picks and frozen nominal terms', () => isolated(async () => {
  const ka = await official(a, initialA(), 'approved'), kb = await official(b, [], 'approved');
  await db.exec('reset role'); await db.query('update public.keeper_profiles set base_round=2,tenure_years=3 where player_id=101');
  await deadlinePassed(); await user();
  await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]);
  await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [kb.id]);
  const records = (await db.query<{ player_id: number; base_round: number; actual_payment_round: number; tenure_before: number }>('select * from public.keeper_season_records order by player_id')).rows;
  assert.deepEqual(records.map(row => [row.player_id, row.base_round, row.actual_payment_round, row.tenure_before]), [[101, 5, 5, 1], [102, 5, 4, 2]]);
  assert.equal((await db.query('select * from public.keeper_deadline_pick_owners')).rows.length, 26);
  assert.equal((await db.query("select id from public.draft_picks where status='used'")).rows.length, 2);
  assert.ok((await assignments(ka.id)).every(row => row.reserved));
}));

test('predeadline approved preview picks trade without amendments; incoming picks join deadline inventory', () => isolated(async () => {
  const ka = await official(a, [assignment(101, pick('a', 5))], 'approved');
  const id = await trade(); await finalize(id);
  assert.equal((await assignments(ka.id))[0].pick_id, pick('a', 5));
  assert.equal((await assignments(ka.id))[0].reserved, false);
  await official(b, [], 'approved'); await deadlinePassed(); await user(owner);
  const amended = await amend(ka, [assignment(101, pick('b', 5))]); assert.equal(amended.status, 'approved');
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.keeper_deadline_pick_owners where pick_id=$1', [pick('b', 5)])).rows[0].franchise_id, a);
  await user(); await db.query("select public.transition_keeper_submission($1,2,'lock',null)", [ka.id]);
}));

test('predeadline keeper-player trades return the prior official submission for editing', () => isolated(async () => {
  const ka = await official(a, [assignment(101, pick('a', 5))], 'approved'); await user();
  const transfer = JSON.stringify([{ player_id: 101, from_franchise_id: a, to_franchise_id: b }]);
  const id = (await db.query<{ value: string }>("select public.create_trade($1,'player_only','Predeadline keeper trade',$2::jsonb,'[]','[]') value", [season, transfer])).rows[0].value;
  await finalize(id, [], 'Commissioner authorizes this predeadline trade.', true);
  assert.equal((await db.query<Submission>('select * from public.keeper_submissions where id=$1', [ka.id])).rows[0].status, 'rejected');
  assert.equal((await assignments(ka.id))[0].reserved, false);
  assert.equal((await db.query('select * from public.audit_events where event_type=$1', ['keeper_returned_after_player_trade'])).rows.length, 1);
}));

test('first postdeadline trade captures old ownership; newly acquired picks cannot pay keepers', () => isolated(async () => {
  const ka = await official(a, [assignment(101, pick('a', 5))]); await official(b, [], 'approved');
  const id = await trade(pick('a', 13), pick('b', 5)); await deadlinePassed(); await user(); await finalize(id);
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.keeper_deadline_pick_owners where pick_id=$1', [pick('b', 5)])).rows[0].franchise_id, b);
  const before = await state(); await user(owner);
  await rejects(() => amend(ka, [assignment(101, pick('b', 5))]), /owned by this team at the keeper deadline/);
  assert.deepEqual(await state(), before);
  await user(); await db.query("select public.transition_keeper_submission($1,1,'approve',null)", [ka.id]);
  assert.equal((await assignments(ka.id))[0].pick_id, pick('a', 5));
}));

test('a later-round pick acquired after deadline never forces replacement of a legal deadline payment', () => isolated(async () => {
  await db.query('update public.draft_picks set current_owner_id=$1 where id=$2', [b, pick('a', 5)]);
  const ka = await official(a, [assignment(101, pick('a', 4))], 'approved'); await official(b, [], 'approved');
  await deadlinePassed(); await user(); await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]);
  const id = await trade(pick('a', 13), pick('b', 5)); await finalize(id);
  assert.equal((await assignments(ka.id))[0].pick_id, pick('a', 4));
}));

test('inventory getter follows public league access, is idempotent and selection-free; passed deadline cannot move', () => isolated(async () => {
  await deadlinePassed(); await user(owner);
  const first = (await db.query<{ value: Record<string, unknown> }>('select public.get_keeper_payment_inventory($1) value', [season])).rows[0].value;
  const next = (await db.query<{ value: Record<string, unknown> }>('select public.get_keeper_payment_inventory($1) value', [season])).rows[0].value;
  assert.deepEqual(first, next); assert.deepEqual(Object.keys(first).sort(), ['capturedAt', 'deadline', 'picks']);
  assert.equal((first.picks as unknown[]).length, 26); assert.ok(!JSON.stringify(first).includes('player'));
  await user(); await rejects(() => db.query("select public.update_schedule($1,0,now()+interval '1 day',null,'America/New_York','Move deadline after capture')", [season]), /deadline is fixed/);
  await db.exec('reset role'); await rejects(() => db.query('delete from public.keeper_deadline_pick_owners'), /immutable/);
  await user('', 'anon');
  assert.deepEqual((await db.query<{ value: unknown }>('select public.get_keeper_payment_inventory($1) value', [season])).rows[0].value, first);
  await db.exec('reset role'); await db.query('update public.leagues set is_public=false where id=$1', [league]);
  await user('', 'anon'); await rejects(() => db.query('select public.get_keeper_payment_inventory($1)', [season]), /League access required/);
  await user(uuid(999)); await rejects(() => db.query('select public.get_keeper_payment_inventory($1)', [season]), /League access required/);
  await user(owner);
  assert.deepEqual((await db.query<{ value: unknown }>('select public.get_keeper_payment_inventory($1) value', [season])).rows[0].value, first);
}));

test('locking automatically replaces a traded preview from deadline-owned inventory and audits frozen terms', () => isolated(async () => {
  const ka = await official(a, initialA(), 'approved'); await official(b, [], 'approved');
  const id = await trade(pick('a', 5), pick('b', 5)); await finalize(id);
  await deadlinePassed(); await user();
  const result = (await db.query<{ value: Submission }>("select public.transition_keeper_submission($1,1,'lock',null) value", [ka.id])).rows[0].value;
  assert.equal(result.status, 'locked'); assert.equal(result.revision, 2);
  const rows = await assignments(ka.id);
  assert.deepEqual(rows.map(row => row.pick_id), [pick('b', 5), pick('a', 4)]);
  assert.ok(rows.every(row => row.reserved && row.base_round_at_submission === 5));
  assert.deepEqual(rows.map(row => row.tenure_at_submission), [1, 2]);
  const amendments = (await db.query<{ reason: string; previous_revision: number; revision: number }>('select * from public.keeper_payment_amendments where submission_id=$1', [ka.id])).rows;
  assert.equal(amendments.length, 1); assert.match(amendments[0].reason, /Automatically allocated/);
  assert.equal(amendments[0].previous_revision, 1); assert.equal(amendments[0].revision, 2);
}));

test('automatic settlement fails atomically when the deadline inventory cannot fund the full keeper set', () => isolated(async () => {
  const ka = await official(a, initialA(), 'approved'); await official(b, [], 'approved');
  await db.exec('reset role');
  await db.query('update public.draft_picks set current_owner_id=$1 where season_id=$2 and current_owner_id=$3 and round<=5', [b, season, a]);
  await deadlinePassed(); const before = await state(); await user();
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]), /cannot fund every submitted keeper/);
  assert.deepEqual(await state(), before);
}));

test('a paid keeper pick trades only with an atomic replacement from its original deadline inventory', () => isolated(async () => {
  const ka = await official(a, [assignment(101, pick('a', 5))], 'approved'); const kb = await official(b, [], 'approved');
  await deadlinePassed(); await user();
  await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [ka.id]);
  await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [kb.id]);
  const id = await trade(pick('a', 5), pick('b', 5));
  await rejects(() => finalize(id), /no longer available/);
  const before = await state(); await user();
  await rejects(() => finalize(id, [change(ka, [assignment(101, pick('b', 5))])], 'The incoming pick was not in the deadline budget.'), /owned by this team at the keeper deadline/);
  assert.deepEqual(await state(), before); await user();
  await finalize(id, [change(ka, [assignment(101, pick('a', 4))])], 'Replace the paid pick with the next eligible deadline pick.');
  const record = (await db.query<{ pick_id: string; actual_payment_round: number; base_round: number; tenure_before: number }>('select * from public.keeper_season_records where player_id=101')).rows[0];
  assert.equal(record.pick_id, pick('a', 4)); assert.equal(record.actual_payment_round, 4);
  assert.equal(record.base_round, 5); assert.equal(record.tenure_before, 1);
  assert.equal((await db.query<{ status: string }>('select status from public.draft_picks where id=$1', [pick('a', 4)])).rows[0].status, 'used');
  assert.equal((await db.query<{ current_owner_id: string; status: string }>('select current_owner_id,status from public.draft_picks where id=$1', [pick('a', 5)])).rows[0].current_owner_id, b);
}));
