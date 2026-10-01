import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronAuthorized, espnConnectionStatus, fetchHistoryBatch, fetchHistorySeason, historyFromRows, historyRowComplete, historyYearRange, planHistorySync, protectVerifiedChampions, validatedEspnCookies, type HistoryRow, type HistorySyncState } from '../../src/lib/espn-history-sync-core';

const now = Date.parse('2026-10-01T16:00:00.000Z');
const mapping = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), String(i + 1)]));
function fixture(seasonId = 2026) {
  return { id: 139935, seasonId, members: [{ email: 'PRIVATE_EMAIL_SENTINEL' }], settings: { scheduleSettings: { playoffTeamCount: 4 } },
    teams: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, owners: ['PRIVATE_OWNER_SENTINEL'], record: { overall: { wins: i, losses: 10, ties: 0 } } })),
    schedule: [
      { id: 73, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', winner: 'HOME', home: { teamId: 7, totalPoints: 0 }, away: { teamId: 1, totalPoints: 0 } },
      { id: 74, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 6, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 } },
      { id: 77, matchupPeriodId: 20, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 7, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 } },
    ] };
}
function options(seasonId = 2026, fetcher: typeof fetch = async () => Response.json(fixture(seasonId))) {
  return { seasonId, completedThrough: 2026, mapping, cookies: null, deadline: now + 40_000, now: () => now, fetcher };
}
function state(attempts: HistorySyncState['year_attempts'] = {}): HistorySyncState {
  return { lease_expires_at: null, last_started_at: null, last_finished_at: null, last_successful_at: null, status: 'idle', failures: [], year_attempts: attempts };
}

test('bounded planning prioritizes 2025/26, keeps a recent refresh slot, and backs off failed years', () => {
  assert.deepEqual(historyYearRange(2026, new Date(now)), { completedThrough: 2026, current: 2027, expected: [2018,2019,2020,2021,2022,2023,2024,2025,2026] });
  assert.deepEqual(planHistorySync([], null, 2026, new Date(now)), [2025,2026,2027]);
  const attempts = state({ '2025': { attemptedAt: new Date(now).toISOString(), outcome: 'failure' }, '2026': { attemptedAt: new Date(now).toISOString(), outcome: 'failure' }, '2027': { attemptedAt: new Date(now).toISOString(), outcome: 'failure' } });
  assert.deepEqual(planHistorySync([], attempts, 2026, new Date(now)), [2018,2019,2020]);
  assert.equal(planHistorySync([], attempts, 2026, new Date(now)).length <= 3, true);
  assert.throws(() => historyYearRange(2017, new Date(now)), /boundary/);
  assert.equal(historyYearRange(2026, new Date('2027-06-30T23:59:59Z')).completedThrough, 2026);
  assert.equal(historyYearRange(2026, new Date('2027-07-01T00:00:00Z')).completedThrough, 2027);
  assert.equal(historyYearRange(2026, new Date('2028-07-01T00:00:00Z')).completedThrough, 2028);
});

test('cron rejects missing/wrong secrets and ESPN cookies cannot inject another header or cookie', () => {
  assert.equal(cronAuthorized(null, undefined), false);
  assert.equal(cronAuthorized('Bearer undefined', undefined), false);
  assert.equal(cronAuthorized('Bearer valid-secret-long-enough', 'valid-secret-long-enough'), true);
  assert.equal(cronAuthorized('Bearer invalid-secret-long-enough', 'valid-secret-long-enough'), false);
  assert.equal(validatedEspnCookies(), null);
  assert.deepEqual(validatedEspnCookies('encoded%2Bvalue', '{a-b-c}'), { s2: 'encoded%2Bvalue', swid: '{a-b-c}' });
  for (const value of ['x; injected=y', 'x\r\nAuthorization: value', 'x y']) assert.throws(() => validatedEspnCookies(value, '{id}'), /Invalid private/);
  assert.throws(() => validatedEspnCookies('only-one'), /Invalid private/);
});

test('fixed ESPN fetch has manual redirects and sanitizes qualification, wins and championship provenance', async () => {
  let calls = 0;
  const result = await fetchHistorySeason({ ...options(), cookies: { s2: 'PRIVATE_COOKIE_SENTINEL', swid: '{private}' }, fetcher: async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'lm-api-reads.fantasy.espn.com'); assert.match(url.pathname, /seasons\/2026\/segments\/0\/leagues\/139935$/);
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.cache, 'no-store'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('cookie'), 'espn_s2=PRIVATE_COOKIE_SENTINEL; SWID={private}');
    return Response.json(fixture());
  } });
  assert.equal(calls, 1); assert.equal(result.failure, undefined);
  assert.equal(result.season?.playoffHistory?.championFranchiseId, '2');
  assert.deepEqual(result.season?.playoffHistory?.qualifiedFranchiseIds, ['1','2','6','7']);
  assert.equal(result.season?.statistics?.participants[0].regularSeasonWins, 0);
  assert.equal(result.season?.statistics?.source.kind, 'espn-server-sync');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|members|owners|totalPoints/);
});

