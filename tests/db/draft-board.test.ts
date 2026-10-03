import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { draftBoardSchema, type DraftBoard } from '../../src/lib/draft-board';

const db = new PGlite();
const commissioner = '71000000-0000-4000-8000-000000000001', manager = '71000000-0000-4000-8000-000000000002', outsider = '71000000-0000-4000-8000-000000000003';
const candidates = [900000001, 900000002, 900000003, 900000004];
let league: string, season: string, teams: string[];
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
  teams = (await db.query<{ id: string }>('select id from public.franchises order by espn_team_id')).rows.map(r => r.id);
  await db.query('insert into auth.users(id) values($1),($2),($3)', [commissioner, manager, outsider]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true)", [league, commissioner, manager]);
  for (const [index, id] of candidates.entries()) await db.query("insert into public.draft_player_catalog values($1,$2,$3,$4,2027)", [id, `Verified player ${index + 1}`, index !== 3, 'a'.repeat(64)]);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']);
  await db.exec(`set local role ${role}`);
}
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); }
}
async function board(): Promise<DraftBoard> { return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.get_draft_board($1) as value', [season])).rows[0].value); }
async function change(action: string, revision: number | null, pick: string | null = null, player: number | null = null, order: string[] | null = null, note: string | null = 'Verified commissioner change.'): Promise<DraftBoard> {
  return draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.update_draft_board($1,$2,$3,$4::uuid[],$5,$6,$7) as value', [season, revision, action, order, pick, player, note])).rows[0].value);
}
async function trade(players: unknown[] = [], picks: unknown[] = [], obligations: unknown[] = []) {
  return (await db.query<{ id: string }>('select public.create_trade($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) as id', [season, picks.length || obligations.length ? 'advanced' : 'player_only', 'Reviewed trade fixture', JSON.stringify(players), JSON.stringify(picks), JSON.stringify(obligations)])).rows[0].id;
}
async function matureTrade(id: string) {
  await db.exec('reset role');
  // Isolated fixture simulates elapsed time. The application cannot skip the review window.
  await db.query("update public.trades set created_at=now()-interval '25 hours',review_deadline=now()-interval '1 hour' where id=$1", [id]);
  await asUser(commissioner);
}
async function openDraft(keep = false) {
  await asUser(commissioner);
  await db.query('select public.open_keeper_selection($1,$2)', [season, 'Verified frozen season.']);
  let keeper: { player_id: number; pick_id: string; franchise_id: string } | undefined;
  if (keep) {
    await db.exec('reset role');
    keeper = (await db.query<{ player_id: number; pick_id: string; franchise_id: string }>(`select kp.player_id,p.id as pick_id,po.franchise_id from public.keeper_profiles kp
      join public.player_ownerships po on po.season_id=kp.season_id and po.player_id=kp.player_id
      join public.draft_picks p on p.season_id=kp.season_id and p.current_owner_id=po.franchise_id and p.round=kp.base_round
      where kp.season_id=$1 and kp.verification='confirmed' and kp.tenure_years<5 order by kp.base_round desc limit 1`, [season])).rows[0];
    await db.query("insert into public.draft_player_catalog values($1,'Verified keeper',true,$2,2027) on conflict(player_id) do nothing", [keeper.player_id, 'a'.repeat(64)]);
    await asUser(commissioner);
  }
  for (const team of teams) {
    const saved = (await db.query<{ value: { id: string } }>('select public.save_keeper_submission($1,$2,0,$3::jsonb) as value', [season, team, JSON.stringify(keeper?.franchise_id === team ? [{ player_id: keeper.player_id, pick_id: keeper.pick_id }] : [])])).rows[0].value;
    for (const action of ['submit', 'approve', 'lock']) await db.query('select public.transition_keeper_submission($1,1,$2,null)', [saved.id, action]);
  }
  return keeper;
}

test('database catalog matches the reviewed ESPN artifact and its import is inaccessible to browser roles', () => isolated(async () => {
  const catalog = JSON.parse(await readFile(new URL('../../data/draft-player-catalog.json', import.meta.url), 'utf8')) as { source: { sha256: string }; espnSeasonId: number; players: { id: number; name: string; selectable: boolean }[] };
  const saved = (await db.query<{ player_id: number; full_name: string; selectable: boolean }>('select player_id,full_name,selectable from public.draft_player_catalog where source_sha256=$1 and source_season=$2 order by player_id', [catalog.source.sha256, catalog.espnSeasonId])).rows;
  assert.deepEqual(saved, [...catalog.players].sort((a, b) => a.id - b.id).map(p => ({ player_id: p.id, full_name: p.name, selectable: p.selectable })));
  assert.equal(saved.length, 1095);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'private.import_draft_player_catalog(jsonb,text,integer)','EXECUTE') as allowed", [role])).rows[0].allowed, false);
  }
  await asUser(commissioner);
  await rejects(() => db.query("insert into public.draft_player_catalog values(800000001,'Forged player',true,$1,2027)", ['a'.repeat(64)]), /permission denied/);
  await rejects(() => db.query('update public.live_draft_selections set player_name=$1', ['Forged name']), /permission denied/);
}));

