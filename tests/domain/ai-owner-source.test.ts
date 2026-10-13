import assert from 'node:assert/strict';
import test from 'node:test';
import { actual2025DraftEvidence, fetchAiOwnerSnapshot, parseAiOwnerSnapshot, type AiOwnerDraftEvidence } from '../../src/lib/ai-owner-source';

const categoryIds = [0, 1, 2, 3, 6, 11, 17, 19, 20];
const source = { capturedAt: '2026-10-07T15:00:00.000Z', sha256: 'a'.repeat(64), url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935?view=mTeam' };
const evidence: AiOwnerDraftEvidence[] = Array.from({ length: 104 }, (_, index) => ({ teamId: String(index % 8 + 1), name: `Player ${index + 1}`, overallPick: index + 1, keeper: index < 37 }));
const names = new Map(evidence.map((row, index) => [index + 1, row.name]));
function league() {
  return {
    id: 139935, seasonId: 2026, members: [{ secretMemberId: 'PRIVATE-MEMBER' }],
    status: { currentMatchupPeriod: 2 }, draftDetail: { drafted: true, inProgress: false, picks: [] },
    settings: { scoringSettings: { scoringType: 'H2H_CATEGORY', scoringItems: categoryIds.map(statId => ({ statId, points: 1, isReverseItem: statId === 11 })) }, scheduleSettings: { matchupPeriodCount: 2, matchupPeriods: { 1: [1], 2: [2] } } },
    teams: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, owners: ['PRIVATE-OWNER'], roster: { entries: [] }, record: { overall: { wins: index % 2 === 0 ? 9 : 0, losses: index % 2 === 0 ? 0 : 9, ties: 0 } }, transactionCounter: { acquisitions: index + 1, matchupAcquisitionTotals: { 1: index + 1 } } })),
    schedule: Array.from({ length: 4 }, (_, index) => ({ id: index + 1, matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME',
      home: { teamId: index * 2 + 1, cumulativeScore: { scoreByStat: Object.fromEntries(categoryIds.map(id => [String(id), { score: id === 11 ? 0 : 2, result: 'WIN' }])) } },
      away: { teamId: index * 2 + 2, cumulativeScore: { scoreByStat: Object.fromEntries(categoryIds.map(id => [String(id), { score: 1, result: 'LOSS' }])) } },
    })),
  };
}
const parse = (payload: unknown) => parseAiOwnerSnapshot(payload, { season: 2026, source, playerNames: names, draftEvidence: evidence });

test('owner snapshot uses verified workbook decisions and returns only public allowlisted evidence', () => {
  const snapshot = parse(league());
  assert.equal(snapshot.draftComplete, true);
  assert.equal(snapshot.draft?.length, 104);
  assert.equal(snapshot.draft?.filter(row => row.keeper).length, 37);
  assert.equal(snapshot.draft?.[0].overallPick, 1);
  assert.deepEqual(snapshot.categories?.completedMatchupPeriods, [1]);
  assert.equal(snapshot.categories?.teams[0].categories.find(category => category.id === 11)?.wins, 1);
  assert.deepEqual(snapshot.acquisitions?.[0], { teamId: '1', byPeriod: { 1: 1, 2: 0 } });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE-MEMBER|PRIVATE-OWNER|secretMemberId|transactionCounter/);
});

test('ambiguous or incomplete draft identities leave draft unavailable without erasing category evidence', () => {
  const duplicateNames = new Map(names); duplicateNames.set(999, 'Player 1');
  const snapshot = parseAiOwnerSnapshot(league(), { season: 2026, source, playerNames: duplicateNames, draftEvidence: evidence });
  assert.equal(snapshot.draft, null);
  assert.ok(snapshot.categories);
  const duplicateDraft = [...evidence]; duplicateDraft[1] = { ...duplicateDraft[0] };
  assert.equal(parseAiOwnerSnapshot(league(), { season: 2026, source, playerNames: names, draftEvidence: duplicateDraft }).draft, null);
});

test('the documented Jimmy Butler III alias resolves uniquely without broad fuzzy name matching', () => {
  const aliasedEvidence = evidence.map((row, index) => index === 0 ? { ...row, name: 'Jimmy Butler' } : row);
  const aliasedNames = new Map(names); aliasedNames.set(1, 'Jimmy Butler III');
  assert.equal(parseAiOwnerSnapshot(league(), { season: 2026, source, playerNames: aliasedNames, draftEvidence: aliasedEvidence }).draft?.[0].playerId, 1);
});

