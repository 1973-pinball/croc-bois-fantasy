import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationName = '20261003000009_undrafted_keeper_rule.sql';
const directory = new URL('../../supabase/migrations/', import.meta.url);
const season = '60f1e9ec-31d9-42b5-8103-d75fa7ae2b00';
const league = '4bda6ccb-0b37-47b2-8d9e-fe452603738d';
const db = new PGlite();
type Profile = { player_id: number; base_round: number | null; tenure_years: number; verification: string; explanation: string; source_metadata: Record<string, unknown> };
type Correction = { player: string; playerId: number; expected: { base_round: number; tenure_years: number }; originalSource: Record<string, unknown>; evidence: Record<string, unknown> };
let migration: string, seed: string, corrections: Correction[];
async function prepare(target: PGlite, includeRule: boolean) {
  await target.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && file <= migrationName && (includeRule || file !== migrationName)).sort()) await target.exec(await readFile(new URL(file, directory), 'utf8'));
}
before(async () => {
  migration = await readFile(new URL(migrationName, directory), 'utf8');
  seed = await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8');
  corrections = JSON.parse(migration.match(/\$undrafted_rule\$([\s\S]*?)\$undrafted_rule\$/)![1]);
  await prepare(db, false); await db.exec(seed); await db.exec('select private.apply_keeper_evidence_review_20261001()');
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) { await db.exec('begin'); try { await work(); } finally { await db.exec('rollback'); } }
const profiles = async (target = db) => (await target.query<Profile>('select * from public.keeper_profiles where season_id=$1 order by player_id', [season])).rows;
const events = async (target = db) => (await target.query<{ detail: { player_id: number; previous: Profile; updated: Profile; evidence: unknown } }>("select detail from public.audit_events where event_type='keeper_profile_undrafted_rule_applied' order by id")).rows;
async function apply() { return (await db.query<{ result: { applied: number; alreadyApplied: number; alreadyConfirmed: number } }>('select private.apply_undrafted_keeper_rule_20261003() as result')).rows[0].result; }
async function refused(pattern: RegExp) {
  const previous = await profiles(), audit = await events();
  await db.exec('savepoint before_rule');
  await assert.rejects(() => db.exec(migration), pattern);
  await db.exec('rollback to savepoint before_rule');
  assert.deepEqual(await profiles(), previous); assert.deepEqual(await events(), audit);
}

test('established rule confirms all 36 matching setups, including Hart and Grimes, without changing numeric rights or provenance', () => isolated(async () => {
  assert.equal(corrections.length, 36);
  assert.equal(corrections.filter(row => row.expected.tenure_years === 1).length, 30);
  assert.equal(corrections.filter(row => row.expected.tenure_years === 2).length, 6);
  const previous = await profiles();
  const rights = (await db.query('select * from public.player_ownerships order by player_id')).rows;
  const picks = (await db.query('select * from public.draft_picks order by id')).rows;
  const frozen = (await db.query('select * from public.roster_snapshots order by id')).rows;
  await db.exec(migration);
  const next = await profiles();
  assert.equal(next.filter(row => row.verification === 'confirmed').length, 100);
  assert.equal(next.filter(row => row.verification === 'provisional').length, 0);
  assert.equal(next.filter(row => row.verification === 'ineligible').length, 11);
  for (const row of next) {
    const old = previous.find(item => item.player_id === row.player_id)!;
    const correction = corrections.find(item => item.playerId === row.player_id);
    if (!correction) { assert.deepEqual(row, old); continue; }
    assert.equal(row.base_round, old.base_round); assert.equal(row.tenure_years, old.tenure_years);
    assert.equal(row.verification, 'confirmed');
    const { undraftedRuleApplication20261003, ...original } = row.source_metadata;
    assert.deepEqual(original, old.source_metadata); assert.deepEqual(undraftedRuleApplication20261003, correction.evidence);
  }
  for (const playerId of [3062679, 4397014]) {
    const row = next.find(item => item.player_id === playerId)!;
    assert.equal(row.base_round, 12); assert.equal(row.tenure_years, 2); assert.equal(row.verification, 'confirmed');
    assert.match(row.explanation, /payment rounds remain separate/);
  }
  assert.deepEqual((await db.query('select * from public.player_ownerships order by player_id')).rows, rights);
  assert.deepEqual((await db.query('select * from public.draft_picks order by id')).rows, picks);
  assert.deepEqual((await db.query('select * from public.roster_snapshots order by id')).rows, frozen);
  const audit = await events(); assert.equal(audit.length, 36);
  for (const { detail } of audit) {
    assert.deepEqual(detail.previous, previous.find(row => row.player_id === detail.player_id));
    assert.deepEqual(detail.updated, next.find(row => row.player_id === detail.player_id)); assert.ok(detail.evidence);
  }
}));

test('six existing commissioner confirmations retain their complete rows and reasons; only the other 30 changes are audited', () => isolated(async () => {
  const manual = [4397002, 4873138, 4683634, 3064290, 3059319, 4683692];
  await db.query("update public.keeper_profiles set verification='confirmed',explanation='Commissioner checked the established rule directly; retain this decision.' where player_id=any($1::bigint[])", [manual]);
  const before = (await profiles()).filter(row => manual.includes(row.player_id));
  await db.exec(migration);
  assert.deepEqual((await profiles()).filter(row => manual.includes(row.player_id)), before);
  assert.equal((await events()).length, 30);
  assert.equal((await events()).some(event => manual.includes(event.detail.player_id)), false);
  assert.deepEqual(await apply(), { status: 'applied', applied: 0, alreadyApplied: 30, alreadyConfirmed: 6 });
}));

test('reruns preserve later commissioner explanations without duplicating evidence or events', () => isolated(async () => {
  await db.exec(migration);
  await db.query("update public.keeper_profiles set explanation='Later commissioner clarification of this confirmed setup.' where player_id=$1", [corrections[0].playerId]);
  const before = await profiles(), audit = await events();
  await db.exec(migration);
  assert.deepEqual(await profiles(), before); assert.deepEqual(await events(), audit);
  assert.deepEqual(await apply(), { status: 'applied', applied: 0, alreadyApplied: 36, alreadyConfirmed: 0 });
}));

test('unexpected numeric, source, status or unresolved review changes abort atomically instead of overriding decisions', async () => {
  const last = corrections.at(-1)!;
  for (const change of ["base_round=base_round-1", "tenure_years=tenure_years+1", "verification='ineligible'", "verification='unresolved'", "explanation='Commissioner found different evidence'", "source_metadata=source_metadata||'{\"differentSource\":true}'::jsonb"]) await isolated(async () => {
    await db.exec(`update public.keeper_profiles set ${change} where player_id=${last.playerId}`);
    await refused(/Undrafted keeper rule (numeric or identity|source|review) conflict/);
  });
  await isolated(async () => {
    await db.query("update public.keeper_profiles set verification='confirmed',base_round=base_round-1 where player_id=$1", [last.playerId]);
    await refused(/numeric or identity conflict/);
  });
});

test('missing profiles, unfrozen ownership, revealed seasons and committed keepers block changes', async () => {
  const last = corrections.at(-1)!;
  await isolated(async () => { await db.query('delete from public.keeper_profiles where player_id=$1', [last.playerId]); await refused(/missing profile/); });
  await isolated(async () => { await db.query("update public.seasons set phase='draft_ready',keepers_revealed_at=now() where id=$1", [season]); await refused(/frozen profiles/); });
  await isolated(async () => {
    const snapshot = '90000000-0000-4000-8000-000000000001';
    await db.query("insert into public.roster_snapshots(id,league_id,season_id,snapshot_date,source_sha256) values($1,$2,$3,'2026-03-29',repeat('f',64))", [snapshot, league, season]);
    await db.query('insert into public.roster_entries(snapshot_id,season_id,franchise_id,player_id,lineup_slot,source_pointer,acquisition_type,acquisition_at) select $1,e.season_id,e.franchise_id,e.player_id,e.lineup_slot,e.source_pointer,e.acquisition_type,e.acquisition_at from public.roster_entries e where e.player_id=$2', [snapshot, last.playerId]);
    await db.query('update public.player_ownerships set source_snapshot_id=$1 where player_id=$2', [snapshot, last.playerId]);
    await refused(/outside the frozen pool/);
  });
  for (const status of ['approved', 'locked']) await isolated(async () => {
    const actor = '90000000-0000-4000-8000-000000000002';
    await db.query('insert into auth.users values($1)', [actor]);
    const submission = (await db.query<{ id: string }>('insert into public.keeper_submissions(season_id,franchise_id,revision,created_by,status) select season_id,franchise_id,1,$1,$2 from public.player_ownerships where player_id=$3 returning id', [actor, status, last.playerId])).rows[0].id;
    await db.query('insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id,reserved) select $1,o.season_id,o.player_id,p.id,true from public.player_ownerships o join public.draft_picks p on p.season_id=o.season_id and p.current_owner_id=o.franchise_id where o.player_id=$2 limit 1', [submission, last.playerId]);
    await refused(/Reject the approved keeper submission/);
  });
});

test('fresh installations wait for bootstrap then run both reviews in order; maintenance stays owner-only', async () => {
  const fresh = new PGlite();
  try {
    await prepare(fresh, true);
    assert.deepEqual((await fresh.query<{ result: unknown }>('select private.apply_undrafted_keeper_rule_20261003() as result')).rows[0].result, { status: 'awaiting-bootstrap', applied: 0, alreadyApplied: 0, alreadyConfirmed: 0 });
    await fresh.exec(seed);
    await fresh.exec(await readFile(new URL('../../supabase/apply-keeper-evidence-review.sql', import.meta.url), 'utf8'));
    const rows = await profiles(fresh);
    assert.equal(rows.filter(row => row.verification === 'confirmed').length, 100);
    assert.equal(rows.filter(row => row.verification === 'ineligible').length, 11);
    assert.equal((await events(fresh)).length, 36);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await fresh.query<{ allowed: boolean }>("select has_function_privilege($1,'private.apply_undrafted_keeper_rule_20261003()','execute') as allowed", [role])).rows[0].allowed, false);
  } finally { await fresh.close(); }
});