test('public board has blank owners without a complete order and no keeper submission, notes or identity leakage', () => isolated(async () => {
  await db.query('update public.season_teams set draft_position=1 where season_id=$1 and franchise_id=$2', [season, teams[0]]);
  await asUser(commissioner);
  await db.query('select public.open_keeper_selection($1,$2)', [season, 'Private commissioning note']);
  await db.query('select public.save_keeper_submission($1,$2,0,$3::jsonb)', [season, teams[0], '[]']);
  await asUser(null, 'anon');
  const value = await board();
  assert.equal(value.orderComplete, false); assert.equal(value.orderLocked, false); assert.equal(value.nextPickId, null); assert.equal(value.picks.length, 104);
  assert.ok(value.teams.every(t => t.draftPosition === null));
  assert.ok(value.picks.every(p => p.currentOwnerId === null && p.originalFranchiseId === null && p.overallPick === null && p.playerId === null && p.status === 'available'));
  assert.doesNotMatch(JSON.stringify(value), /Private commissioning|user_id|submission|notes|source_snapshot/);
  await rejects(() => db.query('select * from public.live_draft_selections'), /permission denied/);
}));

test('only active commissioners set complete audited order, using stale revision and inventory guards', () => isolated(async () => {
  for (const user of [manager, outsider]) { await asUser(user); await rejects(() => change('set_order', 0, null, null, teams), /Commissioner access required/); }
  await asUser(null, 'anon'); await rejects(() => change('set_order', 0, null, null, teams), /permission denied/);
  await asUser(commissioner);
  await rejects(() => change('set_order', null, null, null, teams), /draft board changed/);
  await rejects(() => change('set_order', 0, null, null, teams.slice(1)), /each season franchise/);
  await rejects(() => change('set_order', 0, null, null, teams.map(() => teams[0])), /each season franchise/);
  await rejects(() => change('set_order', 0, null, null, teams, 'no'), /Explain/);
  let value = await change('set_order', 0, null, null, teams);
  assert.equal(value.revision, 1); assert.equal(value.orderComplete, true); assert.equal(value.nextPickId, null);
  assert.deepEqual(value.picks.map(p => p.overallPick), Array.from({ length: 104 }, (_, i) => i + 1));
  assert.equal(value.picks[7].originalFranchiseId, teams[7]); assert.equal(value.picks[8].originalFranchiseId, teams[7]); assert.equal(value.picks[15].originalFranchiseId, teams[0]);
  await rejects(() => change('set_order', 0, null, null, teams), /draft board changed/);
  value = await change('set_order', 1, null, null, [...teams].reverse()); assert.equal(value.revision, 2);
  assert.equal((await db.query("select 1 from public.audit_events where event_type='draft_order_updated'")).rows.length, 2);
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where user_id=$1', [commissioner]);
  await asUser(commissioner); await rejects(() => change('set_order', 2, null, null, teams), /Commissioner access required/);
}));

