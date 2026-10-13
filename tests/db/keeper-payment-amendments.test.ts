import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uuid = (n: number) => `89000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = uuid(1), season = uuid(2), rules = uuid(3), snapshot = uuid(4), a = uuid(10), b = uuid(11);
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
    amendments: (await db.query('select * from public.keeper_payment_amendments order by id')).rows, trades: (await db.query('select * from public.trades order by id')).rows };
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

test('owners and co-managers change submitted payment picks after deadline without changing players, saved terms, status or timestamps', () => isolated(async () => {
  const k = await official(a, initialA()); const before = await assignments(k.id);
  await deadlinePassed(); await user(coOwner);
  const updated = await amend(k);
  const persisted = (await db.query<Submission>('select * from public.keeper_submissions where id=$1', [k.id])).rows[0];
  assert.deepEqual({ ...persisted, revision: 1 }, k); assert.equal(updated.revision, 2);
  const after = await assignments(k.id);
  assert.deepEqual(updated.keeper_assignments, after, 'Payment RPC includes authoritative frozen terms while the lock is held');
  assert.deepEqual(after.map(row => ({ ...row, pick_id: null })), before.map(row => ({ ...row, pick_id: null })));
  assert.deepEqual(after.map(row => row.pick_id), swappedA().map(row => row.pick_id));
  await rejects(() => amend(k), /Submission changed/);
  assert.equal((await db.query('select * from public.keeper_payment_amendments')).rows.length, 0, 'Private amendment audit is commissioner-only');
  await user(); assert.equal((await db.query('select * from public.keeper_payment_amendments')).rows.length, 1);
  assert.equal((await db.query<{ draft_revision: number }>('select draft_revision from public.seasons where id=$1', [season])).rows[0].draft_revision, 1);
}));

test('approved and locked payment changes preserve reservations without resetting approval or revealing early', () => isolated(async () => {
  const k = await official(a, initialA(), 'approved'); await user(owner);
  const amended = await amend(k); assert.equal(amended.status, 'approved'); assert.ok((await assignments(k.id)).every(row => row.reserved));
  await user(); await db.query("select public.transition_keeper_submission($1,2,'lock',null)", [k.id]);
  const locked = (await db.query<Submission>('select * from public.keeper_submissions where id=$1', [k.id])).rows[0];
  await deadlinePassed(); await user(owner); const changed = await amend(locked, initialA());
  assert.equal(changed.status, 'locked'); assert.equal(new Date(changed.locked_at as string).getTime(), new Date(locked.locked_at as string).getTime());
  assert.equal((await db.query<{ keepers_revealed_at: null }>('select keepers_revealed_at from public.seasons where id=$1', [season])).rows[0].keepers_revealed_at, null);
}));

test('revealed cyclic payment changes alter only payment fields and leave immutable audit-backed history', () => isolated(async () => {
  const k = await official(a, initialA(), 'locked'); await official(b, [assignment(103, pick('b', 5))], 'locked');
  const before = (await db.query<Record<string, unknown>>('select * from public.keeper_season_records where submission_id=$1 order by player_id', [k.id])).rows;
  await deadlinePassed(); await user(owner); await amend(k);
  const after = (await db.query<Record<string, unknown>>('select * from public.keeper_season_records where submission_id=$1 order by player_id', [k.id])).rows;
  const fixed = (row: Record<string, unknown>) => ({ ...row, pick_id: null, actual_payment_round: null });
  assert.deepEqual(after.map(fixed), before.map(fixed));
  assert.deepEqual(after.map(row => row.actual_payment_round), [4, 5]);
  await db.exec('reset role');
  await rejects(() => db.query('update public.keeper_season_records set base_round=1 where submission_id=$1', [k.id]), /immutable/);
  await rejects(() => db.query('delete from public.keeper_season_records where submission_id=$1', [k.id]), /immutable/);
  await rejects(() => db.query('update public.keeper_season_records set pick_id=$2,actual_payment_round=3 where submission_id=$1 and player_id=101', [k.id, pick('a', 3)]), /immutable/);
  await rejects(() => db.exec('delete from public.keeper_payment_amendments'), /immutable/);
  assert.ok((await db.query<{ status: string }>('select status from public.draft_picks where id in ($1,$2)', [pick('a', 4), pick('a', 5)])).rows.every(row => row.status === 'used'));
  await user('', 'anon'); assert.equal((await db.query('select * from public.keeper_assignments')).rows.length, 0);
  await rejects(() => db.query('select * from public.keeper_payment_amendments'), /permission denied/);
}));

test('payment authorization, required reason, frozen player list and stale/null revisions are enforced', () => isolated(async () => {
  const k = await official(a, initialA()); await user(otherOwner); await rejects(() => amend(k), /Only an assigned manager/);
  await user(owner); await rejects(() => amend(k, swappedA(), ' '), /reason/);
  await rejects(() => amend(k, [assignment(101, pick('a', 4))]), /exact submitted keeper players/);
  await rejects(() => amend(k, [assignment(101, pick('a', 4)), assignment(103, pick('a', 5))]), /submitted players/);
  await rejects(() => amend({ ...k, revision: null as unknown as number }), /Submission changed/);
  await db.exec('reset role'); await db.query("update public.manager_assignments set effective_to=now()-interval '1 hour' where user_id=$1", [owner]);
  await user(owner); await rejects(() => amend(k), /Only an assigned manager/);
  await user(); await amend(k);
}));

test('whole-set allocation rejects overpayment, wrong owners and wrong-season picks and preserves saved cost/tenure', () => isolated(async () => {
  const k = await official(a, [assignment(101, pick('a', 5))]); await user(owner);
  await rejects(() => amend(k, [assignment(101, pick('a', 4))]), /available round 5/);
  await rejects(() => amend(k, [assignment(101, pick('b', 5))]), /not available to this team/);
  await rejects(() => amend(k, [assignment(101, uuid(999))]), /not available to this team/);
  await db.exec('reset role'); await db.query('update public.draft_picks set current_owner_id=$1 where id=$2', [a, pick('b', 5)]);
  await db.query('update public.keeper_profiles set base_round=2,tenure_years=3 where player_id=101'); await user(owner);
  await amend(k, [assignment(101, pick('b', 5))]);
  const saved = (await assignments(k.id))[0]; assert.equal(saved.base_round_at_submission, 5); assert.equal(saved.tenure_at_submission, 1);
}));

test('deadline closes older save and submit paths while payment changes require an official submission', () => isolated(async () => {
  await user(owner); const draft = (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, a, JSON.stringify(initialA())])).rows[0].value;
  await deadlinePassed(); await user(owner);
  await rejects(() => db.query('select public.save_keeper_submission($1,$2,1,$3::jsonb)', [season, a, JSON.stringify(swappedA())]), /deadline has passed/);
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'submit',null)", [draft.id]), /deadline has passed/);
  await rejects(() => amend(draft), /Submit keepers before/);
}));

test('save and submit responses include assignments and freshly frozen payment metadata for same-session editors', () => isolated(async () => {
  await user(owner);
  const saved = (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, a, JSON.stringify(initialA())])).rows[0].value;
  assert.deepEqual(saved.keeper_assignments, await assignments(saved.id));
  const submitted = (await db.query<{ value: Submission }>("select public.transition_keeper_submission($1,1,'submit',null) as value", [saved.id])).rows[0].value;
  assert.deepEqual(submitted.keeper_assignments, await assignments(saved.id));
  assert.ok((submitted.keeper_assignments as Record<string, unknown>[]).every(row => row.base_round_at_submission === 5 && typeof row.tenure_at_submission === 'number'));
}));

test('direct keeper RPC calls reject null revisions and the deadline blocks returns while preserving approval and locking', () => isolated(async () => {
  await user(owner);
  await rejects(() => db.query('select public.save_keeper_submission($1,$2,null,$3::jsonb)', [season, a, JSON.stringify(initialA())]), /Submission changed/);
  const saved = (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, a, JSON.stringify(initialA())])).rows[0].value;
  await rejects(() => db.query("select public.transition_keeper_submission($1,null,'submit',null)", [saved.id]), /Submission changed/);
  await db.query("select public.transition_keeper_submission($1,1,'submit',null)", [saved.id]);
  await deadlinePassed(); await user();
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'reject','Fix requested payments')", [saved.id]), /use payment changes/);
  assert.equal((await db.query<Submission>('select * from public.keeper_submissions where id=$1', [saved.id])).rows[0].status, 'submitted');
  await db.query("select public.transition_keeper_submission($1,1,'approve',null)", [saved.id]);
  await rejects(() => db.query("select public.transition_keeper_submission($1,1,'reject','Fix requested payments')", [saved.id]), /use payment changes/);
  await db.query("select public.transition_keeper_submission($1,1,'lock',null)", [saved.id]);
  assert.equal((await db.query<Submission>('select * from public.keeper_submissions where id=$1', [saved.id])).rows[0].status, 'locked');
}));

for (const revealed of [false, true]) test(`atomic pick swap reassigns ${revealed ? 'revealed used' : 'approved reserved'} keeper payments across both teams`, () => isolated(async () => {
  const status = revealed ? 'locked' : 'approved';
  const ka = await official(a, [assignment(101, pick('a', 5))], status);
  const kb = await official(b, [assignment(103, pick('b', 5))], status);
  const id = await trade(); await rejects(() => db.query('select public.finalize_trade($1)', [id]), revealed ? /no longer available/ : /committed/);
  await finalize(id, [change(ka, [assignment(101, pick('b', 5))]), change(kb, [assignment(103, pick('a', 5))])], 'Swap payment picks with both keeper selections fixed.');
  assert.equal((await assignments(ka.id))[0].pick_id, pick('b', 5)); assert.equal((await assignments(kb.id))[0].pick_id, pick('a', 5));
  assert.equal((await db.query<{ draft_revision: number }>('select draft_revision from public.seasons where id=$1', [season])).rows[0].draft_revision, 1);
  assert.equal((await db.query('select * from public.keeper_payment_amendments where trade_id=$1', [id])).rows.length, 2);
  if (revealed) assert.equal((await db.query<{ pick_id: string }>('select pick_id from public.keeper_season_records where player_id=101')).rows[0].pick_id, pick('b', 5));
}));

test('incoming later-round pick requires a matching payment amendment in the same transaction', () => isolated(async () => {
  await db.query('update public.draft_picks set current_owner_id=$1 where id=$2', [b, pick('a', 5)]);
  const k = await official(a, [assignment(101, pick('a', 4))], 'approved'); const id = await trade(pick('a', 3), pick('b', 5));
  await rejects(() => finalize(id), /available round 5/);
  await finalize(id, [change(k, [assignment(101, pick('b', 5))])], 'Incoming round five becomes the legal keeper payment.');
  assert.equal((await assignments(k.id))[0].pick_id, pick('b', 5));
}));

test('an owner can repair an unreserved submitted payment after its old pick was traded away', () => isolated(async () => {
  const k = await official(a, [assignment(101, pick('a', 5))]); const id = await trade();
  await finalize(id); await deadlinePassed(); await user(owner);
  await amend(k, [assignment(101, pick('b', 5))]);
  assert.equal((await assignments(k.id))[0].pick_id, pick('b', 5));
  assert.equal((await db.query<{ current_owner_id: string }>('select current_owner_id from public.draft_picks where id=$1', [pick('a', 5)])).rows[0].current_owner_id, b);
}));

test('the post-deadline submitted player freeze also prevents trading away an unapproved keeper', () => isolated(async () => {
  await official(a, [assignment(101, pick('a', 5))]); await user();
  const id = (await db.query<{ value: string }>("select public.create_trade($1,'player_only','Proposed player transfer',$2::jsonb,'[]','[]') as value", [season, JSON.stringify([{ player_id: 101, from_franchise_id: a, to_franchise_id: b }])])).rows[0].value;
  await deadlinePassed(); await user();
  await rejects(() => finalize(id, [], 'Early review does not change frozen keeper players.', true), /Submitted keeper players are fixed/);
}));

test('invalid atomic replacement rolls back every pick, keeper, revision, history and audit record', () => isolated(async () => {
  const ka = await official(a, [assignment(101, pick('a', 5))], 'locked'); const kb = await official(b, [assignment(103, pick('b', 5))], 'locked');
  const id = await trade(); const before = await state(); await user();
  await rejects(() => finalize(id, [change(ka, [assignment(101, pick('b', 5))]), change(kb, [assignment(103, pick('b', 4))])], 'Invalid replacement must roll back both sides.'), /available round 5/);
  assert.deepEqual(await state(), before);
}));

test('commissioner early-review exception is explicit, reasoned and audited; normal and owner calls cannot bypass review', () => isolated(async () => {
  const id = await trade(pick('a', 13), pick('b', 13), false);
  await rejects(() => finalize(id), /24-hour/);
  await rejects(() => finalize(id, [], ' ', true), /override reason/);
  await user(owner); await rejects(() => finalize(id, [], 'Owners agreed to immediate execution.', true), /Commissioner access/);
  await user(); await finalize(id, [], 'Commissioner approved the requested early execution.', true);
  const audit = (await db.query<{ detail: { reason: string; finalizedEarly: boolean; reviewDeadline: string } }>("select detail from public.audit_events where event_type='trade_review_overridden' and entity_id=$1", [id])).rows[0].detail;
  assert.equal(audit.finalizedEarly, true); assert.ok(audit.reviewDeadline); assert.match(audit.reason, /Commissioner approved/);
}));

test('failed early trade never persists its override audit or asset changes', () => isolated(async () => {
  const id = await trade(pick('a', 13), pick('b', 13), false); await db.exec('reset role'); await db.query("update public.draft_picks set status='used' where id=$1", [pick('b', 13)]);
  const before = await state(); await user(); await rejects(() => finalize(id, [], 'Review override does not override spent assets.', true), /no longer available/);
  assert.deepEqual(await state(), before);
}));

test('any live draft history, including undone selections, and closed seasons block payment changes', () => isolated(async () => {
  const k = await official(a, initialA(), 'locked'); await official(b, [assignment(103, pick('b', 5))], 'locked');
  await user(); await db.query("select public.control_draft_clock($1,0,'start',null)", [season]);
  await rejects(() => amend(k), /draft has started/);
  await db.query("select public.update_draft_board($1,1,'record',null,$2,201,null)", [season, pick('a', 1)]);
  await rejects(() => amend(k), /draft has started/);
  await db.query("select public.update_draft_board($1,2,'undo',null,$2,null,'Undo rehearsal selection')", [season, pick('a', 1)]);
  await rejects(() => amend(k), /draft has started/);
  await db.exec('reset role'); await db.query("update public.seasons set phase='archived' where id=$1", [season]); await user();
  await rejects(() => amend(k), /season is closed/);
}));
