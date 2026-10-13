import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite(); const commissioner = '87000000-0000-4000-8000-000000000001';
let league: string; let current: string; let teams: string[];
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8'));
  league = (await db.query<{ id: string }>('select id from public.leagues')).rows[0].id;
  current = (await db.query<{ id: string }>('select id from public.seasons where draft_year=2026')).rows[0].id;
  teams = (await db.query<{ id: string }>('select id from public.franchises order by espn_team_id')).rows.map(row => row.id);
  await db.query('insert into auth.users(id) values($1)', [commissioner]);
  await db.query("insert into public.league_memberships(league_id,user_id,role,active) values($1,$2,'commissioner',true)", [league, commissioner]);
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function provision() { return (await db.query<{ value: { seasonId: string; picksAdded: number; participantsAdded: number; seasonCreated: boolean } }>('select private.provision_2027_trade_picks() as value')).rows[0].value; }
async function user() { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [commissioner]); await db.exec('set local role authenticated'); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejected'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejected'); } }
async function inventory(season: string) { return (await db.query<{ id: string; season_id: string; original_franchise_id: string; current_owner_id: string; round: number; status: string }>('select * from public.draft_picks where season_id=$1 order by id', [season])).rows; }
async function swap(future: string) {
  const a = (await inventory(current)).find(pick => pick.current_owner_id === teams[0] && pick.round === 13)!;
  const b = (await inventory(future)).find(pick => pick.current_owner_id === teams[1] && pick.round === 13)!;
  await user();
  const id = (await db.query<{ id: string }>("select public.create_trade($1,'advanced','Cross-year swap fixture','[]'::jsonb,$2::jsonb,'[]'::jsonb) as id", [current, JSON.stringify([{ pick_id: a.id, from_franchise_id: teams[0], to_franchise_id: teams[1] }, { pick_id: b.id, from_franchise_id: teams[1], to_franchise_id: teams[0] }])])).rows[0].id;
  return { id, a, b };
}
async function mature(id: string) {
  await db.exec('reset role');
  await db.query("update public.trades set created_at=now()-interval '25 hours',review_deadline=now()-interval '1 hour' where id=$1", [id]);
  await user();
}

test('provisioning creates real 2027 original-owner picks without changing current season, lottery, rosters or keeper state', () => isolated(async () => {
  const before = { season: (await db.query('select * from public.seasons where id=$1', [current])).rows, picks: await inventory(current), keepers: (await db.query('select * from public.keeper_submissions')).rows, owners: (await db.query('select * from public.player_ownerships order by player_id')).rows };
  const result = await provision();
  assert.equal(result.seasonCreated, true); assert.equal(result.participantsAdded, 8); assert.equal(result.picksAdded, 104);
  const picks = await inventory(result.seasonId); assert.equal(picks.length, 104); assert.equal(new Set(picks.map(pick => pick.id)).size, 104);
  assert.ok(picks.every(pick => pick.original_franchise_id === pick.current_owner_id && pick.status === 'available'));
  const future = (await db.query<{ phase: string; draft_revision: number; lottery_config: unknown; keepers_revealed_at: null; trading_opened_at: null }>('select * from public.seasons where id=$1', [result.seasonId])).rows[0];
  assert.equal(future.phase, 'setup'); assert.equal(future.draft_revision, 0); assert.deepEqual(future.lottery_config, {}); assert.equal(future.keepers_revealed_at, null); assert.equal(future.trading_opened_at, null);
  assert.equal((await db.query('select * from public.season_teams where season_id=$1 and (draft_position is not null or lottery_choice_order is not null)', [result.seasonId])).rows.length, 0);
  assert.deepEqual((await db.query('select * from public.seasons where id=$1', [current])).rows, before.season);
  assert.deepEqual(await inventory(current), before.picks); assert.deepEqual((await db.query('select * from public.keeper_submissions')).rows, before.keepers); assert.deepEqual((await db.query('select * from public.player_ownerships order by player_id')).rows, before.owners);
  assert.equal((await db.query('select * from public.trades where application_mode=\'live\'')).rows.length, 0);
}));

test('reprovisioning preserves future UUIDs, transferred ownership, used picks and configured draft state without extra audit events', () => isolated(async () => {
  const first = await provision(); const pick = (await inventory(first.seasonId))[0];
  await db.query("update public.draft_picks set current_owner_id=$2,status='used' where id=$1", [pick.id, teams.find(id => id !== pick.current_owner_id)]);
  await db.query("update public.seasons set phase='draft_ready',draft_revision=7,lottery_config='{" + '"saved":true' + "}'::jsonb where id=$1", [first.seasonId]);
  const before = await inventory(first.seasonId); const seasonBefore = (await db.query('select * from public.seasons where id=$1', [first.seasonId])).rows;
  const again = await provision(); assert.equal(again.seasonId, first.seasonId); assert.equal(again.seasonCreated, false); assert.equal(again.picksAdded, 0); assert.equal(again.participantsAdded, 0);
  assert.deepEqual(await inventory(first.seasonId), before); assert.deepEqual((await db.query('select * from public.seasons where id=$1', [first.seasonId])).rows, seasonBefore);
  assert.equal((await db.query("select * from public.audit_events where event_type='future_pick_inventory_provisioned'")).rows.length, 1);
}));

