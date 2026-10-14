import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { draftBoardSchema, type DraftBoard } from '../../src/lib/draft-board';
import { liveDraftTradeSchema, type LiveDraftTradeInput } from '../../src/lib/draft-trade';

const db = new PGlite();
const commissioner = '96000000-0000-4000-8000-000000000001', manager = '96000000-0000-4000-8000-000000000002', outsider = '96000000-0000-4000-8000-000000000003';
const candidates = [910000001, 910000002, 910000003];
let league: string, season: string, teams: string[];
type PlayerLeg = LiveDraftTradeInput['players'][number];
type PickLeg = LiveDraftTradeInput['picks'][number];
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8'));
  league = (await db.query<{ id: string }>('select id from public.leagues')).rows[0].id;
  season = (await db.query<{ id: string }>('select id from public.seasons where draft_year=2026')).rows[0].id;
  teams = (await db.query<{ id: string }>('select id from public.franchises order by espn_team_id')).rows.map(row => row.id);
  await db.query('insert into auth.users(id) values($1),($2),($3)', [commissioner, manager, outsider]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true)", [league, commissioner, manager]);
  for (const [index, id] of candidates.entries()) await db.query('insert into public.draft_player_catalog values($1,$2,true,$3,2027)', [id, `Draft trade player ${index + 1}`, 'b'.repeat(64)]);
});
after(async () => db.close());
async function user(id: string | null = commissioner, role = 'authenticated') {
  await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']); await db.exec(`set local role ${role}`);
}
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint rejected'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejected'); }
}
async function board(): Promise<DraftBoard> { return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.get_draft_board($1) as value', [season])).rows[0].value); }
async function trade(revision: number | null, players: PlayerLeg[] = [], picks: PickLeg[] = [], note = 'Commissioner records agreed live draft trade'): Promise<DraftBoard> {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.execute_live_draft_trade($1,$2,$3::jsonb,$4::jsonb,$5) as value', [season, revision, JSON.stringify(players), JSON.stringify(picks), note])).rows[0].value);
}
async function action(value: DraftBoard, operation: string, pickId: string | null = null, playerId: number | null = null): Promise<DraftBoard> {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.update_draft_board($1,$2,$3,$4::uuid[],$5,$6,$7) as value', [season, value.revision, operation, operation === 'set_order' ? teams : null, pickId, playerId, 'Reviewed fixture draft change'])).rows[0].value);
}
async function clock(value: DraftBoard, operation: string): Promise<DraftBoard> {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.control_draft_clock($1,$2,$3,null) as value', [season, value.revision, operation])).rows[0].value);
}
async function ready(ordered = true) {
  const keeper = (await db.query<{ player_id: number; pick_id: string; franchise_id: string }>(`select kp.player_id,p.id as pick_id,po.franchise_id from public.keeper_profiles kp
    join public.player_ownerships po on po.season_id=kp.season_id and po.player_id=kp.player_id
    join public.draft_picks p on p.season_id=kp.season_id and p.current_owner_id=po.franchise_id and p.round=kp.base_round
    where kp.season_id=$1 and kp.verification='confirmed' and kp.tenure_years<5 order by kp.base_round desc,kp.player_id limit 1`, [season])).rows[0];
  await user(); await db.query('select public.open_keeper_selection($1,$2)', [season, 'Reviewed season fixture']);
  for (const team of teams) {
    const saved = (await db.query<{ value: { id: string } }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, team, JSON.stringify(team === keeper.franchise_id ? [{ player_id: keeper.player_id, pick_id: keeper.pick_id }] : [])])).rows[0].value;
    for (const transition of ['submit', 'approve', 'lock']) await db.query('select public.transition_keeper_submission($1,1,$2,null)', [saved.id, transition]);
  }
  let value = await board();
  if (ordered) value = await action(value, 'set_order');
  return { keeper, value };
}
function pickLeg(pickId: string, fromFranchiseId: string, toFranchiseId: string): PickLeg { return { pickId, fromFranchiseId, toFranchiseId }; }
function playerLeg(playerId: number, fromFranchiseId: string, toFranchiseId: string): PlayerLeg { return { playerId, fromFranchiseId, toFranchiseId }; }
async function future() { await db.exec('reset role'); return (await db.query<{ value: { seasonId: string } }>('select private.provision_2027_trade_picks() as value')).rows[0].value.seasonId; }

