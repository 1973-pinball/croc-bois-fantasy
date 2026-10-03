import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = uid(1), season = uid(2), rules = uid(3), snapshot = uid(4);
const a = uid(10), b = uid(11), managerA = uid(20), managerB = uid(21);
const userA = uid(30), userB = uid(31), commissioner = uid(32);
const a4 = uid(40), a5 = uid(41), b4 = uid(42), b5 = uid(43);

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`
    insert into auth.users values('${userA}'),('${userB}'),('${commissioner}');
    insert into public.leagues(id,slug,name) values('${league}','test-league','Test League');
    insert into public.league_memberships values('${league}','${userA}','manager',true),('${league}','${userB}','manager',true),('${league}','${commissioner}','commissioner',true);
    insert into public.franchises(id,league_id,name) values('${a}','${league}','Team A'),('${b}','${league}','Team B');
    insert into public.managers(id,league_id,display_name) values('${managerA}','${league}','Manager A'),('${managerB}','${league}','Manager B');
    insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values('${league}','${a}','${managerA}','${userA}','2020-01-01'),('${league}','${b}','${managerB}','${userB}','2020-01-01');
    insert into public.rule_versions(id,league_id,version) values('${rules}','${league}',1);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count,phase) values('${season}','${league}','2026-27',2026,'${rules}',2,'keeper_selection');
    insert into public.season_teams values('${season}','${a}','${league}','Team A',null,null,null),('${season}','${b}','${league}','Team B',null,null,null);
    insert into public.players(id,full_name) values(101,'Player One'),(102,'Player Two'),(103,'Player Three');
    insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,scoring_period,source_sha256) values('${snapshot}','${league}','${season}','2026-03-29',160,repeat('a',64));
    insert into public.roster_entries values('${snapshot}','${season}','${a}',101,12,'/test',null,null),('${snapshot}','${season}','${a}',102,13,'/test',null,null),('${snapshot}','${season}','${b}',103,0,'/test',null,null);
    update public.roster_snapshots set frozen_at=now() where id='${snapshot}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id) values('${season}',101,'${a}','${snapshot}'),('${season}',102,'${a}','${snapshot}'),('${season}',103,'${b}','${snapshot}');
    insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation) values('${season}',101,'${league}','${rules}',5,1,'confirmed','Test'),('${season}',102,'${league}','${rules}',5,1,'confirmed','Test'),('${season}',103,'${league}','${rules}',4,1,'confirmed','Test');
    insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round) values('${a4}','${season}','${a}','${a}',4),('${a5}','${season}','${a}','${a}',5),('${b4}','${season}','${b}','${b}',4),('${b5}','${season}','${b}','${b}',5);
  `);
});
after(async () => db.close());

async function asUser(user: string | null, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? '']);
  await db.exec(`set local role ${role}`);
}
async function asAdmin() { await db.exec('reset role'); }
async function isolated(work: () => Promise<void>) { await db.exec('begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejected(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint expected_error');
  try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint expected_error'); }
}
async function save(team: string, assignments: {player_id: number;pick_id: string}[], revision = 0) {
  const result = await db.query<{value: {id: string; revision: number;status: string}}>('select public.save_keeper_submission($1,$2,$3,$4::jsonb) as value', [season, team, revision, JSON.stringify(assignments)]);
  return result.rows[0].value;
}
async function transition(submission: string, action: string, revision = 1) {
  return db.query('select public.transition_keeper_submission($1,$2,$3,null)', [submission, revision, action]);
}
async function createTrade(players: unknown[], picks: unknown[] = [], reviewElapsed = true) {
  const result = await db.query<{id:string}>('select public.create_trade($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) as id', [season, picks.length ? 'advanced' : 'player_only', 'Test terms', JSON.stringify(players), JSON.stringify(picks), '[]']);
  const id = result.rows[0].id;
  if (reviewElapsed) {
    // Test fixture simulates elapsed time; the authenticated app has no override.
    await db.exec('reset role');
    await db.query("update public.trades set created_at=now()-interval '25 hours',review_deadline=now()-interval '1 hour' where id=$1",[id]);
    await db.exec('set local role authenticated');
  }
  return id;
}

