import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const uuid = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = uuid(1), season = uuid(2), otherLeague = uuid(3), otherSeason = uuid(4), futureSeason = uuid(5);
const commissioner = uuid(10), secondCommissioner = uuid(11), manager = uuid(12), outsider = uuid(13);
const snapshot = (source = 'basketball-monster', importedAt = '2026-10-14T12:00:00.000Z') => ({
  source, seasonId: 2027, importedAt, ranks: [{ id: 910000011, providerRank: 2 }, { id: 910000012, providerRank: 2 }],
});
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users(id) values('${commissioner}'),('${secondCommissioner}'),('${manager}'),('${outsider}');
    insert into public.leagues(id,slug,name) values('${league}','ranks-test','Ranks test'),('${otherLeague}','other-ranks-test','Other ranks test');
    insert into public.league_memberships values('${league}','${commissioner}','commissioner',true),('${league}','${secondCommissioner}','commissioner',true),('${league}','${manager}','manager',true);
    insert into public.rule_versions(id,league_id,version) values('${uuid(20)}','${league}',1),('${uuid(21)}','${otherLeague}',1);
    insert into public.seasons(id,league_id,label,draft_year,rule_version_id,participant_count) values
      ('${season}','${league}','2026-27',2026,'${uuid(20)}',2),('${otherSeason}','${otherLeague}','2026-27',2026,'${uuid(21)}',2),('${futureSeason}','${league}','2027-28',2027,'${uuid(20)}',2);
    insert into public.draft_player_catalog values(910000011,'Rank fixture one',true,repeat('a',64),2027),(910000012,'Rank fixture two',true,repeat('a',64),2027);`);
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('reset role; begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function user(id: string | null = commissioner, role = 'authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id || '']); await db.exec(`set local role ${role}`); }
async function rejects(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
async function save(value: unknown = snapshot(), seasonId = season) { return (await db.query<{ value: unknown }>('select public.save_draft_provider_ranks($1,$2::jsonb) value', [seasonId, JSON.stringify(value)])).rows[0].value; }
async function get(source = 'basketball-monster', seasonId = season) { return (await db.query<{ value: unknown }>('select public.get_draft_provider_ranks($1,$2) value', [seasonId, source])).rows[0].value; }

test('ranks are isolated by commissioner account, season and provider, with tied source ranks preserved', () => isolated(async () => {
  await user(); assert.equal(await get(), null); assert.deepEqual(await save(), snapshot());
  assert.equal(await get('yahoo'), null); assert.equal(await get('basketball-monster', futureSeason), null);
  await user(secondCommissioner); assert.equal(await get(), null);
  const second = snapshot(); second.ranks[0].providerRank = 9;
  assert.deepEqual(await save(second), second); assert.deepEqual(await get(), second);
  await user(); assert.deepEqual(await get(), snapshot());
  assert.deepEqual(await save(snapshot('yahoo')), snapshot('yahoo')); assert.deepEqual(await get(), snapshot());
}));

test('anonymous, manager, outsider, cross-league and revoked commissioner access is denied', () => isolated(async () => {
  await user(); await save();
  await rejects(() => get('basketball-monster', otherSeason), /Commissioner access required/);
  await rejects(() => save(snapshot(), otherSeason), /Commissioner access required/);
  for (const id of [manager, outsider, null]) {
    await user(id); await rejects(() => get(), /Commissioner access required/); await rejects(() => save(), /Commissioner access required/);
  }
  await user(null, 'anon'); await rejects(() => get(), /permission denied/); await rejects(() => save(), /permission denied/);
  await db.exec('reset role'); await db.query('update public.league_memberships set active=false where league_id=$1 and user_id=$2', [league, commissioner]);
  await user(); await rejects(() => get(), /Commissioner access required/); await rejects(() => save(), /Commissioner access required/);
}));

test('clients cannot access the private table or specify another snapshot owner', () => isolated(async () => {
  await user(); await save();
  await rejects(() => db.query('select * from private.draft_provider_rank_snapshots'), /permission denied/);
  await rejects(() => db.query('delete from private.draft_provider_rank_snapshots'), /permission denied/);
  await rejects(() => save({ ...snapshot(), userId: secondCommissioner }), /Invalid private rank snapshot/);
  await rejects(() => save({ ...snapshot(), stats: { points: 99 } }), /Invalid private rank snapshot/);
}));

test('older and equal-timestamp imports cannot downgrade a newer saved snapshot', () => isolated(async () => {
  await user(); const current = snapshot(); await save(current);
  const earlier = snapshot('basketball-monster', '2026-10-13T12:00:00.000Z'); earlier.ranks[0].providerRank = 7;
  assert.deepEqual(await save(earlier), current);
  const equal = snapshot(); equal.ranks[0].providerRank = 8;
  assert.deepEqual(await save(equal), current);
  const later = snapshot('basketball-monster', '2026-10-15T12:00:00.000Z'); later.ranks[0].providerRank = 1;
  assert.deepEqual(await save(later), later); assert.deepEqual(await get(), later);
}));

test('malformed snapshots, wrong seasons, unknown IDs and invalid ranks fail without changing saved data', () => isolated(async () => {
  await user(); await save();
  for (const value of [null, {}, { ...snapshot(), source: 'espn' }, { ...snapshot(), seasonId: '2027' },
    { ...snapshot(), importedAt: 'infinity' }, { ...snapshot(), importedAt: '2026-13-99T12:00:00Z' },
    { ...snapshot(), ranks: null }, { ...snapshot(), ranks: [] },
    { ...snapshot(), ranks: [{ id: 910000011, providerRank: 0 }] }, { ...snapshot(), ranks: [{ id: '910000011', providerRank: 1 }] },
    { ...snapshot(), ranks: [{ id: 910000011, providerRank: 1.5 }] }, { ...snapshot(), ranks: [{ id: 910000011, providerRank: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...snapshot(), ranks: [{ id: 910000011, providerRank: 1, name: 'Private data' }] },
    { ...snapshot(), ranks: [snapshot().ranks[0], snapshot().ranks[0]] },
    { ...snapshot(), ranks: Array.from({ length: 2001 }, () => snapshot().ranks[0]) }]) {
    await rejects(() => save(value), /Invalid|positive integer|safe integers|only once|between 1 and 2000/);
    assert.deepEqual(await get(), snapshot());
  }
  await rejects(() => save({ ...snapshot(), seasonId: 2028 }), /does not match/);
  await rejects(() => save({ ...snapshot(), ranks: [{ id: 910000099, providerRank: 1 }] }), /verified ESPN catalog/);
  await rejects(() => save({ ...snapshot(), seasonId: 2028 }, futureSeason), /verified ESPN catalog/);
  await rejects(() => get('espn'), /Invalid rank source/);
  assert.deepEqual(await get(), snapshot());
}));