test('request schema rejects empty, duplicate, self, excessive, forged and malformed trades', () => {
  const base = { seasonId: commissioner, expectedRevision: 0, players: [playerLeg(1, commissioner, manager)], picks: [], note: 'Agreed trade' };
  assert.equal(liveDraftTradeSchema.safeParse(base).success, true);
  for (const invalid of [{ ...base, players: [] }, { ...base, players: [...base.players, ...base.players] }, { ...base, players: [playerLeg(1, commissioner, commissioner)] },
    { ...base, expectedRevision: -1 }, { ...base, note: 'no' }, { ...base, immediate: true }, { ...base, players: [playerLeg(1.5, commissioner, manager)] },
    { ...base, picks: [pickLeg('bad', commissioner, manager)] }]) assert.equal(liveDraftTradeSchema.safeParse(invalid).success, false);
});

test('revealed keepers have live roster owners before draft order publication and hidden keepers remain private', () => isolated(async () => {
  const { keeper, value } = await ready(false);
  const kept = value.picks.find(pick => pick.id === keeper.pick_id)!;
  assert.equal(value.orderComplete, false); assert.equal(kept.overallPick, null); assert.equal(kept.currentOwnerId, null);
  assert.equal(kept.rosterOwnerId, keeper.franchise_id);
  const receiver = teams.find(team => team !== keeper.franchise_id)!;
  const moved = await trade(value.revision, [playerLeg(keeper.player_id, keeper.franchise_id, receiver)]);
  assert.equal(moved.picks.find(pick => pick.id === keeper.pick_id)!.rosterOwnerId, receiver);
  await db.exec('reset role'); await db.query('update public.seasons set keepers_revealed_at=null where id=$1', [season]);
  await user(null, 'anon');
  assert.ok((await board()).picks.every(pick => pick.playerId === null && pick.rosterOwnerId === null && pick.status === 'available'));
  await rejects(() => db.query('select * from public.live_draft_roster_ownership'), /permission denied/);
}));

test('keeper trades preserve payer, paid pick, nominal cost, tenure and frozen ownership, and create public immutable history', () => isolated(async () => {
  const { keeper, value } = await ready();
  const receiver = teams.find(team => team !== keeper.franchise_id)!;
  const history = (await db.query('select * from public.keeper_season_records where season_id=$1', [season])).rows;
  const ownership = (await db.query('select * from public.player_ownerships order by player_id')).rows;
  const originalPick = value.picks.find(pick => pick.id === keeper.pick_id)!;
  const moved = await trade(value.revision, [playerLeg(keeper.player_id, keeper.franchise_id, receiver)]);
  const updatedPick = moved.picks.find(pick => pick.id === keeper.pick_id)!;
  assert.equal(updatedPick.rosterOwnerId, receiver); assert.equal(updatedPick.currentOwnerId, originalPick.currentOwnerId);
  assert.equal(updatedPick.overallPick, originalPick.overallPick); assert.equal(updatedPick.status, 'keeper');
  assert.deepEqual((await db.query('select * from public.keeper_season_records where season_id=$1', [season])).rows, history);
  assert.deepEqual((await db.query('select * from public.player_ownerships order by player_id')).rows, ownership);
  const recorded = (await db.query<{ id: string; status: string; source_metadata: { kind: string } }>("select id,status,source_metadata from public.trades where source_metadata->>'kind'='live_draft_trade'")).rows[0];
  assert.equal(recorded.status, 'finalized'); assert.equal(recorded.source_metadata.kind, 'live_draft_trade');
  await user(null, 'anon'); assert.equal((await db.query('select 1 from public.trade_player_transfers where trade_id=$1', [recorded.id])).rows.length, 1);
  await db.exec('reset role');
  await rejects(() => db.query("update public.trades set terms='Rewrite' where id=$1", [recorded.id]), /immutable/);
  await rejects(() => db.query('delete from public.trade_player_transfers where trade_id=$1', [recorded.id]), /immutable/);
  assert.equal((await db.query("select 1 from public.audit_events where event_type='live_draft_trade_recorded'")).rows.length, 1);
}));

