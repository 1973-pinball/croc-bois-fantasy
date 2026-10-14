import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDraftAdvisor, type DraftAdvisorCandidate, type DraftAdvisorInput } from '../../src/lib/draft-advisor';
import { buildDraftCandidateRanks, sortDraftCandidates, type DraftCandidateRankLibrary } from '../../src/lib/draft-candidate-ranks';
import type { DraftCatalogPlayer, DraftPlayerCatalog } from '../../src/lib/draft-player-catalog';
import type { DraftPlayerProjection, DraftProjectionDataset, DraftProjectionSource, DraftProjectionStats } from '../../src/lib/draft-projections';
import type { DraftProjectionRankSnapshot } from '../../src/lib/draft-projection-ranks';

const source = { sha256: 'a'.repeat(64), url: 'https://example.com/fixture', capturedAt: '2026-10-13T00:00:00.000Z' };
const stats = (pts = 10): DraftProjectionStats => ({ pts, reb: 5, ast: 3, stl: 1, blk: 1, tov: 2, three: 1, fgm: 5, fga: 10, ftm: 2, fta: 3 });
const player = (id: number, overrides: Partial<DraftCatalogPlayer> = {}): DraftCatalogPlayer => ({ id, name: `Player ${id}`, nbaTeam: 'BOS', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: id, rankSource: 'ROTO', active: true, selectable: true, ...overrides });
const projection = (id: number, pts = id): DraftPlayerProjection => ({ id, name: `Player ${id}`, games: 70, stats: stats(pts) });
const dataset = (source: DraftProjectionSource, players: DraftPlayerProjection[]): DraftProjectionDataset => ({ source, sourceLabel: source, seasonId: 2027, importedAt: '2026-10-13T00:00:00.000Z', warnings: [], players });
function catalog(count = 25): DraftPlayerCatalog {
  return { version: 1, leagueId: 139935, espnSeasonId: 2027, fetchedAt: source.capturedAt, source,
    rankingSource: { field: 'ROTO', label: 'ESPN ranks', rankType: 'ROTO', customLeagueWeighting: false, limitations: [] },
    categories: [{ id: 0, label: 'PTS' }, { id: 6, label: 'REB' }, { id: 3, label: 'AST' }, { id: 2, label: 'STL' }, { id: 1, label: 'BLK' }, { id: 17, label: '3PM' }, { id: 11, label: 'TO' }, { id: 19, label: 'FG%' }, { id: 20, label: 'FT%' }].map(category => ({ ...category, lowerIsBetter: category.id === 11 })),
    coverage: { players: count, ranked: count, unranked: 0, selectable: count, unsigned: 0 }, players: Array.from({ length: count }, (_, index) => player(index + 1)) };
}
const candidate = (player: DraftCatalogPlayer, overrides: Partial<DraftAdvisorCandidate> = {}): DraftAdvisorCandidate => ({
  player, hasProjection: true, categoryWinRate: .5, categoryGain: 0, scheduleWinRate: .5, scheduleGain: 0, fitScore: .5,
  fitAdjustment: 0, scheduledGames: null, usableGames: null, reasons: [], blocked: false, ...overrides,
});
function library(count = 25): DraftCandidateRankLibrary {
  return { 'basketball-monster': dataset('basketball-monster', Array.from({ length: count }, (_, index) => ({ ...projection(index + 1), providerRank: count - index }))),
    yahoo: dataset('yahoo', Array.from({ length: count }, (_, index) => ({ ...projection(index + 1, count - index), providerRank: index + 1 }))) };
}

test('source ranks preserve imported provider ranks and BBM value is ESPN rank minus its source rank', () => {
  const pool = catalog(), imports = library(), before = structuredClone({ pool, imports });
  const result = buildDraftCandidateRanks(pool, imports);
  assert.deepEqual({ pool, imports }, before);
  assert.deepEqual(result.coverage, { selectable: 25, espn: 25, bbm: 25, yahoo: 25 });
  assert.deepEqual(result.byPlayerId.get(25), { espnRank: 25, bbmRank: 1, yahooRank: 25, bbmValue: 24 });
  assert.deepEqual(result.byPlayerId.get(1), { espnRank: 1, bbmRank: 25, yahooRank: 1, bbmValue: -24 });
  // Imported ranks remain authoritative even when the projection statistics
  // would favor a different player.
  imports['basketball-monster']!.players[0].stats.pts = 100;
  imports.yahoo!.players[24].stats.pts = 100;
  assert.deepEqual(buildDraftCandidateRanks(pool, imports), result);
});