test('RLS hides private submissions, prevents client self-promotion and enforces franchise ownership', () => isolated(async () => {
  await asUser(userA);
  await save(a, [{player_id: 101,pick_id:a5}]);
  assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,1);
  await rejected(() => db.exec(`update public.league_memberships set role='commissioner' where user_id='${userA}'`), /permission denied/);
  await asUser(userB);
  assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,0);
  assert.equal((await db.query('select * from public.keeper_assignments')).rows.length,0);
  await rejected(() => save(a,[]), /Only an assigned manager/);
  await asUser(null,'anon');
  assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,0);
  assert.equal((await db.query('select * from public.draft_picks')).rows.length,4);
  await rejected(() => save(a,[]), /permission denied/);
}));

test('keeper payment validates the whole set independently of order and only reveals after every lock', () => isolated(async () => {
  await asUser(userA);
  const ka = await save(a,[{player_id:101,pick_id:a4},{player_id:102,pick_id:a5}]);
  await transition(ka.id,'submit');
  await asUser(userB);
  const kb = await save(b,[]);
  await transition(kb.id,'submit');
  await rejected(() => transition(ka.id,'approve'), /Commissioner access required/);
  await asUser(commissioner);
  await transition(ka.id,'approve');
  await transition(ka.id,'lock');
  await asUser(null,'anon');
  assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,0);
  assert.equal((await db.query("select * from public.draft_picks where status='used'")).rows.length,0);
  await asUser(commissioner);
  await transition(kb.id,'approve');
  await transition(kb.id,'lock');
  await asUser(null,'anon');
  // Reveal publishes the selections, never the private review notes or auth UUIDs.
  assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,0);
  assert.equal((await db.query('select * from public.keeper_season_records')).rows.length,2);
  const records = await db.query<{base_round:number;actual_payment_round:number;tenure_after:number}>('select base_round,actual_payment_round,tenure_after from public.keeper_season_records where player_id=101');
  assert.deepEqual(records.rows[0],{base_round:5,actual_payment_round:4,tenure_after:2});
  assert.equal((await db.query("select * from public.draft_picks where status='used'")).rows.length,2);
}));

test('overpayment, exhausted tenure, unresolved profiles, duplicates and stale revisions are rejected', () => isolated(async () => {
  await asUser(userA);
  let k = await save(a,[{player_id:101,pick_id:a4}]);
  await rejected(() => transition(k.id,'submit'), /available round 5/);
  await rejected(() => save(a,[],0), /Submission changed/);
  await rejected(() => save(a,[{player_id:101,pick_id:a4},{player_id:101,pick_id:a5}],1), /duplicate key/);
  k=await save(a,[{player_id:101,pick_id:a5}],1);
  await asAdmin();
  await db.exec("update public.keeper_profiles set tenure_years=5 where player_id=101");
  await asUser(userA);
  await rejected(() => transition(k.id,'submit',2), /ineligible/);
  await asAdmin();
  await db.exec("update public.keeper_profiles set tenure_years=1,verification='provisional' where player_id=101");
  await asUser(userA);
  await rejected(() => transition(k.id,'submit',2), /commissioner verification/);
}));

test('saving an approved selection creates a private revision and releases its reservation', () => isolated(async () => {
  await asUser(userA);
  const k = await save(a,[{player_id:101,pick_id:a5}]);
  await transition(k.id,'submit');
  await asUser(commissioner);
  await transition(k.id,'approve');
  await asUser(userA);
  const revised = await save(a,[],1);
  assert.equal(revised.revision,2);
  assert.equal(revised.status,'draft');
  assert.equal((await db.query('select * from public.keeper_assignments where reserved')).rows.length,0);
  await asUser(commissioner);
  await rejected(() => transition(k.id,'lock'), /Submission changed/);
}));

test('atomic trade failure leaves every owner unchanged and historical records never execute', () => isolated(async () => {
  await db.exec(`update public.seasons set trading_opened_at=now() where id='${season}'`);
  await asUser(commissioner);
  const trade = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}],[{pick_id:b5,from_franchise_id:a,to_franchise_id:b}]);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /no longer available/);
  const owner = await db.query<{franchise_id:string}>('select franchise_id from public.player_ownerships where player_id=101');
  assert.equal(owner.rows[0].franchise_id,a);
  await asAdmin();
  await db.query("update public.trades set application_mode='record_only' where id=$1",[trade]);
  await asUser(commissioner);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /Historical records cannot be applied/);
}));

