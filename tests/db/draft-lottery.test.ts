import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { draftLotterySchema, type DraftLotteryState } from '../../src/lib/draft-lottery';
import { calculateWeightedLotteryMarginals, replayWeightedLottery } from '../../src/domain/lottery';

const db = new PGlite();
const commissioner = '73000000-0000-4000-8000-000000000001', manager = '73000000-0000-4000-8000-000000000002', outsider = '73000000-0000-4000-8000-000000000003';
let league: string, season: string, team: string;
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
  ({ id: team } = (await db.query<{ id: string }>('select id from public.franchises order by id limit 1')).rows[0]);
  await db.query('insert into auth.users(id) values($1),($2),($3)', [commissioner, manager, outsider]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true)", [league, commissioner, manager]);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']); await db.exec(`set local role ${role}`); }
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejected'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejected'); } }
async function state(target = season): Promise<DraftLotteryState> { return draftLotterySchema.parse((await db.query<{ value: unknown }>('select public.get_draft_lottery($1) as value', [target])).rows[0].value); }
async function run(target = season): Promise<DraftLotteryState> { return draftLotterySchema.parse((await db.query<{ value: unknown }>('select public.run_draft_lottery($1) as value', [target])).rows[0].value); }

test('public lottery inputs show verified standings and actual algorithm sources without a draw or private identities', () => isolated(async () => {
  await asUser(null, 'anon'); const value = await state();
  assert.equal(value.ready, true); assert.equal(value.hasRun, false); assert.equal(value.result, null);
  assert.deepEqual(value.standings.map(t => [t.regularSeasonPlace, t.espnTeamId]), [[1,7],[2,6],[3,2],[4,1],[5,8],[6,5],[7,4],[8,3]]);
  assert.deepEqual(value.odds!.franchiseIds.map(id => value.standings.find(t => t.franchiseId === id)!.managerLabel), ['Wyndham', 'Sebastian', 'Shane', 'Alex', 'Jon', 'Arod', 'Amber', 'James']);
  assert.deepEqual(value.odds!.weights, [24, 24, 24, 24, 1, 1, 1, 1]);
  assert.equal(value.standings.find(t => t.managerLabel === 'Sebastian')!.displayName, 'The ManyFacedBron');
  assert.equal(value.standings.find(t => t.managerLabel === 'Sebastian')!.priorTeamName, 'Luka Deez Nuts');
  assert.equal(value.standings.filter(t => t.playoffQualified).length, 4);
  const source = (await readFile(new URL('../../src/domain/lottery.ts', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(value.algorithm.typeScriptSource, source);
  assert.equal(value.algorithm.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(value.algorithm.databaseSourceSha256, createHash('sha256').update(value.algorithm.databaseSource).digest('hex'));
  assert.match(value.algorithm.databaseSource, /gen_random_uuid/); assert.match(value.algorithm.databaseSource, /4294967296::bigint \/ remaining_total/);
  assert.equal(value.algorithm.pythonSourceSha256, createHash('sha256').update(value.algorithm.pythonSource!).digest('hex'));
  assert.deepEqual(value.odds!.marginalMatrix, calculateWeightedLotteryMarginals(value.odds!));
  // Source text necessarily names audit fields; its identifiers are not a generated result.
  assert.doesNotMatch(JSON.stringify({ ...value, algorithm: undefined }), /created_by|actor_user_id|randomTicket|priorityOrder|entropyUuid/);
  await rejects(() => db.query('select * from public.draft_lottery_runs'), /permission denied/);
}));

test('a commissioner draw replays exactly, remains private, and repeated calls cannot reroll or republish it', () => isolated(async () => {
  const before = await db.query('select id,phase,draft_revision,keepers_revealed_at,trading_opened_at from public.seasons order by id');
  await asUser(commissioner); const drawn = await run(), result = drawn.result!;
  assert.equal(drawn.hasRun, true); assert.equal(drawn.ready, false); assert.equal(drawn.unavailableReason, null);
  assert.equal(new Set(result.priorityOrder).size, 8);
  const replay = replayWeightedLottery(result.audit, result.audit.steps.map(step => step.ticket));
  assert.deepEqual(replay.priorityOrder, result.priorityOrder);
  assert.deepEqual(replay.steps, result.audit.steps.map(({ priority, remainingTotal, ticket, selectedFranchiseId }) => ({ priority, remainingTotal, ticket, selectedFranchiseId })));
  for (const step of result.audit.steps) {
    const raw = Number.parseInt(step.entropyUuid.replaceAll('-', '').slice(0, 8), 16);
    assert.ok(raw < Math.floor(4294967296 / step.remainingTotal) * step.remainingTotal);
    assert.equal(raw % step.remainingTotal, step.ticket);
  }
  assert.equal(result.sourceSha256, drawn.source!.sha256); assert.equal(result.algorithmSourceSha256, drawn.algorithm.sourceSha256);
  assert.equal(result.databaseSourceSha256, drawn.algorithm.databaseSourceSha256);
  assert.equal(result.pythonSourceSha256, drawn.algorithm.pythonSourceSha256);
  assert.deepEqual(await run(), drawn); assert.deepEqual(await state(), drawn);
  for (const user of [manager, outsider, null]) {
    await asUser(user, user ? 'authenticated' : 'anon'); const publicView = await state();
    assert.equal(publicView.hasRun, true); assert.equal(publicView.result, null);
    assert.doesNotMatch(JSON.stringify({ ...publicView, algorithm: undefined }), /randomTicket|priorityOrder|entropyUuid|created_by|actor_user_id/);
    for (const step of result.audit.steps) assert.equal(JSON.stringify(publicView).includes(step.entropyUuid), false);
  }
  await db.exec('reset role');
  assert.equal((await db.query('select id from public.draft_lottery_runs')).rows.length, 1);
  assert.equal((await db.query("select id from public.audit_events where event_type='draft_lottery_generated'")).rows.length, 1);
  assert.deepEqual((await db.query('select id,phase,draft_revision,keepers_revealed_at,trading_opened_at from public.seasons order by id')).rows, before.rows);
  assert.ok((await db.query<{ lottery_choice_order: number | null; draft_position: number | null }>('select lottery_choice_order,draft_position from public.season_teams')).rows.every(t => t.lottery_choice_order === null && t.draft_position === null));
  await rejects(() => db.query('delete from public.draft_lottery_runs'), /immutable/);
  await rejects(() => db.query("update public.draft_lottery_runs set result='{}'::jsonb"), /immutable/);
}));

test('managers, outsiders, anonymous and revoked commissioners cannot generate or read the private result', () => isolated(async () => {
  for (const user of [manager, outsider]) { await asUser(user); await rejects(run, /Commissioner access required/); }
  await asUser(null, 'anon'); await rejects(run, /permission denied/);
  await asUser(commissioner); await run();
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where user_id=$1', [commissioner]);
  await asUser(commissioner); await rejects(run, /Commissioner access required/); assert.equal((await state()).result, null);
  await rejects(() => db.query('select * from public.draft_lottery_runs'), /permission denied/);
  await db.exec('reset role'); await db.query('update public.leagues set is_public=false where id=$1', [league]);
  await asUser(null, 'anon'); await rejects(state, /League access required/);
  await asUser(outsider); await rejects(state, /League access required/);
  await asUser(manager); assert.equal((await state()).result, null);
}));

test('missing or mismatched standings, expansion and existing draft decisions fail closed without generating a run', () => isolated(async () => {
  await db.query('update public.seasons set participant_count=10 where id=$1', [season]);
  await asUser(commissioner); assert.equal((await state()).ready, false); await rejects(run, /exactly eight/);
  await db.exec('reset role'); await db.query('update public.seasons set participant_count=8 where id=$1', [season]);
  await db.query('update public.franchises set espn_team_id=99 where id=$1', [team]);
  await asUser(commissioner); await rejects(run, /do not match/);
  await db.exec('reset role');
  const expectedId = (await db.query<{ id: number }>("select (value->>'espnTeamId')::integer as id from private.draft_lottery_configurations c,jsonb_array_elements(c.definition->'standings') where value->>'franchiseId'=$1", [team])).rows[0].id;
  await db.query('update public.franchises set espn_team_id=$2 where id=$1', [team, expectedId]);
  for (const column of ['draft_position', 'lottery_choice_order']) {
    await db.query(`update public.season_teams set ${column}=1 where season_id=$1 and franchise_id=$2`, [season, team]);
    await asUser(commissioner); await rejects(run, /prevents a new lottery/);
    await db.exec('reset role'); await db.query(`update public.season_teams set ${column}=null where season_id=$1`, [season]);
  }
  const future = '73000000-0000-4000-8000-000000000050';
  await db.query("insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count) select $2,league_id,'Next season',draft_year+1,rule_version_id,participant_count from public.seasons where id=$1", [season, future]);
  await asUser(commissioner); assert.equal((await state(future)).source, null); await rejects(() => run(future), /Verified prior-season standings/);
  await db.exec('reset role'); assert.equal((await db.query('select id from public.draft_lottery_runs')).rows.length, 0);
}));

test('historical live selections and closed phases prevent a first draw even if their draft order is blank', () => isolated(async () => {
  await db.query(`insert into public.live_draft_selections(season_id,pick_id,franchise_id,player_id,player_name,created_revision,voided_revision,voided_at)
    select $1,p.id,p.current_owner_id,c.player_id,c.full_name,1,2,now() from public.draft_picks p cross join public.draft_player_catalog c where p.season_id=$1 limit 1`, [season]);
  await asUser(commissioner); await rejects(run, /prevents a new lottery/);
  await db.exec('reset role'); await db.exec('delete from public.live_draft_selections');
  for (const phase of ['in_season', 'archived']) {
    await db.query('update public.seasons set phase=$2 where id=$1', [season, phase]);
    await asUser(commissioner); await rejects(run, /closed for this season phase/); await db.exec('reset role');
  }
}));

test('SQL rejects biased entropy and handles every remaining total through a final total of one', () => isolated(async () => {
  // Substitute only the entropy source inside this isolated test transaction;
  // rollback restores the exact production function. The first value is rejected.
  await db.exec(`create sequence private.lottery_test_entropy;
    create function private.lottery_test_uuid() returns uuid language plpgsql as $$
      declare n bigint:=nextval('private.lottery_test_entropy');
      begin return ((case when n=1 then 'ffffffff' else '00000000' end)||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; end $$;`);
  const productionFunction = (await db.query<{ source: string }>("select pg_get_functiondef('public.run_draft_lottery(uuid)'::regprocedure) as source")).rows[0].source;
  await db.exec(productionFunction.replaceAll('gen_random_uuid()', 'private.lottery_test_uuid()'));
  await asUser(commissioner);
  const drawn = await run();
  assert.deepEqual(drawn.result!.priorityOrder, drawn.odds!.franchiseIds);
  assert.deepEqual(drawn.result!.audit.steps.map(step => step.remainingTotal), [100, 76, 52, 28, 4, 3, 2, 1]);
  assert.deepEqual(drawn.result!.audit.steps.map(step => step.ticket), Array(8).fill(0));
  assert.deepEqual(drawn.result!.audit.steps.map(step => step.discardedEntropyDraws), [1, 0, 0, 0, 0, 0, 0, 0]);
}));