test('draft requires reveal and complete order, uses current traded owner, and cannot modify the frozen roster', () => isolated(async () => {
  await asUser(commissioner);
  let value = await change('set_order', 0, null, null, teams);
  await rejects(() => change('record', 1, value.picks[0].id, candidates[0]), /after every keeper/);
  const baseline = await db.query('select season_id,player_id,franchise_id,source_snapshot_id from public.player_ownerships order by player_id');
  await openDraft();
  await db.exec('reset role');
  await db.query('update public.draft_picks set current_owner_id=$2 where id=$1', [value.picks[0].id, teams[5]]);
  await asUser(commissioner);
  value = await board(); assert.equal(value.nextPickId, value.picks[0].id);
  await rejects(() => change('record', 1, value.picks[1].id, candidates[0]), /next available/);
  await rejects(() => change('record', 1, value.picks[0].id, 999999999), /verified ESPN catalog/);
  await rejects(() => change('record', 1, value.picks[0].id, candidates[3]), /verified ESPN catalog/);
  value = await change('record', 1, value.picks[0].id, candidates[0], null, null);
  assert.equal(value.revision, 2); assert.equal(value.orderLocked, true); assert.equal(value.picks[0].status, 'selected'); assert.equal(value.picks[0].currentOwnerId, teams[5]);
  assert.equal(value.picks[0].playerName, 'Verified player 1'); assert.equal(value.nextPickId, value.picks[1].id);
  await rejects(() => change('record', 1, value.picks[1].id, candidates[1]), /draft board changed/);
  await rejects(() => change('record', 2, value.picks[0].id, candidates[1]), /already used/);
  await rejects(() => change('record', 2, value.picks[1].id, candidates[0]), /already kept or drafted/);
  await rejects(() => change('set_order', 2, null, null, [...teams].reverse()), /fixed after/);
  await db.exec('reset role');
  assert.equal((await db.query<{ franchise_id: string }>('select franchise_id from public.live_draft_selections where voided_at is null')).rows[0].franchise_id, teams[5]);
  assert.deepEqual((await db.query('select season_id,player_id,franchise_id,source_snapshot_id from public.player_ownerships order by player_id')).rows, baseline.rows);
  assert.equal((await db.query<{ status: string }>('select status from public.draft_picks where id=$1', [value.picks[0].id])).rows[0].status, 'used');
}));

test('reveal exposes only finalized keepers, prevents duplicate players and keeps keeper picks immutable through correction and undo', () => isolated(async () => {
  const keeper = (await openDraft(true))!;
  await rejects(() => change('record', 0, keeper.pick_id, candidates[0]), /complete draft order/);
  let value = await change('set_order', 0, null, null, teams);
  const keptPick = value.picks.find(p => p.id === keeper.pick_id)!;
  assert.equal(keptPick.status, 'keeper'); assert.equal(keptPick.playerId, keeper.player_id);
  for (const action of ['record', 'undo', 'correct']) await rejects(() => change(action, 1, keeper.pick_id, action === 'undo' ? null : candidates[0]), /keeper picks are immutable/);
  await rejects(() => change('record', 1, value.nextPickId, keeper.player_id), /already kept or drafted/);
  const pick = value.nextPickId!;
  value = await change('record', 1, pick, candidates[0]);
  const originalSelection = value.picks.find(p => p.id === pick)!.selectionId;
  await rejects(() => change('correct', 2, pick, keeper.player_id), /already kept or drafted/);
  value = await change('correct', 2, pick, candidates[1]);
  assert.equal(value.picks.find(p => p.id === pick)!.playerId, candidates[1]);
  assert.notEqual(value.picks.find(p => p.id === pick)!.selectionId, originalSelection);
  value = await change('undo', 3, pick);
  assert.equal(value.revision, 4); assert.equal(value.nextPickId, pick);
  assert.equal(value.orderLocked, true);
  await rejects(() => change('set_order', 4, null, null, [...teams].reverse()), /fixed after/);
  assert.equal(value.picks.find(p => p.id === pick)!.status, 'available'); assert.equal(value.picks.find(p => p.id === pick)!.playerId, null);
  assert.equal(value.picks.find(p => p.id === keeper.pick_id)!.status, 'keeper');
  value = await change('record', 4, pick, candidates[0]); assert.equal(value.revision, 5);
  await db.exec('reset role');
  const history = (await db.query<{ player_id: number; voided_at: string | null }>('select player_id,voided_at from public.live_draft_selections order by created_revision')).rows;
  assert.equal(history.length, 3); assert.ok(history[0].voided_at); assert.ok(history[1].voided_at); assert.equal(history[2].voided_at, null);
  const audits = (await db.query<{ detail: { previous: { player_id: number }; updated: { player_id: number } } }>("select detail from public.audit_events where event_type='draft_selection_corrected'")).rows;
  assert.equal(audits[0].detail.previous.player_id, candidates[0]); assert.equal(audits[0].detail.updated.player_id, candidates[1]);
  await asUser(null, 'anon');
  assert.doesNotMatch(JSON.stringify(await board()), /Verified commissioner change|created_revision|voided_at/);
}));