test('current ESPN imported ranks override catalog ranks, with catalog fallback only for missing supplied values', () => {
  const pool = catalog(3), imports = library(3); pool.players[2].rank = null;
  imports.espn = dataset('espn', [{ ...projection(1), providerRank: 20 }, projection(2), { ...projection(3), providerRank: 1 }]);
  const ranks = buildDraftCandidateRanks(pool, imports);
  assert.equal(ranks.byPlayerId.get(1)!.espnRank, 20); assert.equal(ranks.byPlayerId.get(1)!.bbmValue, 17);
  assert.equal(ranks.byPlayerId.get(2)!.espnRank, 2); assert.equal(ranks.byPlayerId.get(3)!.espnRank, 1);
  assert.equal(ranks.coverage.espn, 3);
  assert.deepEqual(sortDraftCandidates(pool.players.map(row => candidate(row)), ranks, 'espn').map(row => row.player.id), [3, 2, 1]);
  imports.espn.seasonId = 2026;
  assert.deepEqual([...buildDraftCandidateRanks(pool, imports).byPlayerId.values()].map(row => row.espnRank), [1, 2, null]);
});

test('sorts the full candidate pool before the 15-row cutoff and preserves inputs', () => {
  const pool = catalog(), ranks = buildDraftCandidateRanks(pool, library());
  const candidates = pool.players.map(row => candidate(row)), before = structuredClone(candidates);
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'espn').map(row => row.player.id), Array.from({ length: 15 }, (_, index) => index + 1));
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value').map(row => row.player.id), Array.from({ length: 15 }, (_, index) => 25 - index));
  assert.equal(sortDraftCandidates(candidates, ranks, 'bbm')[0].player.id, 25);
  assert.equal(sortDraftCandidates(candidates, ranks, 'yahoo')[0].player.id, 1);
  assert.equal(sortDraftCandidates(candidates, ranks, 'bbm-value', 2).length, 2);
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value', 0), []);
  assert.deepEqual(candidates, before);
});

test('rank coverage includes only selectable catalog players and preserves original rank gaps and zero-game rows', () => {
  const pool = catalog(4), imports = library(4);
  pool.players[3].selectable = false;
  imports['basketball-monster']!.players.push({ ...projection(999, 199), providerRank: 1 });
  imports['basketball-monster']!.players[2].games = 0;
  const result = buildDraftCandidateRanks(pool, imports);
  assert.equal(result.byPlayerId.has(4), false);
  assert.equal(result.byPlayerId.has(999), false);
  assert.equal(result.coverage.bbm, 3);
  assert.equal(result.byPlayerId.get(3)!.bbmRank, 2);
  assert.equal(result.byPlayerId.get(1)!.bbmRank, 4);
});

test('missing source and ESPN ranks remain null; known values sort first and ties are deterministic', () => {
  const pool = catalog(5);
  pool.players[0].rank = null;
  pool.players[1].rank = 8;
  pool.players[2].rank = 8; pool.players[2].name = 'Alpha';
  pool.players[3].rank = 8; pool.players[3].name = 'Alpha';
  pool.players[4].rank = Number.NaN;
  const ranks = buildDraftCandidateRanks(pool, { 'basketball-monster': dataset('basketball-monster', [{ ...projection(1), providerRank: 2 }, { ...projection(2, 2), providerRank: 1 }]) });
  assert.deepEqual(ranks.byPlayerId.get(1), { espnRank: null, bbmRank: 2, yahooRank: null, bbmValue: null });
  assert.equal(ranks.byPlayerId.get(5)!.espnRank, null);
  assert.equal(ranks.coverage.espn, 3);
  const candidates = [...pool.players].reverse().map(row => candidate(row));
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value').map(row => row.player.id), [2, 3, 4, 1, 5]);
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'yahoo').map(row => row.player.id), [3, 4, 2, 1, 5]);
});

test('wrong source, wrong season, duplicate IDs and invalid stats never produce source ranks', () => {
  const pool = catalog(3);
  const wrongSource = dataset('yahoo', [projection(1)]);
  const wrongSeason = { ...dataset('basketball-monster', [projection(1)]), seasonId: 2026 };
  const duplicates = dataset('basketball-monster', [projection(1), projection(1)]);
  const invalid = dataset('basketball-monster', [projection(1)]); invalid.players[0].stats.pts = NaN;
  for (const bad of [wrongSource, wrongSeason, duplicates, invalid]) {
    const result = buildDraftCandidateRanks(pool, { 'basketball-monster': bad });
    assert.equal(result.coverage.bbm, 0);
    assert.ok([...result.byPlayerId.values()].every(row => row.bbmRank === null && row.bbmValue === null && row.yahooRank === null));
  }
});

