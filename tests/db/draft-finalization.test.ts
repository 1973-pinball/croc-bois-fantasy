import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const commissioner = '97000000-0000-4000-8000-000000000001';
const manager = '97000000-0000-4000-8000-000000000002';
const outsider = '97000000-0000-4000-8000-000000000003';
const revision = 95;
let league: string, season: string, teams: string[];
type Pick = { id: string; round: number; current_owner_id: string; overall: number };
type Keeper = { player_id: number; franchise_id: string; pick_id: string; base: number; tenure: number; payment: number };
type Fixture = { future: string; keepers: Keeper[]; picks: Pick[]; fresh: { player: number; pick: Pick }[] };

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, directory), 'utf8'));
  }
  await db.exec(await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8'));
  league = (await db.query<{ id: string }>('select id from public.leagues')).rows[0].id;
  season = (await db.query<{ id: string }>('select id from public.seasons where draft_year=2026')).rows[0].id;
  teams = (await db.query<{ id: string }>('select id from public.franchises order by espn_team_id')).rows.map(row => row.id);
  await db.query('insert into auth.users(id) values($1),($2),($3)', [commissioner, manager, outsider]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true)", [league, commissioner, manager]);
});
after(async () => db.close());

async function user(id: string | null = commissioner, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']);
  await db.exec(`set local role ${role}`);
}
async function isolated(work: () => Promise<void>) {
  await db.exec('reset role; begin');
  try { await work(); } finally { await db.exec('rollback'); }
}
async function rejects(work: () => Promise<unknown>, pattern?: RegExp) {
  await db.exec('savepoint rejected');
  try { if (pattern) await assert.rejects(work, pattern); else await assert.rejects(work); }
  finally { await db.exec('rollback to savepoint rejected'); }
}
async function finalize(expected: number | null = revision) {
  return (await db.query<{ value: Record<string, unknown> }>('select public.finalize_draft($1,$2,$3) as value', [season, expected, 'Finalize the reviewed completed draft.'])).rows[0].value;
}
async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) { return (await db.query<T>(sql, params)).rows; }

