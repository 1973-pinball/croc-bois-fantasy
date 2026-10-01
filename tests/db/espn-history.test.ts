import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const league = id(1), privateLeague = id(2), commissioner = id(3), viewer = id(4);
const hash = 'a'.repeat(64), nextHash = 'b'.repeat(64);
type History = Record<string, any>;
type Claim = { leaseToken: string; leaseExpiresAt: string; startedAt: string };
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await db.exec(`insert into auth.users values('${commissioner}','commissioner@example.invalid'),('${viewer}','viewer@example.invalid');
    insert into public.leagues(id,slug,name,espn_league_id,is_public) values('${league}','history-public','Public',139935,true),('${privateLeague}','history-private','Private',999999,false);
    insert into public.league_memberships(league_id,user_id,role) values('${league}','${commissioner}','commissioner'),('${league}','${viewer}','viewer');`);
});
after(async () => db.close());
async function role(name: 'anon' | 'authenticated' | 'service_role', user = '') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
  await db.exec(`set local role ${name}`);
}
async function isolated(work: () => Promise<void>) {
  await db.exec('reset role; begin');
  try { await work(); } finally { await db.exec('rollback'); }
}
async function rejects(work: () => Promise<unknown>, message: RegExp) {
  await db.exec('savepoint expected_failure');
  try { await assert.rejects(work, message); } finally { await db.exec('rollback to savepoint expected_failure'); }
}
function full(year = 2026, sourceHash = hash): History {
  return { draftYear: year, espnSeasonId: year, priorSeasonStartYear: year - 1, playoffTeamCount: 4, firstChampionshipMatchupPeriod: 19,
    participants: Array.from({ length: 8 }, (_, n) => ({ espnTeamId: n + 1, franchiseId: String(n + 1), qualified: n < 4, regularSeasonWins: n * 10 })),
    qualifiedFranchiseIds: ['1', '2', '3', '4'], championFranchiseId: '1',
    source: { kind: 'espn-server-sync', leagueId: 139935, sha256: sourceHash, url: `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${year}/segments/0/leagues/139935?view=mTeam&view=mMatchup`, capturedAt: new Date().toISOString(), method: 'first-complete-winners-bracket', paths: ['id', 'teams[0].record.overall.wins', 'schedule[0].{id,home.teamId,away.teamId}'],
      matchups: [{ id: 73, homeEspnTeamId: 1, awayEspnTeamId: 2, winnerEspnTeamId: 1 }, { id: 74, homeEspnTeamId: 3, awayEspnTeamId: 4, winnerEspnTeamId: 3 }],
      championship: { id: 77, matchupPeriod: 20, homeEspnTeamId: 1, awayEspnTeamId: 3, winnerEspnTeamId: 1 } } };
}
function stats(year = 2026, sourceHash = hash): History {
  const complete = full(year, sourceHash);
  const { method, matchups, championship, ...source } = complete.source;
  void method; void matchups; void championship;
  return { draftYear: year, espnSeasonId: year, priorSeasonStartYear: year - 1, qualificationStatus: 'unverified', participants: complete.participants.map(({ qualified, ...p }: History) => { void qualified; return p; }), source };
}
function entry(year = 2026, playoff: History | null = full(year), statistics: History | null = null, sourceHash = hash, fetchedAt = new Date().toISOString()) {
  return { espnSeasonId: year, playoffHistory: playoff, statistics, sourceHash, fetchedAt };
}
async function claim(target = league) {
  return (await db.query<{ result: Claim | null }>('select public.claim_espn_history_sync($1) as result', [target])).rows[0].result;
}
async function finish(token: string, seasons: unknown[], failures: unknown[] = [], target = league) {
  return (await db.query<{ result: History }>('select public.finish_espn_history_sync($1,$2,$3::jsonb,$4::jsonb) as result', [target, token, JSON.stringify(seasons), JSON.stringify(failures)])).rows[0].result;
}
async function store(seasons: unknown[], failures: unknown[] = []) {
  await role('service_role'); const lease = await claim(); assert.ok(lease); return finish(lease.leaseToken, seasons, failures);
}
async function history(year = 2026) {
  return (await db.query<{ playoff_history: History | null; statistics: History | null; fetched_at: Date; last_hash: string }>('select playoff_history,statistics,fetched_at,last_hash from public.espn_season_history where league_id=$1 and espn_season_id=$2', [league, year])).rows[0];
}