test('incomplete inventory and closed phases cannot accept order or draft writes', () => isolated(async () => {
  await db.query('delete from public.draft_picks where id=(select id from public.draft_picks where season_id=$1 limit 1)', [season]);
  await asUser(commissioner); await rejects(() => change('set_order', 0, null, null, teams), /inventory is incomplete/);
  await db.exec('reset role'); await db.query("update public.seasons set phase='archived' where id=$1", [season]);
  await asUser(commissioner); await rejects(() => change('set_order', 0, null, null, teams), /cannot change in this phase/);
  await rejects(() => change('record', 0, '71000000-0000-4000-8000-000000000009', candidates[0]), /after every keeper/);
}));

test('failed correction rolls back every ledger field and cannot leak partially changed picks', () => isolated(async () => {
  await openDraft();
  let value = await change('set_order', 0, null, null, teams);
  value = await change('record', 1, value.nextPickId, candidates[0]);
  const firstPick = value.picks[0].id;
  value = await change('record', 2, value.nextPickId, candidates[1]);
  const unchanged = value;
  await rejects(() => change('correct', 3, firstPick, candidates[1]), /already kept or drafted/);
  assert.deepEqual(await board(), unchanged);
  await db.exec('reset role');
  assert.equal((await db.query('select 1 from public.live_draft_selections where voided_at is not null')).rows.length, 0);
  assert.equal((await db.query("select 1 from public.audit_events where event_type='draft_selection_corrected'")).rows.length, 0);
  await db.query("update public.seasons set phase='in_season' where id=$1", [season]);
  await asUser(commissioner);
  await rejects(() => change('undo', 3, firstPick), /after every keeper/);
}));

test('an unrevealed used pick never exposes a private keeper status or player', () => isolated(async () => {
  const keeper = (await openDraft(true))!;
  await change('set_order', 0, null, null, teams);
  // A restored/imported state must not infer public keeper placement from the used flag.
  await db.exec('reset role');
  await db.query("update public.seasons set keepers_revealed_at=null,phase='keeper_selection' where id=$1", [season]);
  await asUser(null, 'anon');
  const value = await board(), pick = value.picks.find(p => p.id === keeper.pick_id)!;
  assert.equal(pick.status, 'available'); assert.equal(pick.playerId, null); assert.equal(pick.playerName, null); assert.equal(pick.selectionId, null);
  assert.equal(value.nextPickId, null);
}));