test('legacy projection datasets without provider ranks remain missing rather than substituting modeled ranks', () => {
  const result = buildDraftCandidateRanks(catalog(3), { 'basketball-monster': dataset('basketball-monster', [projection(1), projection(2)]), yahoo: dataset('yahoo', [projection(3)]) });
  assert.deepEqual(result.coverage, { selectable: 3, espn: 3, bbm: 0, yahoo: 0 });
  assert.ok([...result.byPlayerId.values()].every(row => row.bbmRank === null && row.yahooRank === null && row.bbmValue === null));
});

const rankSnapshot = (source: DraftProjectionRankSnapshot['source'] = 'basketball-monster'): DraftProjectionRankSnapshot => ({
  source, seasonId: 2027, importedAt: '2026-10-14T00:00:00.000Z', ranks: [{ id: 3, providerRank: 1 }, { id: 1, providerRank: 7 }],
});

test('private supplied ranks work without forecasts and cannot manufacture team estimates', () => {
  const input = advisorFixture(); input.projections = null;
  const snapshots = { 'basketball-monster': rankSnapshot(), yahoo: rankSnapshot('yahoo') }, before = structuredClone(snapshots);
  const ranks = buildDraftCandidateRanks(input.catalog, {}, snapshots), report = buildDraftAdvisor(input);
  assert.deepEqual(ranks.byPlayerId.get(3), { espnRank: 3, bbmRank: 1, yahooRank: 1, bbmValue: 2 });
  assert.equal(ranks.coverage.bbm, 2); assert.equal(ranks.coverage.yahoo, 2);
  assert.equal(sortDraftCandidates(report.candidates, ranks, 'bbm')[0].player.id, 3);
  assert.ok(report.candidates.every(row => !row.hasProjection && row.categoryWinRate === null && row.scheduleWinRate === null));
  assert.deepEqual(report.fitRanking, []); assert.deepEqual(snapshots, before);
});

test('rank snapshots fill missing ranks, preserve gaps and omit unknown or nonselectable catalog identities', () => {
  const pool = catalog(4); pool.players[3].selectable = false;
  const imports = { 'basketball-monster': dataset('basketball-monster', [{ ...projection(1), providerRank: 7 }, projection(2)]) };
  const supplied = { ...rankSnapshot(), ranks: [...rankSnapshot().ranks, { id: 2, providerRank: 11 }, { id: 4, providerRank: 2 }, { id: 99, providerRank: 3 }] };
  const before = structuredClone({ imports, supplied });
  const ranks = buildDraftCandidateRanks(pool, imports, { 'basketball-monster': supplied });
  assert.equal(ranks.coverage.bbm, 3);
  assert.deepEqual([...ranks.byPlayerId.values()].map(row => row.bbmRank), [7, 11, 1]);
  assert.equal(ranks.byPlayerId.has(4), false); assert.equal(ranks.byPlayerId.has(99), false);
  assert.deepEqual({ imports, supplied }, before);
});

test('a conflicting rank snapshot is wholly ignored and cannot overwrite imported ranks or fill its gaps', () => {
  const imports = { 'basketball-monster': dataset('basketball-monster', [{ ...projection(1), providerRank: 5 }, projection(2)]) };
  const ranks = buildDraftCandidateRanks(catalog(3), imports, { 'basketball-monster': rankSnapshot() });
  assert.equal(ranks.coverage.bbm, 1); assert.equal(ranks.byPlayerId.get(1)!.bbmRank, 5); assert.equal(ranks.byPlayerId.get(3)!.bbmRank, null);
});

test('invalid, wrong-source and wrong-season rank snapshots cannot bypass dataset validation', () => {
  for (const supplied of [{ ...rankSnapshot(), source: 'yahoo' as const }, { ...rankSnapshot(), seasonId: 2026 },
    { ...rankSnapshot(), ranks: [{ id: 3, providerRank: 0 }] }, { ...rankSnapshot(), ranks: [{ id: 3, providerRank: 1 }, { id: 3, providerRank: 9 }] }]) {
    const result = buildDraftCandidateRanks(catalog(3), {}, { 'basketball-monster': supplied });
    assert.equal(result.coverage.bbm, 0);
  }
});