test('upcoming owner draft stays unavailable until the actual draft is complete', () => {
  const payload = league(); payload.seasonId = 2027; payload.draftDetail.drafted = false;
  const snapshot = parseAiOwnerSnapshot(payload, { season: 2027, source: { ...source, url: source.url.replace('2026', '2027') }, playerNames: names });
  assert.equal(snapshot.draftComplete, false);
  assert.equal(snapshot.draft, null);
});

test('a completed upcoming ESPN draft supplies identified picks, while an in-progress board stays unavailable', () => {
  const payload = { ...league(), seasonId: 2027, draftDetail: { drafted: true, inProgress: false,
    picks: evidence.map((row, index) => ({ playerId: index + 1, teamId: Number(row.teamId), overallPickNumber: row.overallPick, keeper: row.keeper })),
  } };
  const options = { season: 2027, source: { ...source, url: source.url.replace('2026', '2027') }, playerNames: names };
  const snapshot = parseAiOwnerSnapshot(payload, options);
  assert.equal(snapshot.draftComplete, true);
  assert.equal(snapshot.draft?.length, 104);
  assert.equal(snapshot.draft?.filter(row => row.keeper).length, 37);
  payload.draftDetail.inProgress = true;
  assert.equal(parseAiOwnerSnapshot(payload, options).draft, null);
});

test('missing or mismatched owner pickup counters never become zero acquisitions', () => {
  const missing = league(); delete (missing.teams[0].transactionCounter as { matchupAcquisitionTotals?: unknown }).matchupAcquisitionTotals;
  assert.equal(parse(missing).acquisitions, null);
  const mismatch = league(); mismatch.teams[0].transactionCounter.acquisitions = 8;
  assert.equal(parse(mismatch).acquisitions, null);
  const missingTotal = league(); delete (missingTotal.teams[0].transactionCounter as { acquisitions?: number }).acquisitions;
  assert.equal(parse(missingTotal).acquisitions, null);
});

test('partial weeks, absent scoring categories, and nonreconciling standings cannot produce a category comparison', () => {
  const partial = league(); delete partial.schedule[0].home.cumulativeScore.scoreByStat['19'];
  assert.equal(parse(partial).categories, null);
  const liveWeek = league(); liveWeek.status.currentMatchupPeriod = 1;
  assert.equal(parse(liveWeek).categories, null);
  const mismatch = league(); mismatch.teams[0].record.overall.wins = 10;
  assert.equal(parse(mismatch).categories, null);
});

test('franchise, season, and source integrity failures reject the entire snapshot', () => {
  const missing = league(); missing.teams.pop();
  assert.throws(() => parse(missing), /eight franchises/);
  const wrong = league(); wrong.id = 9;
  assert.throws(() => parse(wrong), /Unexpected/);
  assert.throws(() => parseAiOwnerSnapshot(league(), { season: 2026, source: { ...source, url: source.url + '&credential=private' } }), /source is invalid/);
});

test('actual owner fetch refuses redirects and never includes private source bodies in errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/lm-api-reads\.fantasy\.espn\.com\/apis\/v3\/games\/fba\/seasons\/2026\/segments\/0\/leagues\/139935\?/);
    assert.equal(init?.redirect, 'manual');
    return new Response('PRIVATE-MEMBER', { status: 302 });
  }) as typeof fetch;
  try { await assert.rejects(fetchAiOwnerSnapshot(2026, { espnS2: 'example', swid: 'example' }), error => error instanceof Error && error.message.includes('302') && !error.message.includes('PRIVATE')); }
  finally { globalThis.fetch = original; }
});

test('owner refresh reuses the simulation player identities without an extra player-pool request', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    assert.doesNotMatch(String(url), /kona_player_info/);
    assert.ok(init?.signal);
    return Response.json(league());
  }) as typeof fetch;
  try {
    const known = new Map(actual2025DraftEvidence().map((row, index) => [index + 1, row.name]));
    const snapshot = await fetchAiOwnerSnapshot(2026, { espnS2: 'example', swid: 'example' }, known);
    assert.equal(requests, 1);
    assert.equal(snapshot.draft?.length, 104);
    assert.ok(snapshot.categories);
  } finally { globalThis.fetch = original; }
});