test('same-year and next-year pick swaps are atomic, preserve original slots, and pause a running clock without resetting time', () => isolated(async () => {
  const futureSeason = await future();
  const { value: initial } = await ready();
  let value = await clock(initial, 'start');
  const a = value.picks.find(pick => pick.currentOwnerId === teams[0] && pick.status === 'available')!;
  const b = value.picks.find(pick => pick.currentOwnerId === teams[1] && pick.status === 'available')!;
  const later = (await db.query<{ id: string }>('select id from public.draft_picks where season_id=$1 and current_owner_id=$2 order by round limit 1', [futureSeason, teams[1]])).rows[0];
  await db.exec('reset role'); await db.query("update private.live_draft_clocks set deadline_at=clock_timestamp()+interval '42 seconds' where season_id=$1", [season]); await user();
  value = await trade(value.revision, [], [pickLeg(a.id, teams[0], teams[1]), pickLeg(b.id, teams[1], teams[0]), pickLeg(later.id, teams[1], teams[0])]);
  const transferred = value.picks.find(pick => pick.id === a.id)!;
  assert.equal(transferred.currentOwnerId, teams[1]); assert.equal(transferred.originalFranchiseId, a.originalFranchiseId); assert.equal(transferred.overallPick, a.overallPick);
  assert.equal(value.clock.status, 'paused'); assert.ok(value.clock.remainingSeconds! > 35 && value.clock.remainingSeconds! <= 42);
  assert.equal((await db.query<{ current_owner_id: string }>('select current_owner_id from public.draft_picks where id=$1', [later.id])).rows[0].current_owner_id, teams[0]);
  assert.equal((await db.query<{ draft_revision: number }>('select draft_revision from public.seasons where id=$1', [futureSeason])).rows[0].draft_revision, 1);
  await rejects(() => trade(value.revision - 1, [], [pickLeg(a.id, teams[1], teams[0])]), /board changed/);
}));

test('drafted-player transfers block correction/undo until traded back, then clear stale ownership for later redrafts', () => isolated(async () => {
  let { value } = await ready(); value = await clock(value, 'start');
  const selectedPick = value.nextPickId!; value = await action(value, 'record', selectedPick, candidates[0]);
  const owner = value.picks.find(pick => pick.id === selectedPick)!.currentOwnerId!, receiver = teams.find(team => team !== owner)!;
  value = await trade(value.revision, [playerLeg(candidates[0], owner, receiver)]);
  assert.equal(value.picks.find(pick => pick.id === selectedPick)!.rosterOwnerId, receiver);
  await rejects(() => action(value, 'undo', selectedPick), /Trade this player back/);
  await rejects(() => action(value, 'correct', selectedPick, candidates[1]), /Trade this player back/);
  await rejects(() => trade(value.revision, [playerLeg(candidates[0], owner, receiver)]), /not on the sending/);
  value = await trade(value.revision, [playerLeg(candidates[0], receiver, owner)]);
  value = await action(value, 'correct', selectedPick, candidates[1]);
  assert.equal(value.picks.find(pick => pick.id === selectedPick)!.playerId, candidates[1]);
  await db.exec('reset role'); assert.equal((await db.query('select 1 from public.live_draft_roster_ownership where season_id=$1 and player_id=$2', [season, candidates[0]])).rows.length, 0);
  await user(); value = await clock(value, 'resume'); value = await action(value, 'record', value.nextPickId, candidates[0]);
  const redrafted = value.picks.find(pick => pick.playerId === candidates[0])!;
  assert.equal(redrafted.rosterOwnerId, redrafted.currentOwnerId);
}));

test('commissioner, reveal, ownership, duplicate, spent-pick, participant and expiry checks reject without partial transfers', () => isolated(async () => {
  await user(); await rejects(() => trade(0, [playerLeg(candidates[0], teams[0], teams[1])]), /after every keeper/);
  await db.exec('reset role'); const { keeper, value } = await ready();
  const owner = keeper.franchise_id, receiver = teams.find(team => team !== owner)!;
  const players = [playerLeg(keeper.player_id, owner, receiver)];
  for (const id of [manager, outsider]) { await user(id); await rejects(() => trade(value.revision, players), /Commissioner access required/); }
  await user(null, 'anon'); await rejects(() => trade(value.revision, players), /permission denied/); await user();
  const before = JSON.stringify((await board()).picks);
  for (const invalid of [players.concat(players), [playerLeg(candidates[2], owner, receiver)], [playerLeg(keeper.player_id, receiver, owner)], [playerLeg(keeper.player_id, owner, owner)], [playerLeg(keeper.player_id, owner, outsider)]]) {
    await rejects(() => trade(value.revision, invalid), /only once|not on the sending|different sending|participate/);
  }
  await rejects(() => trade(value.revision, players, [pickLeg(keeper.pick_id, owner, receiver)]), /not unspent/);
  const unspent = value.picks.find(pick => pick.currentOwnerId === owner && pick.status === 'available')!;
  await rejects(() => trade(value.revision, players, [pickLeg(unspent.id, owner, receiver), pickLeg(unspent.id, owner, receiver)]), /only once/);
  await rejects(() => trade(value.revision, players, [pickLeg(unspent.id, receiver, owner)]), /not unspent/);
  await rejects(() => trade(value.revision, [], [], 'No assets supplied'), /between 1 and 100/);
  await rejects(() => trade(value.revision, players, [], 'no'), /5 to 2000/);
  await rejects(() => trade(null, players), /board changed/);
  assert.equal(JSON.stringify((await board()).picks), before);
  assert.equal((await db.query("select 1 from public.trades where source_metadata->>'kind'='live_draft_trade'")).rows.length, 0);
  const running = await clock(value, 'start'); await db.exec('reset role');
  await db.query("update private.live_draft_clocks set deadline_at=clock_timestamp()-interval '1 second' where season_id=$1", [season]); await user();
  await rejects(() => trade(running.revision, players), /timer expired/);
}));