test('clients can read sanitized public history but cannot write, claim, or inspect private sync status', () => isolated(async () => {
  await store([entry(2018)]);
  await role('service_role'); const lease = await claim(privateLeague); assert.ok(lease);
  const privateStats = stats(2018); privateStats.source.leagueId = 999999;
  privateStats.source.url = privateStats.source.url.replace('/leagues/139935', '/leagues/999999');
  await finish(lease.leaseToken, [entry(2018, null, privateStats)], [], privateLeague);
  await role('anon');
  assert.equal((await db.query('select * from public.espn_season_history')).rows.length, 1);
  assert.equal((await db.query('select * from public.espn_history_snapshots')).rows.length, 1);
  assert.equal((await db.query('select * from public.espn_history_sync_state')).rows.length, 0);
  await rejects(() => claim(), /permission denied/);
  await rejects(() => db.exec('delete from public.espn_season_history'), /permission denied/);
  await role('authenticated', viewer);
  await rejects(() => claim(), /permission denied/);
  await rejects(() => finish(id(90), []), /permission denied/);
  assert.equal((await db.query('select * from public.espn_history_sync_state')).rows.length, 0);
  await role('authenticated', commissioner);
  assert.equal((await db.query('select * from public.espn_history_sync_state')).rows.length, 1);
  await rejects(() => claim(), /permission denied/);
  await role('service_role');
  await rejects(() => db.exec('delete from public.espn_season_history'), /permission denied/);
  assert.equal((await db.query('select * from public.espn_history_sync_state')).rows.length, 2);
}));

test('leases reject overlap, stale tokens, expiration and replay; historical years need no configured season rows', () => isolated(async () => {
  await role('service_role'); const first = await claim(); assert.ok(first);
  assert.equal(await claim(), null);
  await rejects(() => finish(id(91), [entry(2018)]), /stale or expired/);
  await db.exec('reset role'); await db.query("update public.espn_history_sync_state set lease_expires_at=clock_timestamp()-interval '1 second' where league_id=$1", [league]);
  await role('service_role'); await rejects(() => finish(first.leaseToken, [entry(2018)]), /stale or expired/);
  const replacement = await claim(); assert.ok(replacement); assert.notEqual(replacement.leaseToken, first.leaseToken);
  await rejects(() => finish(first.leaseToken, [entry(2018)]), /stale or expired/);
  const result = await finish(replacement.leaseToken, [entry(2018)]); assert.equal(result.storedSeasons, 1);
  await rejects(() => finish(replacement.leaseToken, [entry(2018)]), /stale or expired/);
  assert.equal((await db.query('select * from public.espn_season_history')).rows.length, 1);
}));

test('401 failures and partial observations retain verified champions, existing wins and immutable evidence', () => isolated(async () => {
  const original = full(); await store([entry(2026, original, stats())]);
  await store([], [{ seasonId: 2026, code: 'ESPN_AUTH_REQUIRED', message: 'RAW_PRIVATE_RESPONSE' }]);
  assert.deepEqual((await history()).playoff_history, original);
  const state = (await db.query<{ failures: History[] }>('select failures from public.espn_history_sync_state')).rows[0];
  assert.equal(JSON.stringify(state).includes('RAW_PRIVATE_RESPONSE'), false);
  const pending = full(2026, nextHash); delete pending.championFranchiseId; delete pending.source.championship;
  const partialStats = stats(2026, nextHash); delete partialStats.participants[0].regularSeasonWins;
  await store([entry(2026, pending, partialStats, nextHash)], [{ seasonId: 2026, code: 'BRACKET_UNVERIFIED', message: 'private' }]);
  const retained = await history(); assert.deepEqual(retained.playoff_history, original); assert.equal(retained.statistics?.participants[0].regularSeasonWins, 0);
  const snapshots = (await db.query<{ observed_playoff_history: History }>('select observed_playoff_history from public.espn_history_snapshots order by id')).rows;
  assert.equal(snapshots.length, 2); assert.equal(snapshots[1].observed_playoff_history.championFranchiseId, undefined);
  await db.exec('reset role');
  await rejects(() => db.exec('delete from public.espn_history_snapshots'), /Historical records are immutable/);
}));