/** A complete ledger fixture, with keeper overpayment and exhausted tenure. */
async function completed(): Promise<Fixture> {
  await db.exec('reset role');
  const future = (await rows<{ value: { seasonId: string } }>('select private.provision_2027_trade_picks() as value'))[0].value.seasonId;
  await db.query(`update public.season_teams st set draft_position=ranked.position from
    (select st.franchise_id,row_number() over(order by f.espn_team_id)::integer position from public.season_teams st
      join public.franchises f on f.id=st.franchise_id where st.season_id=$1) ranked
    where st.season_id=$1 and st.franchise_id=ranked.franchise_id`, [season]);
  const picks = await rows<Pick>(`select p.id,p.round,p.current_owner_id,
    ((p.round-1)*8+case when p.round%2=0 then 9-st.draft_position else st.draft_position end)::integer overall
    from public.draft_picks p join public.season_teams st on st.season_id=p.season_id and st.franchise_id=p.original_franchise_id
    where p.season_id=$1 order by overall`, [season]);
  const candidates = await rows<{ player_id: number; franchise_id: string }>(`select po.player_id,po.franchise_id from public.player_ownerships po
    join public.keeper_profiles kp using(season_id,player_id) where po.season_id=$1 and kp.verification='confirmed'
    order by po.player_id limit 2`, [season]);
  const keepers: Keeper[] = [];
  const submissions = new Map<string, string>();
  for (const [index, candidate] of candidates.entries()) {
    const base = index === 0 ? 8 : 7, tenure = index === 0 ? 2 : 4, payment = index === 0 ? 6 : 5;
    const pick = picks.find(p => p.current_owner_id === candidate.franchise_id && p.round === payment)!;
    let submissionId = submissions.get(candidate.franchise_id);
    if (!submissionId) {
      submissionId = (await rows<{ id: string }>(`insert into public.keeper_submissions(season_id,franchise_id,revision,status,created_by,locked_at)
        values($1,$2,1,'locked',$3,now()) returning id`, [season, candidate.franchise_id, commissioner]))[0].id;
      submissions.set(candidate.franchise_id, submissionId);
    }
    await db.query(`update public.keeper_profiles set base_round=$3,tenure_years=$4,verification='confirmed'
      where season_id=$1 and player_id=$2`, [season, candidate.player_id, base, tenure]);
    await db.query(`insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id,base_round_at_submission,tenure_at_submission,reserved)
      values($1,$2,$3,$4,$5,$6,true)`, [submissionId, season, candidate.player_id, pick.id, base, tenure]);
    await db.query(`insert into public.keeper_season_records(season_id,player_id,franchise_id,submission_id,pick_id,base_round,actual_payment_round,tenure_before,tenure_after,rule_version_id)
      select $1,$2,$3,$4,$5,$6,$7,$8,$8+1,rule_version_id from public.seasons where id=$1`,
    [season, candidate.player_id, candidate.franchise_id, submissionId, pick.id, base, payment, tenure]);
    keepers.push({ ...candidate, pick_id: pick.id, base, tenure, payment });
  }
  const fresh = picks.filter(pick => !keepers.some(keeper => keeper.pick_id === pick.id)).map(pick => ({ player: 920000000 + pick.overall, pick }));
  await db.query(`insert into public.draft_player_catalog(player_id,full_name,selectable,source_sha256,source_season)
    select (x->>'player')::bigint,'Finalization player '||(x->>'player'),true,repeat('c',64),2027 from jsonb_array_elements($1::jsonb) x`, [JSON.stringify(fresh)]);
  await db.query(`insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision)
    select $1,(x->'pick'->>'id')::uuid,(x->'pick'->>'current_owner_id')::uuid,(x->>'player')::bigint,'Finalization player '||(x->>'player'),1
    from jsonb_array_elements($2::jsonb) x`, [season, JSON.stringify(fresh)]);
  await db.query("update public.draft_picks set status='used' where season_id=$1", [season]);
  await db.query("update public.seasons set phase='draft_ready',keepers_revealed_at=now(),draft_revision=$2 where id=$1", [season, revision]);
  await db.query("insert into private.live_draft_clocks(season_id,status,started_at) values($1,'completed',now())", [season]);
  // Preserve an already-traded future pick, rather than rebuilding future ownership.
  await db.query('update public.draft_picks set current_owner_id=$2 where season_id=$1 and original_franchise_id=$3 and round=1', [future, teams[1], teams[0]]);
  return { future, keepers, picks, fresh };
}