test('browser roles cannot provision future assets and conflicting existing configuration fails without repair', () => isolated(async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'private.provision_2027_trade_picks()','EXECUTE') as allowed", [role])).rows[0].allowed, false);
  const future = await provision(); await db.query('update public.seasons set participant_count=9 where id=$1', [future.seasonId]);
  await rejects(() => provision(), /conflicts with the reviewed/);
  assert.equal((await inventory(future.seasonId)).length, 104);
}));

test('incomplete inventory after setup fails instead of recreating a potentially spent future pick', () => isolated(async () => {
  const future = await provision();
  await db.query("update public.seasons set phase='draft_ready' where id=$1", [future.seasonId]);
  await db.query('delete from public.draft_picks where id=(select id from public.draft_picks where season_id=$1 limit 1)', [future.seasonId]);
  const before = await inventory(future.seasonId);
  await rejects(() => provision(), /cannot be repaired after setup/);
  assert.deepEqual(await inventory(future.seasonId), before);
}));

test('2026-to-2027 proposal waits for review, then applies atomically without any keeper submissions', () => isolated(async () => {
  const future = await provision(); const { id, a, b } = await swap(future.seasonId);
  assert.equal((await db.query('select * from public.keeper_submissions where season_id=$1', [current])).rows.length, 0);
  assert.equal((await db.query<{ trading_opened_at: null }>('select trading_opened_at from public.seasons where id=$1', [current])).rows[0].trading_opened_at, null);
  assert.equal((await inventory(current)).find(pick => pick.id === a.id)!.current_owner_id, teams[0]);
  assert.equal((await inventory(future.seasonId)).find(pick => pick.id === b.id)!.current_owner_id, teams[1]);
  await rejects(() => db.query('select public.finalize_trade($1)', [id]), /24-hour/);
  await mature(id); await db.query('select public.finalize_trade($1)', [id]);
  assert.equal((await inventory(current)).find(pick => pick.id === a.id)!.current_owner_id, teams[1]);
  assert.equal((await inventory(future.seasonId)).find(pick => pick.id === b.id)!.current_owner_id, teams[0]);
  assert.deepEqual((await db.query<{ draft_revision: number }>('select draft_revision from public.seasons where id in ($1,$2) order by draft_year', [current, future.seasonId])).rows.map(row => row.draft_revision), [1, 1]);
  assert.equal((await db.query<{ trading_opened_at: null }>('select trading_opened_at from public.seasons where id=$1', [current])).rows[0].trading_opened_at, null);
  await rejects(() => db.query('select public.finalize_trade($1)', [id]), /already been finalized/);
}));

test('future stale ownership, used status and keeper reservation each prevent every leg of a mixed-year swap', () => isolated(async () => {
  for (const condition of ['owner', 'used', 'reserved']) {
    await db.exec('reset role; savepoint scenario');
    const future = await provision(); const { id, a, b } = await swap(future.seasonId); await mature(id); await db.exec('reset role');
    if (condition === 'owner') await db.query('update public.draft_picks set current_owner_id=$2 where id=$1', [b.id, teams[2]]);
    if (condition === 'used') await db.query("update public.draft_picks set status='used' where id=$1", [b.id]);
    if (condition === 'reserved') {
      const submission = (await db.query<{ id: string }>("insert into public.keeper_submissions(season_id,franchise_id,revision,status,created_by) values($1,$2,1,'approved',$3) returning id", [future.seasonId, teams[1], commissioner])).rows[0].id;
      await db.query('insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id,reserved) select $1,$2,id,$3,true from public.players limit 1', [submission, future.seasonId, b.id]);
    }
    await user(); await rejects(() => db.query('select public.finalize_trade($1)', [id]), condition === 'reserved' ? /committed to an approved keeper/ : /no longer available/);
    assert.equal((await inventory(current)).find(pick => pick.id === a.id)!.current_owner_id, teams[0]);
    assert.equal((await db.query<{ status: string }>('select status from public.trades where id=$1', [id])).rows[0].status, 'proposed');
    await db.exec('reset role; rollback to savepoint scenario');
  }
}));