test('live trades preserve cost, tenure, and frozen provenance and cannot run twice', () => isolated(async () => {
  await db.exec(`update public.seasons set trading_opened_at=now() where id='${season}'`);
  await asUser(commissioner);
  const trade = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}],[{pick_id:a5,from_franchise_id:a,to_franchise_id:b}]);
  await db.query('select public.finalize_trade($1)',[trade]);
  assert.equal((await db.query<{franchise_id:string}>('select franchise_id from public.player_ownerships where player_id=101')).rows[0].franchise_id,b);
  assert.equal((await db.query<{franchise_id:string}>('select franchise_id from public.roster_entries where player_id=101')).rows[0].franchise_id,a);
  assert.deepEqual((await db.query('select base_round,tenure_years from public.keeper_profiles where player_id=101')).rows[0],{base_round:5,tenure_years:1});
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /already been finalized/);
  await asAdmin();
  await rejected(() => db.query("update public.trades set terms='rewritten' where id=$1",[trade]), /immutable/);
  await rejected(() => db.exec('delete from public.roster_entries where player_id=101'), /immutable/);
}));

test('approved payment picks cannot be transferred', () => isolated(async () => {
  await db.exec(`update public.seasons set trading_opened_at=now() where id='${season}'`);
  await asUser(userA);
  const k = await save(a,[{player_id:101,pick_id:a5}]);
  await transition(k.id,'submit');
  await asUser(commissioner);
  await transition(k.id,'approve');
  const trade = await createTrade([],[{pick_id:a5,from_franchise_id:a,to_franchise_id:b}]);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /committed to an approved keeper/);
}));

test('incoming picks cannot invalidate locked keeper payment and a rejected trade rolls back every leg', () => isolated(async () => {
  // A's round-five pick was traded away, so its round-five keeper legally costs a fourth.
  await db.query('update public.draft_picks set current_owner_id=$1 where id=$2',[b,a5]);
  await asUser(userA);
  const ka = await save(a,[{player_id:101,pick_id:a4}]);
  await transition(ka.id,'submit');
  await asUser(userB);
  const kb = await save(b,[]);
  await transition(kb.id,'submit');
  await asUser(commissioner);
  await transition(ka.id,'approve');
  await transition(ka.id,'lock');
  const invalidTrade = await createTrade([{player_id:103,from_franchise_id:b,to_franchise_id:a}],[{pick_id:b5,from_franchise_id:b,to_franchise_id:a}]);
  await rejected(() => db.query('select public.finalize_trade($1)',[invalidTrade]), /available round 5/);
  assert.equal((await db.query<{current_owner_id:string}>('select current_owner_id from public.draft_picks where id=$1',[b5])).rows[0].current_owner_id,b);
  assert.equal((await db.query<{franchise_id:string}>('select franchise_id from public.player_ownerships where player_id=103')).rows[0].franchise_id,b);
  assert.equal((await db.query<{status:string}>('select status from public.trades where id=$1',[invalidTrade])).rows[0].status,'proposed');

  // An additional fourth is legal: owners may choose between picks in the same round.
  const validTrade = await createTrade([{player_id:103,from_franchise_id:b,to_franchise_id:a}],[{pick_id:b4,from_franchise_id:b,to_franchise_id:a}]);
  await db.query('select public.finalize_trade($1)',[validTrade]);
  await transition(kb.id,'approve');
  await transition(kb.id,'lock');
  const outcome = await db.query<{base_round:number;actual_payment_round:number}>('select base_round,actual_payment_round from public.keeper_season_records where player_id=101');
  assert.deepEqual(outcome.rows[0],{base_round:5,actual_payment_round:4});
  assert.notEqual((await db.query<{keepers_revealed_at:unknown}>('select keepers_revealed_at from public.seasons where id=$1',[season])).rows[0].keepers_revealed_at,null);
}));

test('keeper tenure cannot be zero while an unknown tenure remains explicitly null', () => isolated(async () => {
  await asUser(commissioner);
  await rejected(() => db.query('select public.review_keeper_profile($1,101,5,0,$2,$3)',[season,'confirmed','Review attempted with zero tenure']), /initial season counts as year one/);
  await db.query('select public.review_keeper_profile($1,101,5,null,$2,$3)',[season,'unresolved','Historical tenure still unknown']);
  assert.equal((await db.query<{tenure_years:number|null}>('select tenure_years from public.keeper_profiles where player_id=101')).rows[0].tenure_years,null);
  await asAdmin();
  await rejected(() => db.exec('update public.keeper_profiles set tenure_years=0 where player_id=101'), /check constraint/);
  await asUser(userA);
  const k = await save(a,[{player_id:101,pick_id:a5}]);
  await rejected(() => transition(k.id,'submit'), /commissioner verification/);
}));

