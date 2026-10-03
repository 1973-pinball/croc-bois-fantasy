import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { draftLotterySchema } from '../../src/lib/draft-lottery';
import { draftLotteryShareSchema, type DraftLotteryShare } from '../../src/lib/draft-lottery-share';

const db = new PGlite();
const commissioner = '74000000-0000-4000-8000-000000000001', manager = '74000000-0000-4000-8000-000000000002', outsider = '74000000-0000-4000-8000-000000000003';
let league: string, season: string;
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
  await db.query('insert into auth.users(id) values($1),($2),($3)', [commissioner, manager, outsider]);
  await db.query("insert into public.league_memberships values($1,$2,'commissioner',true),($1,$3,'manager',true)", [league, commissioner, manager]);
});
after(async () => db.close());
async function asUser(user: string | null, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']); await db.exec(`set local role ${role}`); }
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejected'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejected'); } }
async function draw() { return draftLotterySchema.parse((await db.query<{ value: unknown }>('select public.run_draft_lottery($1) as value', [season])).rows[0].value); }
async function share(): Promise<DraftLotteryShare> { return draftLotteryShareSchema.parse((await db.query<{ value: unknown }>('select public.share_draft_lottery($1) as value', [season])).rows[0].value); }
async function read(shareId: string): Promise<DraftLotteryShare> { return draftLotteryShareSchema.parse((await db.query<{ value: unknown }>('select public.get_shared_draft_lottery($1) as value', [shareId])).rows[0].value); }

test('sharing requires an existing draw and never generates one implicitly', () => isolated(async () => {
  await asUser(commissioner); await rejects(share, /saved lottery is required/);
  await db.exec('reset role');
  assert.equal((await db.query('select id from public.draft_lottery_runs')).rows.length, 0);
  assert.equal((await db.query('select share_id from public.draft_lottery_shares')).rows.length, 0);
  assert.equal((await db.query("select id from public.audit_events where event_type='draft_lottery_shared'")).rows.length, 0);
}));

test('explicit sharing creates one safe immutable replay, preserves saved order, and changes no draft state', () => isolated(async () => {
  await asUser(commissioner); const drawn = await draw();
  await db.exec('reset role');
  const before = (await db.query('select * from public.seasons')).rows;
  const beforeSlots = (await db.query('select * from public.season_teams order by franchise_id')).rows;
  const beforeRun = (await db.query('select * from public.draft_lottery_runs')).rows;
  await asUser(commissioner); const published = await share();
  assert.deepEqual(published.order, drawn.result!.priorityOrder.map((franchiseId, index) => {
    const team = drawn.standings.find(team => team.franchiseId === franchiseId)!;
    return { priority: index + 1, managerLabel: team.managerLabel, teamName: team.displayName };
  }));
  assert.equal(new Date(published.drawnAt).toISOString(), new Date(drawn.result!.drawnAt).toISOString());
  assert.equal(published.draftYear, 2026); assert.deepEqual(await share(), published);
  await db.exec('reset role'); await db.query('update public.leagues set is_public=false where id=$1', [league]);
  for (const user of [manager, outsider, null]) {
    await asUser(user, user ? 'authenticated' : 'anon');
    assert.deepEqual(await read(published.shareId), published);
    const raw = (await db.query<{ value: Record<string, unknown> }>('select public.get_shared_draft_lottery($1) as value', [published.shareId])).rows[0].value;
    assert.deepEqual(Object.keys(raw).sort(), ['draftYear', 'drawnAt', 'order', 'shareId', 'sharedAt']);
    assert.doesNotMatch(JSON.stringify(raw), /entropy|ticket|created_by|actor_user_id|franchiseId|algorithm|audit|runId/);
    await rejects(() => db.query('select * from public.draft_lottery_shares'), /permission denied/);
    await rejects(() => db.query('delete from public.draft_lottery_shares'), /permission denied/);
  }
  await db.exec('reset role');
  assert.deepEqual((await db.query('select * from public.seasons')).rows, before);
  assert.deepEqual((await db.query('select * from public.season_teams order by franchise_id')).rows, beforeSlots);
  assert.deepEqual((await db.query('select * from public.draft_lottery_runs')).rows, beforeRun);
  assert.equal((await db.query('select share_id from public.draft_lottery_shares')).rows.length, 1);
  assert.equal((await db.query("select id from public.audit_events where event_type='draft_lottery_shared'")).rows.length, 1);
  await rejects(() => db.query("update public.draft_lottery_shares set snapshot='{}'::jsonb"), /immutable/);
}));

test('anonymous, manager, outsider and revoked commissioner accounts cannot publish or create a new link', () => isolated(async () => {
  await asUser(commissioner); await draw();
  for (const user of [manager, outsider]) { await asUser(user); await rejects(share, /Commissioner access required/); }
  await asUser(null, 'anon'); await rejects(share, /permission denied/);
  await asUser(commissioner); const published = await share();
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where user_id=$1', [commissioner]);
  await asUser(commissioner); await rejects(share, /Commissioner access required/);
  assert.deepEqual(await read(published.shareId), published);
}));

test('unverified participants and missing saved labels block first publication', () => isolated(async () => {
  await asUser(commissioner); await draw(); await db.exec('reset role');
  await db.query('update public.seasons set participant_count=10 where id=$1', [season]);
  await asUser(commissioner); await rejects(share, /all eight participating/);
  await db.exec('reset role'); await db.query('update public.seasons set participant_count=8 where id=$1', [season]);
  // Simulate a legacy invalid snapshot as the database owner, then restore via rollback.
  await db.exec("alter table public.draft_lottery_runs disable trigger immutable_lottery_run; update public.draft_lottery_runs set snapshot=jsonb_set(snapshot,'{standings,0,managerLabel}','\"\"'); alter table public.draft_lottery_runs enable trigger immutable_lottery_run;");
  await asUser(commissioner); await rejects(share, /missing verified manager/);
  await db.exec('reset role'); assert.equal((await db.query('select share_id from public.draft_lottery_shares')).rows.length, 0);
}));

test('unknown links return not-found and privileged source cleanup cascades to invalidate a shared link', () => isolated(async () => {
  await asUser(null, 'anon');
  await db.exec('savepoint unknown_link');
  try { await assert.rejects(() => read('74000000-0000-4000-8000-000000000099'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P0002')); }
  finally { await db.exec('rollback to savepoint unknown_link'); }
  await asUser(commissioner); await draw(); const published = await share();
  await db.exec('reset role; alter table public.draft_lottery_runs disable trigger immutable_lottery_run; delete from public.draft_lottery_runs; alter table public.draft_lottery_runs enable trigger immutable_lottery_run;');
  assert.equal((await db.query('select share_id from public.draft_lottery_shares')).rows.length, 0);
  await asUser(null, 'anon'); await rejects(() => read(published.shareId), /unavailable or has been removed/);
}));
