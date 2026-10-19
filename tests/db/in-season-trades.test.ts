import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uuid = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = uuid(1), season = uuid(2), future = uuid(3), rules = uuid(4), nextRules = uuid(5), snapshot = uuid(6);
const a = uuid(10), b = uuid(11), commissioner = uuid(20), manager = uuid(21), outsider = uuid(22), submission = uuid(30);
const pick = (team: 'a' | 'b', round: number, next = false) => uuid((next ? 1000 : 0) + (team === 'a' ? 100 : 200) + round);
type PlayerLeg = { player_id: number; from_franchise_id: string; to_franchise_id: string };
type PickLeg = { pick_id: string; from_franchise_id: string; to_franchise_id: string };
const player = (id = 101, from = a, to = b): PlayerLeg => ({ player_id: id, from_franchise_id: from, to_franchise_id: to });
const transfer = (id: string, from = a, to = b): PickLeg => ({ pick_id: id, from_franchise_id: from, to_franchise_id: to });

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users(id) values('${commissioner}'),('${manager}'),('${outsider}');
    insert into public.leagues(id,slug,name) values('${league}','in-season-test','In-season trade test');
    insert into public.league_memberships values('${league}','${commissioner}','commissioner',true),('${league}','${manager}','manager',true);
    insert into public.franchises(id,league_id,name) values('${a}','${league}','A'),('${b}','${league}','B');
    insert into public.managers(id,league_id,display_name) values('${manager}','${league}','A manager');
    insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from)
      values('${league}','${a}','${manager}','${manager}','2020-01-01');
    insert into public.rule_versions(id,league_id,version,draft_rounds,roster_capacity,rules)
      values('${rules}','${league}',1,3,3,'{"keeper_payment_timing":"deadline_after_all_submissions"}'),('${nextRules}','${league}',2,3,3,'{}');
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count,phase,keepers_revealed_at,keeper_deadline,season_time_zone,draft_revision)
      values('${season}','${league}','2026-27',2026,'${rules}',2,'draft_ready',now(),now()-interval '1 day','America/New_York',3),
        ('${future}','${league}','2027-28',2027,'${nextRules}',2,'setup',null,null,'America/New_York',0);
    insert into public.season_teams(season_id,franchise_id,league_id,display_name,draft_position)
      values('${season}','${a}','${league}','A',1),('${season}','${b}','${league}','B',2),
        ('${future}','${a}','${league}','A',null),('${future}','${b}','${league}','B',null);
    insert into public.players(id,full_name) select n,'Player '||n from generate_series(101,107) n;
    insert into public.draft_player_catalog(player_id,full_name,selectable,source_sha256,source_season)
      select n,'Player '||n,true,repeat('a',64),2027 from generate_series(102,106) n;
    insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,source_sha256)
      values('${snapshot}','${league}','${season}','2026-03-29',repeat('a',64));
    insert into public.roster_entries(snapshot_id,season_id,franchise_id,player_id,lineup_slot,source_pointer)
      values('${snapshot}','${season}','${a}',101,0,'/keeper-pool/101'),('${snapshot}','${season}','${a}',107,0,'/keeper-pool/107');
    update public.roster_snapshots set frozen_at=now() where id='${snapshot}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id)
      values('${season}',101,'${a}','${snapshot}'),('${season}',107,'${a}','${snapshot}');
    insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation)
      values('${season}',101,'${league}','${rules}',3,1,'confirmed','Reviewed keeper');
    insert into public.keeper_submissions(id,season_id,franchise_id,revision,status,created_by)
      values('${submission}','${season}','${a}',1,'locked','${commissioner}');`);
  for (const next of [false, true]) for (const team of ['a', 'b'] as const) for (let round = 1; round <= 3; round++) {
    await db.query('insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round,status) values($1,$2,$3,$3,$4,$5)',
      [pick(team, round, next), next ? future : season, team === 'a' ? a : b, round, next ? 'available' : 'used']);
  }
  await db.exec(`insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id,base_round_at_submission,tenure_at_submission,reserved)
      values('${submission}','${season}',101,'${pick('a', 3)}',3,1,true);
    insert into public.keeper_season_records(season_id,player_id,franchise_id,submission_id,pick_id,base_round,actual_payment_round,tenure_before,tenure_after,rule_version_id)
      values('${season}',101,'${a}','${submission}','${pick('a', 3)}',3,3,1,2,'${rules}');
    insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision)
      values('${season}','${pick('a', 1)}','${a}',102,'Player 102',1),('${season}','${pick('a', 2)}','${a}',103,'Player 103',1),
        ('${season}','${pick('b', 1)}','${b}',104,'Player 104',1),('${season}','${pick('b', 2)}','${b}',105,'Player 105',2),
        ('${season}','${pick('b', 3)}','${b}',106,'Player 106',3);
    insert into private.live_draft_clocks(season_id,status,started_at) values('${season}','completed',now()-interval '1 hour');`);
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function user(id = commissioner, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]); await db.exec(`set local role ${role}`); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
async function finalized() { await user(); return (await db.query<{ value: Record<string, unknown> }>('select public.finalize_draft($1,3,$2) value', [season, 'Reviewed completed test draft'])).rows[0].value; }
async function create(players: PlayerLeg[] = [player()], picks: PickLeg[] = []) {
  return (await db.query<{ id: string }>('select public.create_trade($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) id',
    [season, picks.length ? 'advanced' : 'player_only', 'Agreed player and pick transfers', JSON.stringify(players), JSON.stringify(picks), '[]'])).rows[0].id;
}
async function finalize(id: string, override = true) { return db.query('select public.finalize_trade($1,$2::jsonb,$3,$4)', [id, '[]', override ? 'Commissioner reviewed the agreed trade' : null, override]); }
async function ownership() { return (await db.query('select * from public.player_ownerships order by season_id,player_id')).rows; }
async function immutableEvidence() {
  return {
    records: (await db.query('select * from public.keeper_season_records order by season_id,player_id')).rows,
    history: (await db.query('select * from public.historical_draft_selections order by season_id,player_id')).rows,
    profiles: (await db.query('select * from public.keeper_profiles order by season_id,player_id')).rows,
    snapshots: (await db.query('select * from public.roster_snapshots order by id')).rows,
    entries: (await db.query('select * from public.roster_entries order by snapshot_id,player_id')).rows,
    receipts: (await db.query('select * from public.draft_finalizations order by season_id')).rows,
  };
}

test('a finalized keeper can trade after the deadline without changing draft history or keeper costs', () => isolated(async () => {
  const receipt = await finalized(), evidence = await immutableEvidence();
  await user(manager); const id = await create();
  await rejects(() => finalize(id), /Commissioner access required/);
  await user(); await rejects(() => finalize(id, false), /24-hour trade review/);
  await finalize(id);
  const current = (await db.query<{ franchise_id: string; source_snapshot_id: string }>('select franchise_id,source_snapshot_id from public.player_ownerships where season_id=$1 and player_id=101', [season])).rows[0];
  assert.deepEqual(current, { franchise_id: b, source_snapshot_id: receipt.roster_snapshot_id });
  assert.deepEqual(await immutableEvidence(), evidence);
  assert.deepEqual(await finalized(), receipt);
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.player_ownerships where season_id=$1 and player_id=101', [season])).rows[0].franchise_id, b);
  await rejects(() => finalize(id), /already been finalized/);
}));

test('both phase and finalization receipt are required; completed clocks alone do not permit player trades', () => isolated(async () => {
  await user(); await rejects(() => create(), /Player trades pause/);
  await db.exec('reset role'); await db.query("update public.seasons set phase='in_season' where id=$1", [season]);
  await user(); await rejects(() => create(), /Player trades pause/);
  await db.exec('reset role'); await db.query("update public.seasons set phase='draft_ready' where id=$1", [season]);
  await finalized(); const pending = await create();
  await db.exec('reset role'); await db.query("update public.seasons set phase='draft_ready' where id=$1", [season]);
  await user(); await rejects(() => create(), /Player trades pause/); await rejects(() => finalize(pending), /Player trades pause/);
}));

test('stale and removed keeper-pool players cannot transfer, and a mixed trade rolls back every leg', () => isolated(async () => {
  await finalized();
  const stale = await create(); await finalize(await create());
  const unchanged = await ownership(); await rejects(() => finalize(stale), /no longer owned/); assert.deepEqual(await ownership(), unchanged);
  const removed = await create([player(107), player(104, b, a)], [transfer(pick('b', 1, true), b, a)]);
  await rejects(() => finalize(removed), /no longer owned/);
  assert.deepEqual(await ownership(), unchanged);
  assert.equal((await db.query<{ current_owner_id: string }>('select current_owner_id from public.draft_picks where id=$1', [pick('b', 1, true)])).rows[0].current_owner_id, b);
  assert.equal((await db.query<{ status: string }>('select status from public.trades where id=$1', [removed])).rows[0].status, 'proposed');
}));

async function futureKeeper() {
  await db.exec('reset role');
  await db.exec(`insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,source_sha256)
      values('${uuid(40)}','${league}','${future}','2027-04-01',repeat('b',64));
    insert into public.roster_entries(snapshot_id,season_id,franchise_id,player_id,lineup_slot,source_pointer)
      values('${uuid(40)}','${future}','${a}',101,0,'/future-pool/101');
    update public.roster_snapshots set frozen_at=now() where id='${uuid(40)}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id) values('${future}',101,'${a}','${uuid(40)}');
    update public.seasons set phase='keeper_selection' where id='${future}';
    update public.draft_picks set current_owner_id='${b}' where id='${pick('a', 2, true)}';
    insert into public.keeper_submissions(id,season_id,franchise_id,revision,status,created_by)
      values('${uuid(41)}','${future}','${a}',1,'approved','${commissioner}');
    insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id,base_round_at_submission,tenure_at_submission,reserved)
      values('${uuid(41)}','${future}',101,'${pick('a', 1, true)}',2,2,true);`);
  await user();
}

test('in-season trades retain future keeper reservations and prospective payment validation', () => isolated(async () => {
  await finalized(); await futureKeeper();
  const reserved = await create([player()], [transfer(pick('a', 1, true))]);
  const before = await ownership(); await rejects(() => finalize(reserved), /committed to an approved keeper/); assert.deepEqual(await ownership(), before);
  const later = await create([player()], [transfer(pick('a', 2, true), b, a)]);
  await rejects(() => finalize(later), /must use an available round 2/); assert.deepEqual(await ownership(), before);
  // A legal future pick still trades, even though this also transfers the old season's kept player.
  await finalize(await create([player()], [transfer(pick('b', 1, true), b, a)]));
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.player_ownerships where season_id=$1 and player_id=101', [season])).rows[0].franchise_id, b);
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.player_ownerships where season_id=$1 and player_id=101', [future])).rows[0].franchise_id, a);
}));

test('pre-draft deadline restrictions remain enforced without a finalization receipt', () => isolated(async () => {
  await db.exec('reset role'); await db.query("update public.seasons set phase='keeper_selection',keepers_revealed_at=null where id=$1", [season]);
  await user(); const id = await create();
  await rejects(() => finalize(id), /Cannot trade an approved keeper before reveal/);
  await db.exec('reset role'); await db.query("update public.keeper_assignments set reserved=false where submission_id=$1", [submission]);
  await db.query("update public.keeper_submissions set status='submitted' where id=$1", [submission]);
  await user(); await rejects(() => finalize(id), /Submitted keeper players are fixed after the deadline/);
}));

test('finalized trading remains role protected and closes for archived seasons', () => isolated(async () => {
  await finalized(); const pending = await create();
  await user(outsider); await rejects(() => create(), /Current league manager access/);
  await rejects(() => db.query('select private.has_finalized_draft_roster($1)', [season]), /permission denied/);
  await user(outsider, 'anon'); await rejects(() => create(), /permission denied/);
  await db.exec('reset role'); await db.query("update public.seasons set phase='archived' where id=$1", [season]);
  await user(); await rejects(() => create(), /archived season/); await rejects(() => finalize(pending), /archived season/);
}));