test('commissioner profile review is audited and cannot silently change an approved keeper', () => isolated(async () => {
  await asUser(userA);
  await rejected(() => db.query('select public.review_keeper_profile($1,101,5,2,$2,$3)',[season,'confirmed','Reviewed source']), /Commissioner access required/);
  await asUser(commissioner);
  await db.query('select public.review_keeper_profile($1,101,5,2,$2,$3)',[season,'confirmed','Reviewed source']);
  assert.equal((await db.query("select * from public.audit_events where event_type='keeper_profile_reviewed'")).rows.length,1);
  await asUser(userA);
  const k = await save(a,[{player_id:101,pick_id:a5}]);
  await transition(k.id,'submit');
  await asUser(commissioner);
  await transition(k.id,'approve');
  await rejected(() => db.query('select public.review_keeper_profile($1,101,4,2,$2,$3)',[season,'confirmed','Changed source']), /Reject the approved submission/);
}));

test('expired manager assignment immediately removes write access', () => isolated(async () => {
  await db.exec(`update public.manager_assignments set effective_to='2021-01-01' where user_id='${userA}'`);
  await asUser(userA);
  await rejected(() => save(a,[]), /Only an assigned manager/);
}));

test('participant expansion blocks premature reveal until all configured teams join and lock', () => isolated(async () => {
  await db.exec(`update public.seasons set participant_count=3 where id='${season}'`);
  await asUser(userA);
  const ka = await save(a,[]);
  await transition(ka.id,'submit');
  await asUser(userB);
  const kb = await save(b,[]);
  await transition(kb.id,'submit');
  await asUser(commissioner);
  for (const id of [ka.id,kb.id]) { await transition(id,'approve'); await transition(id,'lock'); }
  const state = await db.query<{keepers_revealed_at:unknown;trading_opened_at:unknown}>('select keepers_revealed_at,trading_opened_at from public.seasons where id=$1',[season]);
  assert.equal(state.rows[0].keepers_revealed_at,null);
  assert.equal(state.rows[0].trading_opened_at,null);
}));

test('a manager may log a trade but only a commissioner can finalize after 24 hours', () => isolated(async () => {
  await db.exec(`update public.seasons set trading_opened_at=now() where id='${season}'`);
  await asUser(userA);
  const trade = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}],[],false);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /Commissioner access required/);
  await asUser(commissioner);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /24-hour trade review/);
  assert.equal((await db.query<{franchise_id:string}>('select franchise_id from public.player_ownerships where player_id=101')).rows[0].franchise_id,a);
}));

test('season opening requires commissioner review, all participants, frozen ownership and every pick', () => isolated(async () => {
  await db.exec(`update public.seasons set phase='setup' where id='${season}'`);
  await asUser(userA);
  await rejected(() => db.query('select public.open_keeper_selection($1,$2)',[season,'Reviewed the imports']), /Commissioner access required/);
  await asUser(commissioner);
  await rejected(() => db.query('select public.open_keeper_selection($1,$2)',[season,'Reviewed the imports']), /every original draft pick/);
  await asAdmin();
  await db.exec(`insert into public.draft_picks(season_id,original_franchise_id,current_owner_id,round)
    select '${season}',st.franchise_id,st.franchise_id,n from public.season_teams st cross join generate_series(1,13) n
    where st.season_id='${season}' on conflict (season_id,original_franchise_id,round) do nothing;`);
  await asUser(commissioner);
  const result = await db.query<{season: {phase:string}}>('select public.open_keeper_selection($1,$2) as season',[season,'Roster and ownership reconciled']);
  assert.equal(result.rows[0].season.phase,'keeper_selection');
  assert.equal((await db.query("select * from public.audit_events where event_type='keeper_selection_opened'")).rows.length,1);
}));