test('keeper reveal blocks both new player trades and pre-reveal queued transfers of re-drafted players', () => isolated(async () => {
  const former = (await db.query<{ player_id: number; franchise_id: string }>(`select o.player_id,o.franchise_id from public.player_ownerships o
    join public.draft_player_catalog c on c.player_id=o.player_id where o.season_id=$1 and o.franchise_id<>$2 and c.selectable limit 1`, [season, teams[0]])).rows[0];
  const recipient = teams.find(t => t !== former.franchise_id && t !== teams[0])!;
  const leg = { player_id: former.player_id, from_franchise_id: former.franchise_id, to_franchise_id: recipient };
  await asUser(commissioner);
  const queued = await trade([leg]);
  await matureTrade(queued);
  await openDraft();
  let value = await change('set_order', 0, null, null, teams);
  assert.notEqual(value.picks[0].currentOwnerId, former.franchise_id);
  value = await change('record', 1, value.nextPickId, former.player_id);
  const before = await db.query('select player_id,franchise_id from public.player_ownerships order by player_id');
  await rejects(() => trade([leg]), /Player trades pause after keeper reveal/);
  await rejects(() => db.query('select public.finalize_trade($1)', [queued]), /Player trades pause after keeper reveal/);
  assert.deepEqual(await board(), value);
  assert.deepEqual((await db.query('select player_id,franchise_id from public.player_ownerships order by player_id')).rows, before.rows);
  assert.equal((await db.query<{ status: string }>('select status from public.trades where id=$1', [queued])).rows[0].status, 'proposed');
  await db.exec('reset role');
  assert.equal((await db.query('select id from public.trades where application_mode=$1', ['live'])).rows.length, 1);
  await db.query("update public.seasons set phase='in_season' where id=$1", [season]);
  await asUser(commissioner); await rejects(() => trade([leg]), /Player trades pause after keeper reveal/);
}));

test('post-reveal pick trades retain review and used-pick guards, invalidate stale choices once per season, and leave obligations independent', () => isolated(async () => {
  await openDraft();
  let value = await change('set_order', 0, null, null, teams);
  const first = value.picks[0], second = value.picks[1], recipient = teams[6];
  const id = await trade([], [first, second].map(p => ({ pick_id: p.id, from_franchise_id: p.currentOwnerId, to_franchise_id: recipient })));
  await rejects(() => db.query('select public.finalize_trade($1)', [id]), /24-hour trade review/);
  await matureTrade(id);
  await db.query('select public.finalize_trade($1)', [id]);
  value = await board();
  assert.equal(value.revision, 2); assert.equal(value.picks[0].currentOwnerId, recipient); assert.equal(value.picks[1].currentOwnerId, recipient);
  await rejects(() => change('record', 1, first.id, candidates[0]), /draft board changed/);
  value = await change('record', 2, first.id, candidates[0]);
  assert.equal(value.picks[0].currentOwnerId, recipient);
  const used = await trade([], [{ pick_id: first.id, from_franchise_id: recipient, to_franchise_id: teams[4] }]);
  await matureTrade(used); await rejects(() => db.query('select public.finalize_trade($1)', [used]), /no longer available/);
  assert.equal((await board()).revision, 3);
  const obligation = await trade([], [], [{ from_franchise_id: teams[0], to_franchise_id: teams[1], kind: 'other', terms: 'Non-player obligation retained.' }]);
  await matureTrade(obligation); await db.query('select public.finalize_trade($1)', [obligation]);
  assert.equal((await board()).revision, 3);
}));

test('a finalized future pick transfer increments the future draft revision without rebasing an unaffected current draft', () => isolated(async () => {
  const future = '71000000-0000-4000-8000-000000000050', pick = '71000000-0000-4000-8000-000000000051';
  await db.query("insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count) select $2,league_id,'Future draft',draft_year+1,rule_version_id,participant_count from public.seasons where id=$1", [season, future]);
  await db.query('insert into public.season_teams(season_id,franchise_id,league_id,display_name) select $2,franchise_id,league_id,display_name from public.season_teams where season_id=$1', [season, future]);
  await db.query('insert into public.draft_picks(id,season_id,original_franchise_id,current_owner_id,round) values($1,$2,$3,$3,1)', [pick, future, teams[0]]);
  await openDraft();
  const id = await trade([], [{ pick_id: pick, from_franchise_id: teams[0], to_franchise_id: teams[1] }]);
  await matureTrade(id); await db.query('select public.finalize_trade($1)', [id]);
  assert.equal((await board()).revision, 0);
  const futureBoard = draftBoardSchema.parse((await db.query<{ value: unknown }>('select public.get_draft_board($1) as value', [future])).rows[0].value);
  assert.equal(futureBoard.revision, 1); assert.equal(futureBoard.orderComplete, false);
}));