/** Capture every table finalization may touch, including preserved evidence. */
async function state() {
  await db.exec('reset role');
  const tables = ['seasons', 'players', 'roster_snapshots', 'roster_entries', 'player_ownerships', 'keeper_profiles',
    'historical_draft_selections', 'draft_finalizations', 'keeper_season_records', 'draft_picks', 'audit_events'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await rows(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`);
  result.clock = await rows('select to_jsonb(c) as row from private.live_draft_clocks c order by season_id');
  return result;
}

test('finalization requires commissioner access, including repeat attempts', () => isolated(async () => {
  await completed(); const before = await state();
  for (const id of [manager, outsider]) { await user(id); await rejects(() => finalize(), /commissioner/i); }
  await user(null, 'anon'); await rejects(() => finalize(), /permission denied/i);
  assert.deepEqual(await state(), before);
  await user(); await finalize();
  await user(manager); await rejects(() => finalize(), /commissioner/i);
}));

test('complete ledger becomes current ownership and immutable history without rewriting keeper eligibility', () => isolated(async () => {
  const fixture = await completed();
  const oldProfiles = await rows('select * from public.keeper_profiles where season_id=$1 order by player_id', [season]);
  const frozen = await rows('select * from public.roster_snapshots where season_id=$1 and frozen_at is not null', [season]);
  const frozenEntries = await rows('select * from public.roster_entries where snapshot_id=$1 order by player_id', [frozen[0].id]);
  const keeperRecords = await rows('select * from public.keeper_season_records where season_id=$1 order by player_id', [season]);
  const futurePicks = await rows('select * from public.draft_picks where season_id=$1 order by id', [fixture.future]);
  await user(); await finalize(); await db.exec('reset role');
  const receipt = (await rows('select * from public.draft_finalizations where season_id=$1', [season]))[0];
  assert.equal(receipt.player_count, 104); assert.equal(receipt.source_revision, revision);
  assert.equal(receipt.keeper_profile_season_id, fixture.future);
  assert.equal(receipt.finalized_by, commissioner); assert.match(String(receipt.source_sha256), /^[a-f0-9]{64}$/);
  const snapshot = (await rows('select * from public.roster_snapshots where id=$1', [receipt.roster_snapshot_id]))[0];
  assert.equal(snapshot.frozen_at, null); assert.notEqual(snapshot.id, frozen[0].id);
  const ownership = await rows<{ player_id: number; source_snapshot_id: string }>('select player_id,source_snapshot_id from public.player_ownerships where season_id=$1', [season]);
  assert.equal(ownership.length, 104); assert.ok(ownership.every(row => row.source_snapshot_id === receipt.roster_snapshot_id));
  assert.deepEqual(new Set(ownership.map(row => row.player_id)), new Set([...fixture.fresh.map(row => row.player), ...fixture.keepers.map(row => row.player_id)]));
  assert.equal((await rows('select 1 from public.roster_entries where snapshot_id=$1', [receipt.roster_snapshot_id])).length, 104);
  assert.equal((await rows('select 1 from public.roster_entries where snapshot_id=$1 and lineup_slot<>-1', [receipt.roster_snapshot_id])).length, 0, 'the draft ledger does not assign starters, bench or IR');
  assert.equal((await rows('select 1 from public.historical_draft_selections where season_id=$1', [season])).length, 104);
  assert.equal((await rows('select 1 from public.players where id=$1', [fixture.fresh[0].player])).length, 1, 'newly drafted identities need no preexisting legacy player row');
  assert.deepEqual(await rows('select * from public.keeper_profiles where season_id=$1 order by player_id', [season]), oldProfiles);
  assert.deepEqual(await rows('select * from public.roster_snapshots where season_id=$1 and frozen_at is not null', [season]), frozen);
  assert.deepEqual(await rows('select * from public.roster_entries where snapshot_id=$1 order by player_id', [frozen[0].id]), frozenEntries);
  assert.deepEqual(await rows('select * from public.keeper_season_records where season_id=$1 order by player_id', [season]), keeperRecords);
  assert.deepEqual(await rows('select * from public.draft_picks where season_id=$1 order by id', [fixture.future]), futurePicks);
  assert.deepEqual((await rows('select phase,draft_revision from public.seasons where id=$1', [season]))[0], { phase: 'in_season', draft_revision: revision + 1 });
  assert.equal((await rows<{ phase: string }>('select phase from public.seasons where id=$1', [fixture.future]))[0].phase, 'setup');
  assert.equal((await rows('select 1 from public.player_ownerships where season_id=$1', [fixture.future])).length, 0);
  assert.equal((await rows('select 1 from public.roster_snapshots where season_id=$1 and frozen_at is not null', [fixture.future])).length, 0);
  await rejects(() => db.query('update public.roster_entries set lineup_slot=0 where snapshot_id=$1', [receipt.roster_snapshot_id]), /immutable/i);
  await rejects(() => db.query("update public.draft_finalizations set note='Rewritten receipt' where season_id=$1", [season]), /immutable/i);
  await rejects(() => db.query('delete from public.historical_draft_selections where season_id=$1', [season]), /immutable/i);
}));

test('future keeper costs use nominal bases, reset fresh draft cycles, and retain first-round and five-season ineligibility', () => isolated(async () => {
  const fixture = await completed(); await user(); await finalize(); await db.exec('reset role');
  const profiles = await rows<{ player_id: number; base_round: number | null; tenure_years: number; verification: string }>('select player_id,base_round,tenure_years,verification from public.keeper_profiles where season_id=$1', [fixture.future]);
  assert.equal(profiles.length, 104);
  const overpaid = profiles.find(row => row.player_id === fixture.keepers[0].player_id)!;
  assert.deepEqual({ base: overpaid.base_round, tenure: overpaid.tenure_years, status: overpaid.verification }, { base: 7, tenure: 3, status: 'confirmed' });
  const exhausted = profiles.find(row => row.player_id === fixture.keepers[1].player_id)!;
  assert.equal(exhausted.tenure_years, 5); assert.equal(exhausted.base_round, 6); assert.equal(exhausted.verification, 'ineligible');
  for (const fresh of fixture.fresh) {
    const profile = profiles.find(row => row.player_id === fresh.player)!;
    assert.equal(profile.tenure_years, 1);
    assert.equal(profile.base_round, fresh.pick.round === 1 ? null : fresh.pick.round - 1);
    assert.equal(profile.verification, fresh.pick.round === 1 ? 'ineligible' : 'confirmed');
  }
  const history = (await rows('select round,base_keeper_round,tenure_after,was_keeper from public.historical_draft_selections where season_id=$1 and player_id=$2', [season, fixture.keepers[0].player_id]))[0];
  assert.deepEqual(history, { round: 6, base_keeper_round: 8, tenure_after: 3, was_keeper: true });
}));

test('traded players use final ownership while historical pick payer and keeper cost remain intact', () => isolated(async () => {
  const fixture = await completed(), keeper = fixture.keepers[0], fresh = fixture.fresh.find(row => row.pick.round === 12)!;
  const keeperReceiver = teams.find(team => team !== keeper.franchise_id)!, freshReceiver = teams.find(team => team !== fresh.pick.current_owner_id)!;
  await user();
  await db.query('select public.execute_live_draft_trade($1,$2,$3::jsonb,$4::jsonb,$5)', [season, revision,
    JSON.stringify([{ playerId: keeper.player_id, fromFranchiseId: keeper.franchise_id, toFranchiseId: keeperReceiver },
      { playerId: fresh.player, fromFranchiseId: fresh.pick.current_owner_id, toFranchiseId: freshReceiver }]), '[]', 'Reviewed final draft player transfers.']);
  await finalize(revision + 1); await db.exec('reset role');
  for (const item of [{ id: keeper.player_id, original: keeper.franchise_id, final: keeperReceiver }, { id: fresh.player, original: fresh.pick.current_owner_id, final: freshReceiver }]) {
    assert.equal((await rows<{ franchise_id: string }>('select franchise_id from public.player_ownerships where season_id=$1 and player_id=$2', [season, item.id]))[0].franchise_id, item.final);
    const history = (await rows<{ franchise_id: string; source_metadata: unknown }>('select franchise_id,source_metadata from public.historical_draft_selections where season_id=$1 and player_id=$2', [season, item.id]))[0];
    assert.equal(history.franchise_id, item.original); assert.ok(JSON.stringify(history.source_metadata).includes(item.final));
  }
  assert.equal((await rows<{ base_round: number }>('select base_round from public.keeper_profiles where season_id=$1 and player_id=$2', [fixture.future, fresh.player]))[0].base_round, 11);
}));

test('replaying a committed finalization returns the receipt without advancing any state', () => isolated(async () => {
  const fixture = await completed(); await user(); const first = await finalize();
  await db.exec('reset role');
  const player = fixture.fresh[0];
  await db.query('update public.player_ownerships set franchise_id=$3 where season_id=$1 and player_id=$2',
    [season, player.player, teams.find(team => team !== player.pick.current_owner_id)!]);
  const saved = await state();
  await user(); const replay = await finalize(revision); assert.deepEqual(replay, first);
  assert.deepEqual(await state(), saved);
}));

test('stale revisions, incomplete picks, missing reveal/order and incomplete clocks reject atomically', () => isolated(async () => {
  const fixture = await completed();
  const mutations = [
    "update public.seasons set draft_revision=draft_revision+1 where id=$1",
    "update public.draft_picks set status='available' where id=$1",
    "update public.seasons set keepers_revealed_at=null where id=$1",
    "update public.season_teams set draft_position=null where season_id=$1",
    "update private.live_draft_clocks set status='paused',remaining_seconds=90 where season_id=$1",
  ];
  for (const [index, mutation] of mutations.entries()) {
    await db.exec('reset role; savepoint invalid_fixture');
    if (index === 3) await db.query("update private.live_draft_clocks set status='waiting',started_at=null where season_id=$1", [season]);
    await db.query(mutation, [index === 1 ? fixture.fresh[0].pick.id : season]);
    if (index === 3) await db.query("update private.live_draft_clocks set status='completed',started_at=now() where season_id=$1", [season]);
    const before = await state(); await user(); await rejects(() => finalize());
    assert.deepEqual(await state(), before); await db.exec('rollback to savepoint invalid_fixture');
  }
  await user(); await rejects(() => finalize(null));
}));

test('conflicting historical records and preexisting future keeper profiles are rejected without partial ownership changes', () => isolated(async () => {
  const fixture = await completed(), keeper = fixture.keepers[0];
  await db.exec('savepoint conflicting_history');
  await db.query(`insert into public.historical_draft_selections(season_id,franchise_id,player_id,round,overall_pick,was_keeper)
    values($1,$2,$3,1,1,false)`, [season, keeper.franchise_id, keeper.player_id]);
  const before = await state(); await user(); await rejects(() => finalize()); assert.deepEqual(await state(), before);
  await db.exec('rollback to savepoint conflicting_history');
  await db.query(`insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation)
    select $1,$2,league_id,rule_version_id,13,1,'confirmed','Preexisting reviewed future profile' from public.seasons where id=$1`, [fixture.future, keeper.player_id]);
  const withProfile = await state(); await user(); await rejects(() => finalize()); assert.deepEqual(await state(), withProfile);
}));

test('used picks without one unambiguous player cannot finalize', () => isolated(async () => {
  const fixture = await completed();
  await db.exec('savepoint missing_selection');
  await db.query(`update public.live_draft_selections set voided_at=clock_timestamp(),voided_revision=96
    where season_id=$1 and pick_id=$2`, [season, fixture.fresh[0].pick.id]);
  const missing = await state(); await user(); await rejects(() => finalize()); assert.deepEqual(await state(), missing);
  await db.exec('rollback to savepoint missing_selection');
  const keeper = fixture.keepers[0];
  await db.query(`insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision)
    select $1,$2,$3,$4,full_name,1 from public.draft_player_catalog where player_id=$4`, [season, keeper.pick_id, keeper.franchise_id, keeper.player_id]);
  const ambiguous = await state(); await user(); await rejects(() => finalize()); assert.deepEqual(await state(), ambiguous);
}));

test('future keeper season must remain in setup and no final eligibility roster is invented', () => isolated(async () => {
  const fixture = await completed();
  await db.query("update public.seasons set phase='keeper_selection' where id=$1", [fixture.future]);
  const before = await state(); await user(); await rejects(() => finalize()); assert.deepEqual(await state(), before);
}));

test('a failure saving the final receipt rolls back player inserts, history, ownership and future profiles together', () => isolated(async () => {
  await completed();
  await db.exec(`create function public.reject_finalization_fixture() returns trigger language plpgsql as $$ begin
    raise exception 'Injected finalization failure'; end $$;
    create trigger reject_finalization_fixture before insert on public.draft_finalizations
    for each row execute function public.reject_finalization_fixture();`);
  const before = await state(); await user(); await rejects(() => finalize(), /Injected finalization failure/);
  assert.deepEqual(await state(), before);
}));