test('withdrawal requires commissioner access and a reason, retains original legs, audit and participant visibility', () => isolated(async () => {
  await asUser(userA);
  const trade = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}],[],false);
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[trade,'Agreement withdrawn']), /Commissioner access required/);
  await asUser(commissioner);
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[trade,'   ']), /Withdrawal reason/);
  const result = await db.query<{value: {status:string;cancellation_reason:string;cancelled_by:string;cancelled_at:string}}>('select public.withdraw_trade($1,$2) as value',[trade,'  Managers withdrew the agreement  ']);
  assert.equal(result.rows[0].value.status,'cancelled');
  assert.equal(result.rows[0].value.cancellation_reason,'Managers withdrew the agreement');
  assert.equal(result.rows[0].value.cancelled_by,commissioner); assert.ok(result.rows[0].value.cancelled_at);
  assert.equal((await db.query<{franchise_id:string}>('select franchise_id from public.player_ownerships where player_id=101')).rows[0].franchise_id,a);
  assert.equal((await db.query('select * from public.trade_player_transfers where trade_id=$1',[trade])).rows.length,1);
  const audit = await db.query<{detail:{reason:string}}>("select detail from public.audit_events where event_type='trade_withdrawn' and entity_id=$1",[trade]);
  assert.equal(audit.rows[0].detail.reason,'Managers withdrew the agreement');
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[trade,'Withdraw again']), /Only pending live trades/);
  await rejected(() => db.query('select public.finalize_trade($1)',[trade]), /finalized or cancelled/);
  await asUser(userB); assert.equal((await db.query('select id from public.trades where id=$1',[trade])).rows.length,1);
  await asUser(null,'anon'); assert.equal((await db.query('select id from public.trades where id=$1',[trade])).rows.length,0);
}));

test('withdrawal cannot change finalized, historical or archived records', () => isolated(async () => {
  await asAdmin(); await db.query("update public.seasons set trading_opened_at=now() where id=$1",[season]);
  await asUser(commissioner);
  const finalized = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}]);
  await db.query('select public.finalize_trade($1)',[finalized]);
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[finalized,'Correct completed trade']), /Only pending live trades/);
  const historical = await createTrade([{player_id:103,from_franchise_id:b,to_franchise_id:a}],[],false);
  await asAdmin(); await db.query("update public.trades set application_mode='record_only' where id=$1",[historical]); await asUser(commissioner);
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[historical,'Historical correction']), /Only pending live trades/);
  const archived = await createTrade([{player_id:103,from_franchise_id:b,to_franchise_id:a}],[],false);
  await asAdmin(); await db.query("update public.seasons set phase='archived' where id=$1",[season]); await asUser(commissioner);
  await rejected(() => db.query('select public.withdraw_trade($1,$2)',[archived,'Archived correction']), /archived season/);
}));

test('a corrected proposal links its withdrawn predecessor, starts a fresh review and preserves the original', () => isolated(async () => {
  await asUser(commissioner);
  const previous = await createTrade([{player_id:101,from_franchise_id:a,to_franchise_id:b}],[],false);
  const args = [previous,season,'player_only','Corrected terms',JSON.stringify([{player_id:102,from_franchise_id:a,to_franchise_id:b}]),'[]','[]'];
  await rejected(() => db.query('select public.create_trade_revision($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',args), /withdrawn live trade/);
  await db.query('select public.withdraw_trade($1,$2)',[previous,'Incorrect player in the original record']);
  await asUser(userA);
  await rejected(() => db.query('select public.create_trade_revision($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',args), /Commissioner access required/);
  await asUser(commissioner);
  const revision = await db.query<{id:string}>('select public.create_trade_revision($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) as id',args);
  const records = await db.query<{status:string;corrects_trade_id:string;review_hours:number}>('select status,corrects_trade_id,extract(epoch from (review_deadline-created_at))/3600 as review_hours from public.trades where id=$1',[revision.rows[0].id]);
  assert.equal(records.rows[0].status,'proposed'); assert.equal(records.rows[0].corrects_trade_id,previous); assert.equal(Number(records.rows[0].review_hours),24);
  assert.equal((await db.query<{player_id:number}>('select player_id from public.trade_player_transfers where trade_id=$1',[previous])).rows[0].player_id,101);
  assert.equal((await db.query("select * from public.audit_events where event_type='trade_revision_created' and entity_id=$1",[revision.rows[0].id])).rows.length,1);
}));
