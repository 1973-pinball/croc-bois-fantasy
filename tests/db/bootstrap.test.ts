import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('reviewed bootstrap runs on a fresh database and refuses a replay without changing ownership', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
    const directory = new URL('../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory),'utf8'));
    const seed = await readFile(new URL('../../supabase/seed.sql',import.meta.url),'utf8');
    const preview = JSON.parse(await readFile(new URL('../../data/league.json',import.meta.url),'utf8'));
    await db.exec(seed);
    assert.equal((await db.query('select id from public.franchises')).rows.length,preview.teams.length);
    assert.equal((await db.query('select player_id from public.player_ownerships')).rows.length,preview.players.length);
    assert.equal((await db.query('select id from public.draft_picks')).rows.length,preview.picks.length);
    assert.equal((await db.query('select player_id from public.keeper_profiles')).rows.length,preview.players.length);
    assert.equal((await db.query('select id from public.roster_snapshots where frozen_at is not null')).rows.length,1);
    assert.equal((await db.query('select * from public.league_memberships')).rows.length,0);
    assert.equal((await db.query('select * from public.manager_assignments where user_id is not null')).rows.length,0);
    assert.equal((await db.query<{phase:string}>('select phase from public.seasons')).rows[0].phase,'setup');
    const before = await db.query('select season_id,player_id,franchise_id,source_snapshot_id from public.player_ownerships order by player_id');
    await assert.rejects(() => db.exec(seed),/already exists.*must not overwrite/i);
    await db.exec('rollback');
    const after = await db.query('select season_id,player_id,franchise_id,source_snapshot_id from public.player_ownerships order by player_id');
    assert.deepEqual(after.rows,before.rows);
    await db.exec('set role anon');
    assert.equal((await db.query('select player_id from public.player_ownerships')).rows.length,preview.players.length);
    assert.equal((await db.query('select * from public.manager_assignments')).rows.length,0);
    assert.equal((await db.query('select * from public.keeper_submissions')).rows.length,0);
  } finally { await db.close(); }
});
