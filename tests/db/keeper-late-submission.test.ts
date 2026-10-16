import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uuid = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = '4bda6ccb-0b37-47b2-8d9e-fe452603738d', season = uuid(2), rules = uuid(3), snapshot = uuid(4);
const a = uuid(10), b = uuid(11), nonparticipant = uuid(12);
const owner = uuid(20), otherOwner = uuid(21), commissioner = uuid(22), coOwner = uuid(23), outsider = uuid(24);
const pick = (team: 'a' | 'b', round: number) => uuid((team === 'a' ? 100 : 200) + round);
type Assignment = { player_id: number; pick_id: string };
type Submission = { id: string; revision: number; status: string };
type Reopening = { season_id: string; franchise_id: string; opened_by: string; opened_at: string; reason: string; consumed_at: string | null };
const note = 'Allow the team to submit its missed keeper selection.';

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users(id) values('${owner}'),('${otherOwner}'),('${commissioner}'),('${coOwner}'),('${outsider}');
    insert into public.leagues(id,slug,name) values('${league}','late-keeper-test','Late Keeper Test');
    insert into public.league_memberships values('${league}','${owner}','manager',true),('${league}','${otherOwner}','manager',true),('${league}','${commissioner}','commissioner',true),('${league}','${coOwner}','manager',true);
    insert into public.franchises(id,league_id,name) values('${a}','${league}','A'),('${b}','${league}','B'),('${nonparticipant}','${league}','Not participating');
    insert into public.managers(id,league_id,display_name) values('${owner}','${league}','A'),('${otherOwner}','${league}','B'),('${coOwner}','${league}','Co-A');
    insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values('${league}','${a}','${owner}','${owner}','2020-01-01'),('${league}','${b}','${otherOwner}','${otherOwner}','2020-01-01'),('${league}','${a}','${coOwner}','${coOwner}','2020-01-01');
    insert into public.rule_versions(id,league_id,version) values('${rules}','${league}',1);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count,phase,keeper_deadline,season_time_zone) values('${season}','${league}','2026-27',2026,'${rules}',2,'keeper_selection',now()+interval '1 day','America/New_York');
    insert into public.season_teams(season_id,franchise_id,league_id,display_name,draft_position) values('${season}','${a}','${league}','A',1),('${season}','${b}','${league}','B',2);
    insert into public.players(id,full_name) values(101,'One'),(102,'Two'),(103,'Three');
    insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,scoring_period,source_sha256) values('${snapshot}','${league}','${season}','2026-03-29',160,repeat('a',64));
    insert into public.roster_entries values('${snapshot}','${season}','${a}',101,0,'/test',null,null),('${snapshot}','${season}','${a}',102,0,'/test',null,null),('${snapshot}','${season}','${b}',103,0,'/test',null,null);
    update public.roster_snapshots set frozen_at=now() where id='${snapshot}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id) values('${season}',101,'${a}','${snapshot}'),('${season}',102,'${a}','${snapshot}'),('${season}',103,'${b}','${snapshot}');
    insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation) values('${season}',101,'${league}','${rules}',5,1,'confirmed','Test'),('${season}',102,'${league}','${rules}',5,2,'confirmed','Test'),('${season}',103,'${league}','${rules}',5,1,'confirmed','Test');
    insert into public.draft_player_catalog values(201,'Draft player',true,repeat('a',64),2027);`);
  for (const team of ['a', 'b'] as const) for (let round = 1; round <= 13; round++) await db.query('insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round) values($1,$2,$3,$3,$4)', [pick(team, round), season, team === 'a' ? a : b, round]);
  await db.query('select private.apply_keeper_deadline_payment_rule_20261014()');
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function user(id = commissioner, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]); await db.exec(`set local role ${role}`); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
async function deadlinePassed() { await db.exec('reset role'); await db.query("update public.seasons set keeper_deadline=now()-interval '1 minute' where id=$1", [season]); }
const initialA = (): Assignment[] => [{ player_id: 101, pick_id: pick('a', 5) }];
async function save(rows = initialA(), revision = 0, team = a) {
  return (await db.query<{ value: Submission }>('select public.save_keeper_submission($1,$2,$3,$4::jsonb) value', [season, team, revision, JSON.stringify(rows)])).rows[0].value;
}
async function transition(k: Submission, action = 'submit', reviewNote: string | null = null) {
  return (await db.query<{ value: Submission }>('select public.transition_keeper_submission($1,$2,$3,$4) value', [k.id, k.revision, action, reviewNote])).rows[0].value;
}
async function reopen(team = a, reason: string | null = note) {
  return (await db.query<{ value: Reopening }>('select public.reopen_keeper_submission($1,$2,$3) value', [season, team, reason])).rows[0].value;
}
async function token(team = a) { return (await db.query<Reopening>('select * from public.keeper_late_submissions where season_id=$1 and franchise_id=$2', [season, team])).rows[0]; }
async function financialState() {
  await db.exec('reset role');
  return {
    seasons: (await db.query<{ keeper_deadline: Date | null }>('select * from public.seasons order by id')).rows,
    inventory: (await db.query('select * from public.keeper_deadline_pick_owners order by pick_id')).rows,
    snapshot: (await db.query('select * from public.keeper_payment_deadline_snapshots order by season_id')).rows,
    picks: (await db.query('select * from public.draft_picks order by id')).rows,
  };
}

test('only a commissioner can reopen a participating team after the configured deadline with a reason', () => isolated(async () => {
  await user();
  await rejects(() => reopen(), /deadline/i);
  await db.exec('reset role'); await db.query('update public.seasons set keeper_deadline=null where id=$1', [season]);
  await user(); await rejects(() => reopen(), /deadline/i);
  await deadlinePassed();
  for (const id of [owner, coOwner, otherOwner, outsider]) {
    await user(id); await rejects(() => reopen(), /Commissioner access required/);
  }
  await user('', 'anon'); await rejects(() => reopen(), /permission denied/);
  await user();
  for (const reason of [null, '', '  ', 'oops', 'x'.repeat(2001)]) await rejects(() => reopen(a, reason), /reason|note/i);
  await rejects(() => reopen(nonparticipant), /participant/i);
  await db.exec('reset role');
  assert.equal((await db.query('select * from public.keeper_late_submissions')).rows.length, 0);
  assert.equal((await db.query('select * from public.keeper_payment_deadline_snapshots')).rows.length, 0);
}));

test('a missing submission reopens only for its team, keeps the deadline and inventory fixed, and closes on submit', () => isolated(async () => {
  await deadlinePassed(); await user();
  await db.query('select public.get_keeper_payment_inventory($1)', [season]);
  const before = await financialState(); await user();
  const opened = await reopen();
  assert.equal(opened.season_id, season); assert.equal(opened.franchise_id, a);
  assert.equal(opened.opened_by, commissioner); assert.equal(opened.reason, note);
  assert.ok(opened.opened_at); assert.equal(opened.consumed_at, null);
  assert.deepEqual(await financialState(), before);
  await user(otherOwner); await rejects(() => save([], 0, b), /deadline/i);
  await rejects(() => save(), /Only an assigned manager/);
  await user(owner);
  const first = await save();
  assert.equal(first.status, 'draft'); assert.equal((await token()).consumed_at, null);
  await rejects(() => save([], 0), /Submission changed/);
  const updated = await save([{ player_id: 102, pick_id: pick('a', 5) }], first.revision);
  assert.equal(updated.revision, 2); assert.equal((await token()).consumed_at, null);
  const submitted = await transition(updated);
  assert.equal(submitted.status, 'submitted'); assert.ok((await token()).consumed_at);
  await rejects(() => save([], submitted.revision), /deadline/i);
  await user(); await rejects(() => reopen(), /Only a missing, draft, or rejected/);
  assert.deepEqual(await financialState(), before);
  await db.exec('reset role');
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length, 0);
  assert.ok((await db.query<{ reserved: boolean }>('select reserved from public.keeper_assignments')).rows.every(row => !row.reserved));
  const audit = (await db.query<{ actor_user_id: string; detail: Record<string, unknown> }>("select actor_user_id,detail from public.audit_events where event_type='keeper_submission_reopened'")).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, commissioner);
  assert.ok(JSON.stringify(audit[0].detail).includes(note));
}));

test('a saved draft can be submitted late without resaving and a rejected selection can submit zero keepers', () => isolated(async () => {
  await user(owner); const draft = await save();
  await user(otherOwner); const submitted = await transition(await save([{ player_id: 103, pick_id: pick('b', 5) }], 0, b));
  await user(); const rejected = await transition(submitted, 'reject', 'Please review your keeper choices.');
  await deadlinePassed(); await user(); await reopen(); await reopen(b);
  await user(owner); assert.equal((await transition(draft)).status, 'submitted');
  assert.ok((await token()).consumed_at);
  await user(otherOwner); const empty = await save([], rejected.revision, b);
  assert.equal((await transition(empty)).status, 'submitted'); assert.ok((await token(b)).consumed_at);
  await db.exec('reset role');
  assert.equal((await db.query('select * from public.keeper_assignments where submission_id=$1', [empty.id])).rows.length, 0);
  assert.ok((await db.query<{ trading_opened_at: string | null }>('select trading_opened_at from public.seasons where id=$1', [season])).rows[0].trading_opened_at);
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length, 0);
}));

test('submitted, approved, and locked selections cannot receive a late player-edit exception', () => isolated(async () => {
  await user(owner); const submitted = await transition(await save());
  await user(otherOwner); const approved = await transition(await save([], 0, b));
  await user(); await transition(approved, 'approve');
  await deadlinePassed(); await user();
  await rejects(() => reopen(), /Only a missing, draft, or rejected/);
  await rejects(() => reopen(b), /Only a missing, draft, or rejected/);
  await db.exec('reset role'); await db.query("update public.keeper_submissions set status='locked' where id=$1", [submitted.id]);
  await user(); await rejects(() => reopen(), /Only a missing, draft, or rejected/);
  assert.equal((await db.query('select * from public.keeper_late_submissions')).rows.length, 0);
}));

test('late exceptions stay private and do not grant revoked managers or other teams submission access', () => isolated(async () => {
  await deadlinePassed(); await user(); await reopen();
  await rejects(() => db.query('update public.keeper_late_submissions set consumed_at=now() where season_id=$1', [season]), /permission denied/);
  await user(owner); assert.equal((await db.query('select * from public.keeper_late_submissions')).rows.length, 1);
  const draft = await save();
  for (const id of [otherOwner, outsider]) {
    await user(id); assert.equal((await db.query('select * from public.keeper_late_submissions')).rows.length, 0);
    await rejects(() => transition(draft), /Only an assigned manager/);
  }
  await db.exec('reset role'); await db.query('update public.manager_assignments set effective_to=clock_timestamp() where user_id=$1', [owner]);
  await user(owner);
  assert.equal((await db.query('select * from public.keeper_late_submissions')).rows.length, 0);
  await rejects(() => save([], draft.revision), /Only an assigned manager/);
  await rejects(() => transition(draft), /Only an assigned manager/);
  await user(coOwner); assert.equal((await token()).consumed_at, null);
  assert.equal((await transition(draft)).status, 'submitted'); assert.ok((await token()).consumed_at);
}));

test('late selections cannot spend newly acquired picks or alter captured deadline ownership', () => isolated(async () => {
  await user(otherOwner); await transition(await save([], 0, b));
  await deadlinePassed(); await user(); await reopen();
  const before = await financialState(); await user();
  const legs = JSON.stringify([{ pick_id: pick('a', 13), from_franchise_id: a, to_franchise_id: b }, { pick_id: pick('b', 5), from_franchise_id: b, to_franchise_id: a }]);
  const trade = (await db.query<{ value: string }>("select public.create_trade($1,'advanced','Late pick swap','[]',$2::jsonb,'[]') value", [season, legs])).rows[0].value;
  await db.query('select public.finalize_trade($1,$2::jsonb,$3,true)', [trade, '[]', 'Commissioner authorizes the reviewed pick swap.']);
  await user(owner);
  await rejects(() => save([{ player_id: 101, pick_id: pick('b', 5) }]), /deadline/i);
  assert.equal((await token()).consumed_at, null);
  const late = await transition(await save());
  await user(); const approved = await transition(late, 'approve'); await transition(approved, 'lock');
  const after = await financialState();
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.inventory, before.inventory);
  assert.equal((await db.query<{ pick_id: string }>('select pick_id from public.keeper_assignments where submission_id=$1', [late.id])).rows[0].pick_id, pick('a', 5));
  assert.deepEqual(after.seasons.map(row => row.keeper_deadline), before.seasons.map(row => row.keeper_deadline));
}));

test('failed player or payment validation leaves the late exception available for a corrected submission', () => isolated(async () => {
  await deadlinePassed(); await user(); await reopen(); await user(owner);
  await rejects(() => save([{ player_id: 103, pick_id: pick('a', 5) }]), /frozen keeper pool/);
  assert.equal((await token()).consumed_at, null);
  const badPayment = await save([{ player_id: 101, pick_id: pick('a', 6) }]);
  await rejects(() => transition(badPayment), /round|payment|eligible/i);
  assert.equal((await token()).consumed_at, null);
  const corrected = await save(initialA(), badPayment.revision);
  assert.equal((await transition(corrected)).status, 'submitted'); assert.ok((await token()).consumed_at);
}));

test('reveal, season progression, and a started draft prevent reopening and invalidate an unused exception', () => isolated(async () => {
  await user(owner); const draft = await save();
  await deadlinePassed(); await user(); await reopen();
  const scenarios = [
    () => db.query('update public.seasons set keepers_revealed_at=now() where id=$1', [season]),
    () => db.query("update public.seasons set phase='draft_ready' where id=$1", [season]),
    () => db.query("insert into private.live_draft_clocks(season_id,status,remaining_seconds,started_at) values($1,'paused',90,now())", [season]),
    () => db.query('insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision) values($1,$2,$3,201,$4,1)', [season, pick('a', 1), a, 'Draft player']),
  ];
  for (const scenario of scenarios) {
    await db.exec('reset role; savepoint progressed');
    try {
      await scenario(); await user();
      await rejects(() => reopen(), /reveal|selection|draft|closed|started/i);
      await user(owner);
      await rejects(() => save([], draft.revision), /reveal|selection|deadline|draft|closed|started/i);
      await rejects(() => transition(draft), /locked|deadline|draft|closed|started/i);
      assert.equal((await token()).consumed_at, null);
    } finally { await db.exec('rollback to savepoint progressed'); }
  }
}));
