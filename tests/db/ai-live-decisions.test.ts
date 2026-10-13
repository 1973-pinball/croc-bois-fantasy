import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const league = 'aa000000-0000-4000-8000-000000000001';
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for (const file of ['20261001000000_league_foundation.sql', '20261007000015_ai_league.sql', '20261008000020_ai_live_decision_locks.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.query('insert into public.leagues(id,slug,name) values($1,$2,$3)', [league, 'live-ai-tests', 'Live AI']);
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('begin'); try { await work(); } finally { await db.exec('rollback'); } }
async function rejected(work: () => Promise<unknown>, pattern: RegExp) { await db.exec('savepoint rejection'); try { await assert.rejects(work, pattern); } finally { await db.exec('rollback to savepoint rejection'); } }
const stamp = (offset: number) => new Date(Date.now() + offset).toISOString();
function payload(live = true) {
  return { version: 1, season: 2027, ...(live ? { liveSingles: { version: 1, season: 2027, ownerDraft: [{ playerId: 1, overallPick: 1 }], draftCapturedAt: '2026-10-18T23:00:00Z', forecastAsOf: '2026-10-18T20:00:00Z', locks: [] as Record<string, unknown>[], scenarios: Array.from({ length: 16 }, (_, index) => ({ teamId: String(index % 8 + 1), mode: index < 8 ? 'post_draft' : 'redraft', lineups: [] as Record<string, unknown>[], decisions: [] as Record<string, unknown>[] })), missedDates: [] as string[] } } : {}) };
}
async function insert(value: unknown) { return db.query('insert into public.ai_league_runs(league_id,season,payload) values($1,2027,$2::jsonb)', [league, JSON.stringify(value)]); }
async function update(value: unknown) { return db.query('update public.ai_league_runs set payload=$2::jsonb,revision=revision+1 where league_id=$1 and season=2027', [league, JSON.stringify(value)]); }
function lock(value: ReturnType<typeof payload>, startsAt = stamp(3_600_000), empty = false) {
  const capturedAt = stamp(-2000), decidedAt = stamp(-1000), date = new Date().toISOString().slice(0, 10);
  value.liveSingles!.locks.push({ date, startsAt, capturedAt, snapshotId: 'source-hash', owners: [], empty });
  for (const scenario of value.liveSingles!.scenarios) {
    scenario.lineups.push({ date, decidedAt, slots: empty ? [] : [{ playerId: 1, slot: 0 }], snapshotId: 'source-hash' });
    scenario.decisions.push({ id: `${scenario.mode}-${scenario.teamId}-1`, date, kind: 'lineup', playerIds: empty ? [] : [1] });
  }
  return value;
}

test('existing whole-league writes and pre-draft waiting states need no lock receipts', () => isolated(async () => {
  await insert(payload(false)); const waiting = payload(); delete (waiting.liveSingles as { ownerDraft?: unknown }).ownerDraft; waiting.liveSingles!.scenarios = [];
  await update(waiting); assert.equal((await db.query<{ revision: number }>('select revision from public.ai_league_runs')).rows[0].revision, 2);
}));

test('pre-tipoff receipts save once and preserve source, lineup and decision history', () => isolated(async () => {
  const value = lock(payload()); await insert(value); await update(value);
  for (const change of [
    (copy: typeof value) => { copy.liveSingles!.locks[0].snapshotId = 'changed'; },
    (copy: typeof value) => { copy.liveSingles!.scenarios[0].lineups[0].slots = []; },
    (copy: typeof value) => { copy.liveSingles!.scenarios[0].decisions[0].playerIds = [99]; },
    (copy: typeof value) => { copy.liveSingles!.scenarios.shift(); },
  ]) { const copy = structuredClone(value); change(copy); await rejected(() => update(copy), /immutable|cannot be removed|previously saved|sixteen/); }
  assert.deepEqual((await db.query<{ payload: unknown }>('select payload from public.ai_league_runs')).rows[0].payload, value);
}));

test('database receipt rejects a late first lock even when its claimed decision time is earlier', () => isolated(async () => {
  await insert(payload()); const late = lock(payload(), stamp(-500));
  await rejected(() => update(late), /missed first tipoff/);
  const retained = payload(); retained.liveSingles!.missedDates.push(new Date().toISOString().slice(0, 10));
  await update(retained);
  assert.equal((await db.query<{ payload: ReturnType<typeof payload> }>('select payload from public.ai_league_runs')).rows[0].payload.liveSingles!.locks.length, 0);
}));

test('an explicitly empty NBA date may settle after its date but cannot hide an active lineup', () => isolated(async () => {
  const value = lock(payload(), stamp(-3_600_000), true); await insert(value);
  await db.exec('delete from public.ai_league_runs');
  const forged = lock(payload(), stamp(-3_600_000), true); forged.liveSingles!.scenarios[0].lineups[0].slots = [{ slot: 0, playerId: 7 }];
  await rejected(() => insert(forged), /empty NBA day/);
}));

test('starting draft and forecast provenance cannot be replaced or erased', () => isolated(async () => {
  const value = payload(); await insert(value);
  const changed = structuredClone(value); changed.liveSingles!.ownerDraft[0].playerId = 2;
  await rejected(() => update(changed), /starting draft evidence is immutable/);
  await rejected(() => update(payload(false)), /cannot be removed/);
  const forecast = structuredClone(value); forecast.liveSingles!.forecastAsOf = stamp(0);
  await rejected(() => update(forecast), /starting draft evidence is immutable/);
}));

test('missing or future lineup receipts cannot enter the saved live experiment', () => isolated(async () => {
  const missing = lock(payload()); missing.liveSingles!.scenarios[0].lineups = [];
  await rejected(() => insert(missing), /receipt is missing/);
  const future = lock(payload()); future.liveSingles!.scenarios[0].lineups[0].decidedAt = stamp(60_000);
  await rejected(() => insert(future), /receipt is missing/);
}));

test('duplicate scenarios, duplicated receipts and orphan lineups cannot bypass the receipt guard', () => isolated(async () => {
  const duplicate = lock(payload()); duplicate.liveSingles!.scenarios.push(structuredClone(duplicate.liveSingles!.scenarios[0]));
  await rejected(() => insert(duplicate), /Duplicate live scenario/);
  const repeated = lock(payload()); repeated.liveSingles!.scenarios[0].lineups.push(structuredClone(repeated.liveSingles!.scenarios[0].lineups[0]));
  await rejected(() => insert(repeated), /Duplicate live scenario receipts/);
  const orphan = lock(payload()); orphan.liveSingles!.locks = [];
  await rejected(() => insert(orphan), /requires a source lock/);
  const value = lock(payload()); await insert(value);
  const hindsight = structuredClone(value); hindsight.liveSingles!.scenarios[0].decisions.push({ id: 'late-add', kind: 'add_drop', date: value.liveSingles!.locks[0].date, playerIds: [99] });
  await rejected(() => update(hindsight), /append a decision/);
}));