test('only a 404 falls back to history arrays and actual season/league identities must match', async () => {
  const urls: string[] = [];
  const found = await fetchHistorySeason(options(2025, async input => {
    urls.push(String(input));
    return urls.length === 1 ? new Response(null, { status: 404 }) : Response.json([fixture(2024), fixture(2025)]);
  }));
  assert.equal(found.season?.espnSeasonId, 2025); assert.equal(urls.length, 2); assert.match(urls[1], /leagueHistory\/139935\?seasonId=2025/);
  for (const status of [301,401,403,429,500]) {
    let count = 0;
    const result = await fetchHistorySeason(options(2025, async () => { count++; return new Response(null, { status, headers: { Location: 'https://attacker.invalid/' } }); }));
    assert.equal(count, 1); assert.equal(result.season, undefined);
    assert.equal(result.failure?.code, status === 401 || status === 403 ? 'ESPN_AUTH_REQUIRED' : 'ESPN_UNAVAILABLE');
  }
  assert.equal((await fetchHistorySeason(options(2025, async () => Response.json(fixture(2026))))).failure?.code, 'INVALID_SOURCE');
  assert.equal((await fetchHistorySeason(options(2025, async () => Response.json({ ...fixture(2025), id: 1 })))).failure?.code, 'INVALID_SOURCE');
  assert.equal((await fetchHistorySeason(options(2025, async () => Response.json([fixture(2025),fixture(2025)])))).failure?.code, 'INVALID_SOURCE');
});

test('absent/malformed completed brackets retain observed wins; the active year cannot declare a champion', async () => {
  for (const schedule of [[], undefined, fixture().schedule.slice(0, 1)]) {
    const result = await fetchHistorySeason(options(2026, async () => Response.json({ ...fixture(), schedule })));
    assert.equal(result.failure?.code, 'BRACKET_UNVERIFIED'); assert.ok(result.season?.statistics); assert.equal(result.season?.playoffHistory, undefined);
  }
  const active = await fetchHistorySeason(options(2027));
  assert.ok(active.season?.statistics); assert.equal(active.season?.playoffHistory, undefined); assert.equal(active.failure, undefined);
  const missingStats = fixture(); delete (missingStats.teams[0] as { record?: unknown }).record;
  assert.equal((await fetchHistorySeason(options(2026, async () => Response.json(missingStats)))).season?.statistics?.participants[0].regularSeasonWins, undefined);
  assert.equal((await fetchHistorySeason({ ...options(), mapping: { '1':'1' } })).failure?.code, 'INVALID_SOURCE');
});

test('401 stops the bounded batch immediately and never discards earlier successful candidates', async () => {
  let calls = 0;
  const batch = await fetchHistoryBatch({ ...options(), years: [2025,2026,2027], fetcher: async () => {
    calls++; return calls === 1 ? Response.json(fixture(2025)) : new Response(null, { status: 401 });
  } });
  assert.equal(calls, 2); assert.deepEqual(batch.attemptedYears, [2025,2026]); assert.deepEqual(batch.seasons.map(row => row.espnSeasonId), [2025]);
  assert.equal(batch.failures[0].code, 'ESPN_AUTH_REQUIRED');
  await assert.rejects(() => fetchHistoryBatch({ ...options(), years: [2018,2019,2020,2021] }), /bounded/);
  await assert.rejects(() => fetchHistoryBatch({ ...options(), years: [2025,2025] }), /bounded/);
  const expired = await fetchHistoryBatch({ ...options(), years: [2025], deadline: now, fetcher: async () => { throw new Error('Should not call'); } });
  assert.deepEqual(expired.attemptedYears, []);
});

