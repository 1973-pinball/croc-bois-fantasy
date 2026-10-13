import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const league = 'a1000000-0000-4000-8000-000000000001';
const hidden = 'a1000000-0000-4000-8000-000000000002';
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into public.leagues(id,slug,name,is_public) values('${league}','ai-public','Public',true),('${hidden}','ai-private','Private',false);
    insert into public.ai_league_runs(league_id,season,payload) values('${league}',2027,'{"season":2027,"version":1}'),('${hidden}',2027,'{"season":2027,"version":1}');`);
});
after(async () => db.close());
test('public readers see only public simulations and cannot change AI or official state', async () => {
  await db.exec('begin; set local role anon');
  try {
    const rows = (await db.query('select league_id from public.ai_league_runs')).rows;
    assert.deepEqual(rows, [{ league_id: league }]);
    await db.exec('savepoint forbidden');
    await assert.rejects(() => db.exec('update public.ai_league_runs set revision=100'), /permission denied/);
    await db.exec('rollback to savepoint forbidden');
    await assert.rejects(() => db.exec(`insert into public.ai_league_refresh(league_id) values('${league}')`), /permission denied/);
  } finally { await db.exec('rollback'); }
});
test('revision compare-and-swap prevents stale workers overwriting saved decisions', async () => {
  await db.exec('begin; set local role service_role');
  try {
    const first = await db.query('update public.ai_league_runs set revision=2 where league_id=$1 and season=2027 and revision=1 returning revision', [league]);
    const stale = await db.query('update public.ai_league_runs set revision=2 where league_id=$1 and season=2027 and revision=1 returning revision', [league]);
    assert.equal(first.rows.length, 1); assert.equal(stale.rows.length, 0);
  } finally { await db.exec('rollback'); }
});
test('wrong season payload and unsupported seasons are rejected', async () => {
  await assert.rejects(() => db.exec(`insert into public.ai_league_runs(league_id,season,payload) values('${league}',2026,'{"season":2027,"version":1}')`), /check constraint/);
  await assert.rejects(() => db.exec(`insert into public.ai_league_runs(league_id,season,payload) values('${league}',2028,'{"season":2028,"version":1}')`), /check constraint/);
});