test('per-year attempts preserve unattempted failures, clear successful retry and allow future statistics without qualifiers', () => isolated(async () => {
  await store([], [{ seasonId: 2018, code: 'ESPN_NOT_FOUND' }, { seasonId: 2019, code: 'ESPN_AUTH_REQUIRED' }]);
  let result = await store([entry(2027, null, stats(2027))], [{ seasonId: 2027, code: 'BRACKET_UNVERIFIED' }]);
  assert.equal(result.status, 'partial'); assert.deepEqual([...result.failedYears].sort(), [2018, 2019, 2027]);
  assert.equal((await history(2027)).playoff_history, null);
  result = await store([entry(2018)]); assert.deepEqual([...result.failedYears].sort(), [2019, 2027]);
  const state = (await db.query<{ year_attempts: History; last_successful_at: Date }>('select year_attempts,last_successful_at from public.espn_history_sync_state')).rows[0];
  assert.equal(state.year_attempts['2018'].outcome, 'succeeded'); assert.equal(state.year_attempts['2019'].outcome, 'failed'); assert.equal(state.year_attempts['2027'].outcome, 'partial'); assert.ok(state.last_successful_at);
}));

test('raw account fields, unsafe provenance, mismatched identities and unproved champions roll back the whole batch', () => isolated(async () => {
  await role('service_role'); const lease = await claim(); assert.ok(lease);
  const secret = full(); secret.participants[0].ownerEmail = 'private@example.invalid';
  await rejects(() => finish(lease.leaseToken, [entry(2018), entry(2026, secret)]), /Invalid sanitized ESPN participant/);
  assert.equal((await db.query('select * from public.espn_season_history')).rows.length, 0);
  assert.equal((await db.query('select * from public.espn_history_snapshots')).rows.length, 0);
  const unsafe = full(); unsafe.source.url += '&SWID=secret';
  await rejects(() => finish(lease.leaseToken, [entry(2026, unsafe)]), /Invalid source URL query/);
  const other = full(); other.source.leagueId = 999999;
  await rejects(() => finish(lease.leaseToken, [entry(2026, other)]), /Invalid sanitized ESPN provenance/);
  const unproved = full(); unproved.source.championship.awayEspnTeamId = 2;
  await rejects(() => finish(lease.leaseToken, [entry(2026, unproved)]), /final must be between semifinal winners/);
  const statsWithChampion = stats(); statsWithChampion.championFranchiseId = '1';
  await rejects(() => finish(lease.leaseToken, [entry(2026, null, statsWithChampion)]), /Invalid sanitized ESPN season/);
  await finish(lease.leaseToken, [entry()]);
}));

test('complete champion conflicts need review; older observations cannot overwrite newer evidence', () => isolated(async () => {
  await store([entry(2026, full(), null, hash, new Date(Date.now() - 1000).toISOString())]);
  const conflict = full(2026, nextHash); conflict.championFranchiseId = '3'; conflict.source.championship.winnerEspnTeamId = 3;
  await role('service_role'); const lease = await claim(); assert.ok(lease);
  await rejects(() => finish(lease.leaseToken, [entry(2026, conflict, null, nextHash)]), /Verified champion conflict/);
  await finish(lease.leaseToken, [entry(2026, conflict, null, nextHash, new Date(Date.now() - 10000).toISOString())]);
  assert.equal((await history()).playoff_history?.championFranchiseId, '1'); assert.equal((await history()).last_hash, hash);
  assert.equal((await db.query('select * from public.espn_history_snapshots')).rows.length, 2);
}));

test('a championship upgrade carries omitted prior wins together with their original source evidence', () => isolated(async () => {
  const pending = full(); delete pending.championFranchiseId; delete pending.source.championship;
  await store([entry(2026, pending)]);
  const upgraded = full(2026, nextHash); delete upgraded.participants[0].regularSeasonWins;
  await store([entry(2026, upgraded, null, nextHash)]);
  const stored = (await history()).playoff_history!;
  assert.equal(stored.championFranchiseId, '1'); assert.equal(stored.participants[0].regularSeasonWins, 0);
  assert.equal(stored.additionalSourceEvidence[0].sha256, hash);
  assert.equal(stored.source.sha256, nextHash);
}));
