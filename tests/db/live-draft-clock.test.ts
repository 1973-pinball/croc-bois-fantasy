import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { draftBoardSchema, draftQueueSchema, type DraftBoard } from '../../src/lib/draft-board';

const db = new PGlite();
const uuid = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = uuid(1), season = uuid(2), rules = uuid(3), snapshot = uuid(4), a = uuid(10), b = uuid(11);
const owner = uuid(20), otherOwner = uuid(21), commissioner = uuid(22), coOwner = uuid(23), outsider = uuid(24);
const pick = (team: 'a' | 'b', round: number) => uuid((team === 'a' ? 100 : 200) + round);
const players = [900010001, 900010002, 900010003, 900010004, 900010005, 900010006, 900010007, 900010008];

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users(id) values('${owner}'),('${otherOwner}'),('${commissioner}'),('${coOwner}'),('${outsider}');
    insert into public.leagues(id,slug,name) values('${league}','clock-test','Clock Test');
    insert into public.league_memberships values('${league}','${owner}','manager',true),('${league}','${otherOwner}','manager',true),('${league}','${commissioner}','commissioner',true),('${league}','${coOwner}','manager',true);
    insert into public.franchises(id,league_id,name) values('${a}','${league}','A'),('${b}','${league}','B');
    insert into public.managers(id,league_id,display_name) values('${owner}','${league}','A'),('${otherOwner}','${league}','B'),('${coOwner}','${league}','Co-A');
    insert into public.manager_assignments(league_id,franchise_id,manager_id,user_id,effective_from) values('${league}','${a}','${owner}','${owner}','2020-01-01'),('${league}','${b}','${otherOwner}','${otherOwner}','2020-01-01'),('${league}','${a}','${coOwner}','${coOwner}','2020-01-01');
    insert into public.rule_versions(id,league_id,version,draft_rounds) values('${rules}','${league}',1,3);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count,phase) values('${season}','${league}','2026-27',2026,'${rules}',2,'keeper_selection');
    insert into public.season_teams(season_id,franchise_id,league_id,display_name,draft_position) values('${season}','${a}','${league}','A',1),('${season}','${b}','${league}','B',2);
    insert into public.players(id,full_name) values(${players[0]},'Kept player');
    insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,scoring_period,source_sha256) values('${snapshot}','${league}','${season}','2026-03-29',160,repeat('a',64));
    insert into public.roster_entries values('${snapshot}','${season}','${a}',${players[0]},0,'/test',null,null);
    update public.roster_snapshots set frozen_at=now() where id='${snapshot}';
    insert into public.player_ownerships(season_id,player_id,franchise_id,source_snapshot_id) values('${season}',${players[0]},'${a}','${snapshot}');
    insert into public.keeper_profiles(season_id,player_id,league_id,rule_version_id,base_round,tenure_years,verification,explanation) values('${season}',${players[0]},'${league}','${rules}',3,1,'confirmed','Test');
    update public.draft_player_catalog set selectable=false;`);
  for (const [index, id] of players.entries()) {
    await db.query('insert into public.draft_player_catalog(player_id,full_name,selectable,source_sha256,source_season) values($1,$2,$3,$4,2027)', [id, `Clock player ${index + 1}`, index !== 7, 'a'.repeat(64)]);
    await db.query('insert into private.draft_player_rankings(player_id,espn_rank,source_sha256,source_season) values($1,$2,$3,2027)', [id, index === 6 ? null : index + 1, 'a'.repeat(64)]);
  }
  for (const team of ['a', 'b'] as const) for (let round = 1; round <= 3; round++) await db.query('insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round) values($1,$2,$3,$3,$4)', [pick(team, round), season, team === 'a' ? a : b, round]);
});
after(async () => db.close());

async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function user(id = commissioner, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id]); await db.exec(`set local role ${role}`); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
async function board() { return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.get_draft_board($1) as value', [season])).rows[0].value); }
async function control(action: string, revision: number | null, seconds: number | null = null) {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.control_draft_clock($1,$2,$3,$4) as value', [season, revision, action, seconds])).rows[0].value);
}
async function tick() { return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.tick_draft_clock($1) as value', [season])).rows[0].value); }
async function queue(team = a) { return draftQueueSchema.parse((await db.query<{ value: unknown }>('select public.get_draft_queue($1,$2) as value', [season, team])).rows[0].value); }
async function saveQueue(ids: number[], revision = 0, team = a) { return draftQueueSchema.parse((await db.query<{ value: unknown }>('select public.save_draft_queue($1,$2,$3,$4::bigint[]) as value', [season, team, revision, ids])).rows[0].value); }
async function record(value: DraftBoard, id: number, action = 'record', selectedPick = value.nextPickId) {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.update_draft_board($1,$2,$3,null,$4,$5,$6) as value', [season, value.revision, action, selectedPick, action === 'undo' ? null : id, action === 'record' ? null : 'Reviewed selection correction.'])).rows[0].value);
}
async function reveal(keep = false) {
  await user();
  for (const team of [a, b]) {
    const assignments = keep && team === a ? [{ player_id: players[0], pick_id: pick('a', 3) }] : [];
    const saved = (await db.query<{ value: { id: string } }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, team, JSON.stringify(assignments)])).rows[0].value;
    for (const action of ['submit', 'approve', 'lock']) await db.query('select public.transition_keeper_submission($1,1,$2,null)', [saved.id, action]);
  }
  return board();
}
async function expire() { await db.exec('reset role'); await db.query("update private.live_draft_clocks set deadline_at=clock_timestamp()-interval '1 second' where season_id=$1", [season]); }

test('only active commissioners configure and start the default 90-second clock after reveal and complete order', () => isolated(async () => {
  await user('', 'anon');
  assert.equal((await board()).clock.durationSeconds, 90);
  assert.equal((await board()).clock.status, 'waiting');
  for (const id of [owner, coOwner, outsider]) {
    await user(id);
    for (const action of ['configure', 'start', 'pause', 'resume']) await rejects(() => control(action, 0, action === 'configure' ? 30 : null), /Commissioner access/);
  }
  await user('', 'anon'); await rejects(() => control('start', 0), /permission denied/);
  await user();
  await rejects(() => control('start', 0), /keeper.*locked|keeper.*reveal/i);
  for (const seconds of [9, 601, null]) await rejects(() => control('configure', 0, seconds), /10.*600|duration/i);
  let value = await control('configure', 0, 45);
  assert.equal(value.clock.durationSeconds, 45); assert.equal(value.revision, 1);
  await rejects(() => control('configure', 0, 60), /draft board changed/);
  await rejects(() => control('configure', null, 60), /draft board changed/);
  await reveal();
  await db.exec('reset role'); await db.query('update public.season_teams set draft_position=null where season_id=$1', [season]); await user();
  await rejects(() => control('start', 1), /complete draft order/i);
  await db.query("select public.update_draft_board($1,1,'set_order',$2::uuid[],null,null,'Verified draft order.')", [season, [a, b]]);
  value = await control('start', 2);
  assert.equal(value.clock.status, 'running'); assert.ok(value.clock.startedAt); assert.ok(value.clock.deadlineAt); assert.equal(value.orderLocked, true);
  assert.ok(value.clock.remainingSeconds! > 43 && value.clock.remainingSeconds! <= 45);
  await rejects(() => control('configure', value.revision, 90), /before.*start|already started|fixed/i);
  await rejects(() => db.query("select public.update_draft_board($1,$2,'set_order',$3::uuid[],null,null,'Attempt reordered slots.')", [season, value.revision, [b, a]]), /fixed after/);
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where user_id=$1', [commissioner]); await user();
  await rejects(() => control('pause', value.revision), /Commissioner access/);
}));

test('queues are private shared team priorities with revision checks and current assignment enforcement', () => isolated(async () => {
  await user(owner);
  assert.deepEqual(await queue(), { seasonId: season, franchiseId: a, revision: 0, playerIds: [] });
  const first = await saveQueue([players[4], players[2]]);
  assert.equal(first.revision, 1); assert.deepEqual(first.playerIds, [players[4], players[2]]);
  await rejects(() => saveQueue([players[3]], 0), /queue.*changed/i);
  await rejects(() => saveQueue([players[3], players[3]], 1), /duplicate|once|unique/i);
  await rejects(() => saveQueue([players[7]], 1), /verified ESPN|active player|available/i);
  await rejects(() => saveQueue([999999999], 1), /verified ESPN|active player|available/i);
  await user(coOwner);
  assert.deepEqual(await queue(), first);
  const reordered = await saveQueue([players[2], players[4]], 1);
  assert.equal(reordered.revision, 2); assert.deepEqual(reordered.playerIds, [players[2], players[4]]);
  for (const id of [otherOwner, outsider, commissioner]) {
    await user(id);
    await rejects(() => queue(), /assigned|manager|access/i);
    await rejects(() => saveQueue([], 2), /assigned|manager|access/i);
  }
  await user('', 'anon'); await rejects(() => queue(), /permission denied/);
  assert.doesNotMatch(JSON.stringify(await board()), /playerIds|draft_queues|queueRevision/);
  for (const role of ['anon', 'authenticated']) {
    await user(role === 'anon' ? '' : owner, role);
    await rejects(() => db.query('select * from private.draft_queues'), /permission denied/);
  }
  await db.exec('reset role'); await db.query("update public.manager_assignments set effective_to=now()-interval '1 hour' where user_id=$1", [coOwner]); await user(coOwner);
  await rejects(() => queue(), /assigned|manager|access/i);
  await user(owner); assert.deepEqual(await queue(), reordered);
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where user_id=$1', [owner]); await user(owner);
  await rejects(() => queue(), /assigned|manager|access/i);
  await rejects(() => saveQueue([], 2), /assigned|manager|access/i);
}));

test('drafting requires a running clock and authorizes the current traded owner and co-manager, with commissioner-only corrections', () => isolated(async () => {
  let value = await reveal();
  await rejects(() => record(value, players[0]), /start|running/i);
  value = await control('start', value.revision);
  await db.exec('reset role'); await db.query('update public.draft_picks set current_owner_id=$2 where id=$1', [pick('a', 1), b]);
  await user(owner); await rejects(() => record(value, players[0]), /owner|assigned|manager|turn/i);
  await user(otherOwner); value = await record(value, players[0]);
  assert.equal(value.picks[0].currentOwnerId, b); assert.equal(value.picks[0].playerId, players[0]);
  await rejects(() => record(value, players[1], 'correct', pick('a', 1)), /Commissioner access/);
  await rejects(() => record(value, players[1], 'undo', pick('a', 1)), /Commissioner access/);
  await user(); value = await record(value, players[1]); // Commissioner can record for B.
  value = await record(value, players[2]); // Snake round two starts with B.
  await user(coOwner); value = await record(value, players[3]);
  assert.equal(value.picks[3].currentOwnerId, a); assert.equal(value.picks[3].playerId, players[3]);
  await user(); value = await control('pause', value.revision);
  await user(owner); await rejects(() => record(value, players[4]), /start or resume/i);
}));

test('pause preserves remaining time, blocks ticks, and resume continues that countdown with configuration fixed', () => isolated(async () => {
  let value = await reveal(); value = await control('start', value.revision);
  await db.exec('reset role'); await db.query("update private.live_draft_clocks set deadline_at=clock_timestamp()+interval '31 seconds' where season_id=$1", [season]); await user();
  value = await control('pause', value.revision);
  assert.equal(value.clock.status, 'paused'); assert.equal(value.clock.deadlineAt, null);
  assert.ok(value.clock.remainingSeconds! > 29 && value.clock.remainingSeconds! <= 31);
  const remaining = value.clock.remainingSeconds!;
  await user('', 'anon'); const paused = await tick();
  assert.equal(paused.revision, value.revision); assert.equal(paused.clock.remainingSeconds, remaining);
  assert.ok(paused.picks.every(p => p.status === 'available'));
  await user(); await rejects(() => control('configure', value.revision, 120), /before.*start|already started|fixed/i);
  await rejects(() => control('resume', value.revision - 1), /draft board changed/);
  value = await control('resume', value.revision);
  assert.equal(value.clock.status, 'running'); assert.ok(value.clock.remainingSeconds! <= remaining); assert.ok(value.clock.remainingSeconds! > remaining - 2);
  assert.equal(value.clock.durationSeconds, 90);
  value = await record(value, players[1]);
  assert.ok(value.clock.remainingSeconds! > 88 && value.clock.remainingSeconds! <= 90, 'A successful selection starts a full clock for the next pick.');
}));

test('expired public ticks use the current owner queue, then ESPN rank, skipping kept and drafted players and remaining idempotent', () => isolated(async () => {
  await user(otherOwner); await saveQueue([players[0], players[4], players[2]], 0, b);
  await user(owner); await saveQueue([players[5]], 0, a);
  let value = await reveal(true); value = await control('start', value.revision);
  const before = value.revision;
  await user('', 'anon'); assert.equal((await tick()).revision, before, 'Early callers cannot force a selection.');
  await db.exec('reset role'); await db.query('update public.draft_picks set current_owner_id=$2 where id=$1', [pick('a', 1), b]);
  await expire(); await user('', 'anon');
  const results = await Promise.all([tick(), tick(), tick()]);
  assert.ok(results.every(result => result.revision === before + 1));
  value = await board();
  assert.equal(value.picks[0].currentOwnerId, b); assert.equal(value.picks[0].playerId, players[4]);
  assert.equal(value.picks.filter(p => p.status === 'selected').length, 1);
  assert.equal(value.picks.find(p => p.id === pick('a', 3))!.status, 'keeper');
  await user(otherOwner); const saved = await queue(b); assert.equal(saved.playerIds.includes(players[4]), false);
  assert.equal(saved.revision, 2); await rejects(() => saveQueue([players[2]], 1, b), /queue.*changed/i);
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[1].playerId, players[2]);
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[2].playerId, players[1], 'An exhausted queue falls back to the best available ESPN rank.');
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[3].playerId, players[5], 'A takes its own queue priority.');
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[5].playerId, players[3]);
  assert.equal(value.clock.status, 'completed'); assert.equal(value.clock.deadlineAt, null); assert.equal(value.nextPickId, null);
  assert.equal(new Set(value.picks.map(p => p.playerId)).size, value.picks.length);
  assert.equal((await tick()).revision, value.revision);
  await user(); await rejects(() => control('resume', value.revision), /completed|paused/i);
  await user(otherOwner); const completedQueue = await queue(b);
  await rejects(() => saveQueue([], completedQueue.revision, b), /closed/i);
}));

test('an expired deadline wins over a late manual pick and cannot produce two selections for one slot', () => isolated(async () => {
  let value = await reveal(); value = await control('start', value.revision);
  await expire(); await user(owner);
  await rejects(() => record(value, players[5]), /expired|clock|draft board changed/i);
  await user('', 'anon'); const advanced = await tick();
  assert.equal(advanced.picks[0].playerId, players[0]);
  assert.equal(advanced.picks.filter(p => p.status === 'selected').length, 1);
  assert.equal(advanced.revision, value.revision + 1);
  await user(owner); await rejects(() => record(value, players[5]), /draft board changed/);
}));

test('late queue edits and pause cannot replace an already expired selection', () => isolated(async () => {
  let value = await reveal();
  await user(owner); await saveQueue([players[3]]);
  await user(); value = await control('start', value.revision);
  await expire(); await user(owner);
  await rejects(() => saveQueue([players[5]], 1), /timer expired/i);
  await user(); const paused = await control('pause', value.revision);
  assert.equal(paused.picks[0].playerId, players[3]);
  assert.equal(paused.clock.status, 'paused'); assert.equal(paused.clock.remainingSeconds, 90);
  assert.equal(paused.revision, value.revision + 2, 'Expiration records the selection before pausing the following pick.');
  await user('', 'anon'); assert.equal((await tick()).revision, paused.revision);
}));

test('scheduled ticks advance private leagues without a browser identity while browser roles cannot run the worker', () => isolated(async () => {
  let value = await reveal(); value = await control('start', value.revision);
  await expire(); await db.query('update public.leagues set is_public=false where id=$1', [league]);
  await user('', 'anon'); await rejects(() => tick(), /League access/);
  for (const role of ['anon', 'authenticated']) {
    await user(role === 'anon' ? '' : owner, role);
    await rejects(() => db.query('select private.tick_live_drafts()'), /permission denied/);
  }
  await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',true)");
  assert.equal((await db.query<{ count: number }>('select private.tick_live_drafts() as count')).rows[0].count, 1);
  await user(); const advanced = await board();
  assert.equal(advanced.revision, value.revision + 1); assert.equal(advanced.picks[0].playerId, players[0]);
}));

test('rank fallback checks artifact provenance, puts unranked players last, and pauses safely when the pool is exhausted', () => isolated(async () => {
  let value = await reveal(); value = await control('start', value.revision);
  await db.exec('reset role');
  await db.query('update private.draft_player_rankings set source_sha256=$2 where player_id=$1', [players[0], 'b'.repeat(64)]);
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[0].playerId, players[1], 'A rank from a different catalog artifact cannot drive an automatic pick.');
  await db.exec('reset role'); await db.query('update public.draft_player_catalog set selectable=false where player_id<>$1', [players[6]]);
  await expire(); await user('', 'anon'); value = await tick();
  assert.equal(value.picks[1].playerId, players[6], 'A verified unranked player can fill the pool after ranked players are unavailable.');
  await expire(); await user('', 'anon'); const exhausted = await tick();
  assert.equal(exhausted.clock.status, 'paused'); assert.equal(exhausted.clock.remainingSeconds, 0);
  assert.equal(exhausted.picks.filter(p => p.status === 'selected').length, 2);
  assert.equal(exhausted.revision, value.revision + 1);
  assert.equal((await tick()).revision, exhausted.revision);
}));