test('future-season eligibility and ownership failures roll back every leg', () => isolated(async () => {
  const futureSeason = await future(); const { keeper, value } = await ready();
  const owner = keeper.franchise_id, receiver = teams.find(team => team !== owner)!;
  const later = (await db.query<{ id: string }>('select id from public.draft_picks where season_id=$1 and current_owner_id=$2 limit 1', [futureSeason, owner])).rows[0];
  await db.exec('reset role'); await db.query("update public.seasons set phase='archived' where id=$1", [futureSeason]); await user();
  await rejects(() => trade(value.revision, [playerLeg(keeper.player_id, owner, receiver)], [pickLeg(later.id, owner, receiver)]), /this draft or the next/);
  assert.equal((await board()).picks.find(pick => pick.id === keeper.pick_id)!.rosterOwnerId, owner);
  assert.equal((await db.query<{ current_owner_id: string }>('select current_owner_id from public.draft_picks where id=$1', [later.id])).rows[0].current_owner_id, owner);
  await db.exec('reset role'); await db.query("update public.seasons set phase='setup' where id=$1", [futureSeason]);
  await db.query('delete from public.draft_picks where season_id=$1 and (original_franchise_id=$2 or current_owner_id=$2)', [futureSeason, receiver]);
  await db.query('delete from public.season_teams where season_id=$1 and franchise_id=$2', [futureSeason, receiver]); await user();
  await rejects(() => trade(value.revision, [], [pickLeg(later.id, owner, receiver)]), /Both teams must participate/);
}));

test('deadline inventory captures pre-trade owners for every affected season without changing paid keeper history', () => isolated(async () => {
  const futureSeason = await future(); const { value } = await ready();
  await db.exec('reset role');
  const rule = (await db.query<{ id: string }>(`insert into public.rule_versions(league_id,version,rules)
    select league_id,999,rules||'{"keeper_payment_timing":"deadline_after_all_submissions"}'::jsonb from public.rule_versions where id=(select rule_version_id from public.seasons where id=$1) returning id`, [season])).rows[0].id;
  await db.query("update public.seasons set rule_version_id=$1,keeper_deadline=clock_timestamp()-interval '1 hour',season_time_zone='UTC' where id in ($2,$3)", [rule, season, futureSeason]);
  const a = value.picks.find(pick => pick.currentOwnerId === teams[0] && pick.status === 'available')!;
  const later = (await db.query<{ id: string }>('select id from public.draft_picks where season_id=$1 and current_owner_id=$2 limit 1', [futureSeason, teams[1]])).rows[0];
  await user(); await trade(value.revision, [], [pickLeg(a.id, teams[0], teams[1]), pickLeg(later.id, teams[1], teams[0])]);
  const frozen = (await db.query<{ pick_id: string; franchise_id: string }>('select pick_id,franchise_id from public.keeper_deadline_pick_owners where pick_id in ($1,$2)', [a.id, later.id])).rows;
  assert.equal(frozen.find(pick => pick.pick_id === a.id)!.franchise_id, teams[0]);
  assert.equal(frozen.find(pick => pick.pick_id === later.id)!.franchise_id, teams[1]);
  assert.equal((await db.query('select 1 from public.keeper_payment_deadline_snapshots where season_id in ($1,$2)', [season, futureSeason])).rows.length, 2);
}));