function advisorFixture(): DraftAdvisorInput {
  const pool = catalog();
  return { catalog: pool, projections: dataset('espn', pool.players.map(row => projection(row.id))), franchiseId: 'a',
    board: { seasonId: 'season', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13, revision: 1,
      clock: { status: 'waiting', durationSeconds: 90, remainingSeconds: 90, deadlineAt: null, startedAt: null, serverNow: source.capturedAt },
      keepersRevealedAt: source.capturedAt, orderComplete: true, orderLocked: true, nextPickId: null,
      teams: [{ franchiseId: 'a', espnTeamId: 1, displayName: 'A', draftPosition: 1 }, { franchiseId: 'b', espnTeamId: 2, displayName: 'B', draftPosition: 2 }],
      picks: [1, 2].map(id => ({ id: `pick-${id}`, round: 1, overallPick: id, originalFranchiseId: id === 1 ? 'a' : 'b', currentOwnerId: id === 1 ? 'a' : 'b', status: id === 1 ? 'selected' : 'keeper', playerId: id, playerName: `Player ${id}`, selectionId: id === 1 ? 'selection-1' : null })) },
    settings: { version: 1, leagueId: 139935, espnSeasonId: 2027, source, slots: [{ slotId: 11, label: 'UTIL', count: 13, kind: 'normal' }],
      slotDefinitionsSource: source, positionLimitsSource: source, slotDefinitions: [{ slotId: 11, label: 'UTIL', name: 'Utility', bench: false, reserve: false, lineupSlotEligible: true }],
      normalCapacity: 13, reserveCapacity: 0, lineupSlotCounts: { 11: 13 }, positionLimits: {}, isBenchUnlimited: true, primaryPositionLimits: [], limitations: [] },
    eligibility: { version: 1, leagueId: 139935, espnSeasonId: 2027, source, players: pool.players.map(row => ({ id: row.id, name: row.name, eligibleSlots: [11], primaryPositionId: 1, injuryStatus: 'ACTIVE', active: true, poolStatus: 'FREEAGENT' })) } };
}

test('advisor exposes all available candidates, excludes taken players, and source ranks stay fixed after picks', () => {
  const input = advisorFixture(), imports = library(), ranks = buildDraftCandidateRanks(input.catalog, imports);
  const report = buildDraftAdvisor(input);
  assert.equal(report.available, true);
  assert.equal(report.candidates.length, 23);
  assert.equal(report.topAvailable.length, 15);
  assert.ok(report.candidates.every(row => row.player.id !== 1 && row.player.id !== 2));
  assert.equal(sortDraftCandidates(report.candidates, ranks, 'bbm-value')[0].player.id, 25);
  assert.equal(sortDraftCandidates(report.candidates, ranks, 'yahoo')[0].player.id, 3);
  input.board.picks.push({ ...input.board.picks[0], id: 'pick-25', overallPick: 3, playerId: 25, playerName: 'Player 25', selectionId: 'selection-25' });
  const next = buildDraftAdvisor(input), nextRanks = buildDraftCandidateRanks(input.catalog, imports);
  assert.ok(!next.candidates.some(row => row.player.id === 25));
  assert.deepEqual(nextRanks, ranks);
  const nextBest = sortDraftCandidates(next.candidates, nextRanks, 'bbm-value')[0];
  assert.equal(nextBest.player.id, 24);
  assert.equal(nextRanks.byPlayerId.get(nextBest.player.id)!.bbmRank, 2);
  assert.deepEqual(sortDraftCandidates(report.candidates, ranks, 'fit'), report.fitRanking);
  assert.deepEqual(sortDraftCandidates(next.candidates, nextRanks, 'fit'), next.fitRanking);
});

test('fit mode retains its blocked and missing-score exclusions while other rankings display all available rows', () => {
  const pool = catalog(4), ranks = buildDraftCandidateRanks(pool, library(4));
  const candidates = pool.players.map((row, index) => candidate(row, { fitScore: index === 2 ? null : index === 3 ? .1 : .5, blocked: index === 0 }));
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'fit').map(row => row.player.id), [2, 4]);
  assert.equal(sortDraftCandidates(candidates, ranks, 'espn').length, 4);
  const input = advisorFixture(); input.projections = null;
  const report = buildDraftAdvisor(input);
  assert.equal(report.candidates.length, 23);
  assert.ok(report.candidates.every(row => !row.hasProjection));
  assert.deepEqual(report.fitRanking, []);
});