test('network errors, oversized responses and invalid JSON return fixed messages without private content', async () => {
  for (const fetcher of [async () => { throw new Error('PRIVATE_COOKIE_SENTINEL'); }, async () => new Response('private', { headers: { 'content-length':'5000000' } }), async () => new Response('PRIVATE_EMAIL_SENTINEL')]) {
    const result = await fetchHistorySeason(options(2026, fetcher));
    assert.equal(result.season, undefined); assert.ok(result.failure); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test('public history prefers verified records and projects away unknown stored identity fields', async () => {
  const full = (await fetchHistorySeason(options())).season!;
  const partial = (await fetchHistorySeason(options(2027))).season!;
  const rows: HistoryRow[] = [full,partial].map(item => ({ espn_season_id: item.espnSeasonId, playoff_history: item.playoffHistory || null, statistics: item.statistics || null, fetched_at: item.fetchedAt, last_hash: item.sourceHash }));
  Object.assign(rows[0].playoff_history!, { members: 'PRIVATE_MEMBER_SENTINEL' });
  Object.assign(rows[0].playoff_history!.participants[0], { email: 'PRIVATE_EMAIL_SENTINEL' });
  const result = historyFromRows(rows);
  assert.deepEqual(result.seasons.map(item => item.draftYear), [2026]); assert.deepEqual(result.statsOnlySeasons?.map(item => item.draftYear), [2026,2027]);
  rows[0].statistics!.participants[0].regularSeasonWins = 55;
  const refreshed = historyFromRows(rows);
  assert.equal(refreshed.seasons[0].participants[0].regularSeasonWins, 0);
  assert.equal(refreshed.statsOnlySeasons?.[0].participants[0].regularSeasonWins, 55);
  assert.equal(refreshed.seasons[0].championFranchiseId, '2');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|members|email/);
  assert.throws(() => historyFromRows([rows[0],rows[0]]), /Duplicate/);
  assert.throws(() => historyFromRows([{ ...rows[0], espn_season_id:2025 }]), /mismatch/);
});

test('observed stats-only years keep retrying brackets without starving never-fetched history', async () => {
  const partial = (await fetchHistorySeason(options(2020, async () => Response.json({ ...fixture(2020), schedule: [] })))).season!;
  const row: HistoryRow = { espn_season_id: 2020, playoff_history: null, statistics: partial.statistics!, fetched_at: partial.fetchedAt, last_hash: partial.sourceHash };
  assert.equal(historyRowComplete(row), false);
  const older = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const tried = state(Object.fromEntries([2018,2019,2021,2022,2023,2024,2025,2026,2027].map(year => [String(year), { attemptedAt: older, outcome: 'failure' }])));
  assert.equal(planHistorySync([row], tried, 2026, new Date(now)).includes(2020), true);
  const recent = state({ '2020': { attemptedAt: new Date(now).toISOString(), outcome: 'partial' } });
  assert.equal(planHistorySync([row], recent, 2026, new Date(now)).includes(2020), false);
});

test('a conflicting champion becomes a review failure while other fetched years remain savable', async () => {
  const original = (await fetchHistorySeason(options())).season!;
  const changed = fixture(); changed.schedule[2].winner = 'HOME';
  const different = (await fetchHistorySeason(options(2026, async () => Response.json(changed)))).season!;
  const good = (await fetchHistorySeason(options(2025))).season!;
  const rows: HistoryRow[] = [{ espn_season_id: 2026, playoff_history: original.playoffHistory!, statistics: original.statistics!, fetched_at: original.fetchedAt, last_hash: original.sourceHash }];
  const protectedBatch = protectVerifiedChampions({ seasons: [good,different], failures: [], attemptedYears: [2025,2026] }, rows);
  assert.deepEqual(protectedBatch.seasons.map(item => item.espnSeasonId), [2025]);
  assert.equal(protectedBatch.failures[0].seasonId, 2026); assert.equal(protectedBatch.failures[0].code, 'INVALID_SOURCE');
  assert.equal(rows[0].playoff_history!.championFranchiseId, '2');
  assert.equal(protectVerifiedChampions({ seasons: [original], failures: [], attemptedYears: [2026] }, rows).seasons.length, 1);
});

test('valid updated credentials allow manual recovery from a persisted auth failure before normal backoff ends', () => {
  assert.equal(espnConnectionStatus(undefined, undefined, true).needsConnection, true);
  assert.equal(espnConnectionStatus('invalid;cookie', '{id}', true).needsConnection, true);
  const updated = espnConnectionStatus('valid-private-value', '{id}', true);
  assert.equal(updated.needsConnection, false); assert.match(updated.message!, /previous.*failed.*retry/i);
  const failed = state({ '2025': { attemptedAt: new Date(now).toISOString(), outcome: 'failure', code:'ESPN_AUTH_REQUIRED' } });
  failed.failures.push({ seasonId: 2025, code:'ESPN_AUTH_REQUIRED', message:'Connection required' });
  assert.equal(planHistorySync([], failed, 2026, new Date(now)).includes(2025), false);
  assert.equal(planHistorySync([], failed, 2026, new Date(now), true)[0], 2025);
});
