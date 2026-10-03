import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import readinessAudit from '../../data/keeper-readiness-audit.json';

const migrationName = '20261001000008_keeper_evidence_review.sql';
const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url);
const season = '60f1e9ec-31d9-42b5-8103-d75fa7ae2b00';
const league = '4bda6ccb-0b37-47b2-8d9e-fe452603738d';
const targetIds = readinessAudit.supportedConfirmations.map(row => row.playerId).sort((a, b) => a - b);
const db = new PGlite();
let migration: string;
let seed: string;

async function prepare(target: PGlite, includeEvidenceMigration: boolean) {
  await target.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  // These tests describe migration 8's historical effect; later rule applications
  // have their own full-chain tests and must not change this baseline.
  for (const file of (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql') && file <= migrationName && (includeEvidenceMigration || file !== migrationName)).sort()) {
    await target.exec(await readFile(new URL(file, migrationDirectory), 'utf8'));
  }
}
before(async () => {
  migration = await readFile(new URL(migrationName, migrationDirectory), 'utf8');
  seed = await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8');
  await prepare(db, false);
  await db.exec(seed);
});
after(async () => db.close());
async function isolated(work: () => Promise<void>) {
  await db.exec('begin');
  try { await work(); } finally { await db.exec('rollback'); }
}
type Profile = { player_id: number; base_round: number | null; tenure_years: number; verification: string; explanation: string; source_metadata: Record<string, unknown> };
const profiles = async (target = db) => (await target.query<Profile>('select * from public.keeper_profiles where season_id=$1 order by player_id', [season])).rows;

test('review confirms exactly eleven seeded histories with original evidence and numeric values preserved', () => isolated(async () => {
  const previous = await profiles();
  const ownership = (await db.query('select * from public.player_ownerships order by player_id')).rows;
  const picks = (await db.query('select * from public.draft_picks order by id')).rows;
  await db.exec(migration);
  const next = await profiles();
  const changed: number[] = [];
  for (const profile of next) {
    const old = previous.find(row => row.player_id === profile.player_id)!;
    if (!targetIds.includes(profile.player_id)) { assert.deepEqual(profile, old); continue; }
    changed.push(profile.player_id);
    assert.equal(old.verification, 'provisional');
    assert.equal(profile.verification, 'confirmed');
    assert.equal(profile.base_round, old.base_round);
    assert.equal(profile.tenure_years, old.tenure_years);
    const { evidenceReview20261001, ...originalEvidence } = profile.source_metadata;
    assert.deepEqual(originalEvidence, old.source_metadata);
    assert.ok(evidenceReview20261001);
  }
  assert.deepEqual(changed, targetIds);
  assert.equal(next.filter(row => row.verification === 'provisional').length, 36);
  assert.equal(next.filter(row => row.verification === 'confirmed').length, 64);
  assert.equal(next.filter(row => row.verification === 'ineligible').length, 11);
  assert.deepEqual((await db.query('select * from public.player_ownerships order by player_id')).rows, ownership);
  assert.deepEqual((await db.query('select * from public.draft_picks order by id')).rows, picks);
  const events = (await db.query<{ detail: { player_id: number; previous: Profile; updated: Profile; evidence: unknown; actor: { kind: string; database_role: string } } }>("select detail from public.audit_events where event_type='keeper_profile_evidence_confirmed' and league_id=$1", [league])).rows;
  assert.equal(events.length, 11);
  for (const { detail } of events) {
    assert.deepEqual(detail.previous, previous.find(row => row.player_id === detail.player_id));
    assert.deepEqual(detail.updated, next.find(row => row.player_id === detail.player_id));
    assert.equal(detail.actor.kind, 'reviewed-data-migration');
    assert.ok(detail.actor.database_role);
    assert.ok(detail.evidence);
  }
}));

test('reapplying the reviewed migration changes no profiles and creates no duplicate audit events', () => isolated(async () => {
  await db.exec(migration);
  const previous = await profiles();
  const events = (await db.query('select * from public.audit_events order by id')).rows;
  await db.exec(migration);
  assert.deepEqual(await profiles(), previous);
  assert.deepEqual((await db.query('select * from public.audit_events order by id')).rows, events);
  const result = (await db.query<{ result: { applied: number; alreadyApplied: number } }>('select private.apply_keeper_evidence_review_20261001() as result')).rows[0].result;
  assert.equal(result.applied, 0);
  assert.equal(result.alreadyApplied, 11);
}));

test('commissioner overrides or changed source evidence abort the entire reconciliation and remain intact', async () => {
  for (const change of ["base_round=4", "tenure_years=3", "verification='confirmed'", "explanation='Commissioner reviewed a different history'", "source_metadata=source_metadata||'{\"commissionerNote\":\"New source\"}'::jsonb"]) {
    await isolated(async () => {
      // Paolo is last in the correction list: earlier updates must roll back too.
      await db.exec(`update public.keeper_profiles set ${change} where season_id='${season}' and player_id=4432573`);
      const before = await profiles();
      await db.exec('savepoint before_review');
      await assert.rejects(() => db.exec(migration), /Keeper evidence review conflict.*Paolo Banchero/);
      await db.exec('rollback to savepoint before_review');
      assert.deepEqual(await profiles(), before);
      assert.equal((await db.query<{ n: number }>("select count(*)::integer as n from public.audit_events where event_type='keeper_profile_evidence_confirmed'")).rows[0].n, 0);
    });
  }
});

test('fresh migrations then bootstrap then explicit reconciliation produce the same eleven confirmations', async () => {
  const fresh = new PGlite();
  try {
    await prepare(fresh, true);
    assert.equal((await fresh.query('select * from public.keeper_profiles')).rows.length, 0);
    await fresh.exec(seed);
    assert.equal((await profiles(fresh)).filter(row => row.verification === 'provisional').length, 47);
    await fresh.exec('select private.apply_keeper_evidence_review_20261001()');
    assert.equal((await profiles(fresh)).filter(row => row.verification === 'provisional').length, 36);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const access = (await fresh.query<{ allowed: boolean }>("select has_function_privilege($1,'private.apply_keeper_evidence_review_20261001()','execute') as allowed", [role])).rows[0];
      assert.equal(access.allowed, false);
    }
  } finally { await fresh.close(); }
});

test('public readiness audit reports the scope without credentials or private source paths', () => {
  assert.equal(readinessAudit.roster.length, 111);
  assert.equal(readinessAudit.roster.filter(row => row.comparison === 'matched').length, 111);
  assert.equal(readinessAudit.roster.filter(row => row.observedStatus === 'review').length, 47);
  assert.equal(readinessAudit.supportedConfirmations.length, 11);
  assert.doesNotMatch(JSON.stringify(readinessAudit), /\.local[\\/]|C:[\\/]|espn_s2|SWID|user_id|auth\.users|@/i);
});
