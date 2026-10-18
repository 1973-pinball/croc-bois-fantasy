import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDraftAdvisor, type DraftAdvisorCandidate, type DraftAdvisorInput } from '../../src/lib/draft-advisor';
import { buildDraftCandidateRanks, filterDraftCandidatesByEspnRank, paginateDraftCandidates, sortDraftCandidates, type DraftCandidateRankLibrary } from '../../src/lib/draft-candidate-ranks';
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

test('ESPN rank cutoff uses imported ranks inclusively before sorting the full pool, and clearing it restores unranked players', () => {
  const pool = catalog(), imports = library();
  pool.players[1].rank = 101;
  pool.players[2].rank = null;
  pool.players[3].rank = 100;
  pool.players[4].rank = 101;
  pool.players[24].rank = 120;
  imports.espn = dataset('espn', [{ ...projection(1), providerRank: 101 }, { ...projection(2), providerRank: 100 }, { ...projection(25), providerRank: 99 }]);
  const ranks = buildDraftCandidateRanks(pool, imports), candidates = pool.players.map(row => candidate(row));
  const before = structuredClone(candidates), filtered = filterDraftCandidatesByEspnRank(candidates, ranks, 100);
  assert.deepEqual(filtered.map(row => row.player.id), [2, 4, ...Array.from({ length: 20 }, (_, index) => index + 6)]);
  assert.deepEqual(sortDraftCandidates(filtered, ranks, 'bbm-value').map(row => row.player.id), [25, 4, 2, ...Array.from({ length: 12 }, (_, index) => 24 - index)]);
  assert.deepEqual(filterDraftCandidatesByEspnRank(candidates, ranks, null), candidates);
  assert.deepEqual(candidates, before);
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

test('all provider rankings and the ESPN minus BBM gap support both directions with missing ranks last', () => {
  const pool = catalog(6);
  [80, 10, 45, 120, 60, null].forEach((rank, index) => { pool.players[index].rank = rank; });
  const ranks = buildDraftCandidateRanks(pool, {
    'basketball-monster': dataset('basketball-monster', [45, 20, 5, 200].map((providerRank, index) => ({ ...projection(index + 1), providerRank })).concat([{ ...projection(6), providerRank: 2 }])),
    yahoo: dataset('yahoo', [3, 4, 1, 2].map((providerRank, index) => ({ ...projection(index + 1), providerRank }))),
  });
  const candidates = [...pool.players].reverse().map(row => candidate(row));
  const expected = {
    espn: { ascending: [2, 3, 5, 1, 4, 6], descending: [4, 1, 5, 3, 2, 6] },
    bbm: { ascending: [6, 3, 2, 1, 4, 5], descending: [4, 1, 2, 3, 6, 5] },
    yahoo: { ascending: [3, 4, 1, 2, 5, 6], descending: [2, 1, 4, 3, 5, 6] },
    'bbm-value': { ascending: [4, 2, 1, 3, 5, 6], descending: [3, 1, 2, 4, 5, 6] },
  };
  for (const order of ['espn', 'bbm', 'yahoo', 'bbm-value'] as const) {
    for (const direction of ['ascending', 'descending'] as const) {
      assert.deepEqual(sortDraftCandidates(candidates, ranks, order, 15, direction).map(row => row.player.id), expected[order][direction], `${order} ${direction}`);
    }
  }
});

test('reversing the rank gap keeps equal-value players in ESPN, name and ID order', () => {
  const pool = catalog(5);
  [80, 80, 80, 60, 120].forEach((rank, index) => { pool.players[index].rank = rank; });
  pool.players[0].name = 'Beta'; pool.players[1].name = 'Alpha'; pool.players[2].name = 'Alpha';
  const ranks = buildDraftCandidateRanks(pool, {
    'basketball-monster': dataset('basketball-monster', [45, 45, 45, 25, 60].map((providerRank, index) => ({ ...projection(index + 1), providerRank }))),
  });
  const candidates = [...pool.players].reverse().map(row => candidate(row));
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value', 15, 'ascending').map(row => row.player.id), [4, 2, 3, 1, 5]);
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value', 15, 'descending').map(row => row.player.id), [5, 4, 2, 3, 1]);
});

test('reversing ranking direction sorts the entire available pool before the row limit', () => {
  const pool = catalog(), ranks = buildDraftCandidateRanks(pool, library());
  const candidates = pool.players.map(row => candidate(row)), before = structuredClone(candidates);
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'espn', 15, 'descending').map(row => row.player.id), Array.from({ length: 15 }, (_, index) => 25 - index));
  assert.deepEqual(sortDraftCandidates(candidates, ranks, 'bbm-value', 3, 'ascending').map(row => row.player.id), [1, 2, 3]);
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

test('ESPN after keepers closes rank gaps across the full selectable pool and stays fixed after filtering, paging and selections', () => {
  const input = advisorFixture(), pool = catalog(8);
  [1, 4, 7, 20, null, 7, 9, 3].forEach((rank, index) => { pool.players[index].rank = rank; });
  pool.players[5].name = 'Alpha'; pool.players[6].selectable = false;
  const imports = { espn: dataset('espn', [{ ...projection(4), providerRank: 2 }]) };
  const before = structuredClone({ pool, imports, board: input.board });
  const ranks = buildDraftCandidateRanks(pool, imports, {}, input.board);
  // Player 1 was drafted, player 2 was kept. Only the keeper is removed from this baseline.
  assert.deepEqual([...ranks.espnAfterKeepersByPlayerId], [[1, 1], [4, 2], [8, 3], [6, 4], [3, 5]]);
  assert.equal(ranks.byPlayerId.get(2)!.espnRank, 4);
  assert.equal(ranks.byPlayerId.get(3)!.espnRank, 7);
  assert.equal(ranks.byPlayerId.get(4)!.espnRank, 2);
  assert.equal(ranks.espnAfterKeepersByPlayerId.has(5), false); // Unknown source rank stays unknown.
  assert.equal(ranks.espnAfterKeepersByPlayerId.has(7), false); // Nonselectable players do not consume a rank.
  const available = pool.players.filter(row => row.selectable && row.id !== 1 && row.id !== 2).map(row => candidate(row));
  const filtered = filterDraftCandidatesByEspnRank(available, ranks, 7);
  const sorted = sortDraftCandidates(filtered, ranks, 'espn-after-keepers', filtered.length);
  assert.deepEqual(sorted.map(row => row.player.id), [4, 8, 6, 3]);
  const secondPage = paginateDraftCandidates(sorted, 2, 2);
  assert.deepEqual(secondPage.candidates.map(row => ranks.espnAfterKeepersByPlayerId.get(row.player.id)), [4, 5]);
  assert.deepEqual(sortDraftCandidates(available, ranks, 'espn-after-keepers', 15, 'descending').map(row => row.player.id), [3, 6, 8, 4, 5]);
  assert.deepEqual({ pool, imports, board: input.board }, before);
  input.board.picks.push({ ...input.board.picks[0], id: 'pick-8', overallPick: 3, playerId: 8, playerName: 'Player 8', selectionId: 'selection-8' });
  assert.deepEqual(buildDraftCandidateRanks(pool, imports, {}, input.board), ranks);
});

test('keeper-adjusted ranks wait for a revealed board and do not expose an unrevealed keeper list', () => {
  const input = advisorFixture(), imports = library();
  for (const board of [undefined, null, { ...input.board, keepersRevealedAt: null }]) {
    const ranks = buildDraftCandidateRanks(input.catalog, imports, {}, board);
    assert.equal(ranks.espnAfterKeepersByPlayerId.size, 0);
    assert.equal(ranks.bbmAfterKeepersByPlayerId.size, 0);
  }
  const revealed = buildDraftCandidateRanks(input.catalog, imports, {}, input.board);
  assert.equal(revealed.espnAfterKeepersByPlayerId.get(3), 2);
  assert.equal(revealed.bbmAfterKeepersByPlayerId.get(1), 24);
  assert.equal(buildDraftCandidateRanks(input.catalog, {}, {}, input.board).bbmAfterKeepersByPlayerId.size, 0);
});

test('BBM after keepers ranks the full source-ranked pool and stays fixed after filters, pages and selections', () => {
  const input = advisorFixture(), pool = catalog(9);
  pool.players[5].name = 'Alpha'; pool.players[8].name = 'Alpha';
  pool.players[6].selectable = false; pool.players[8].rank = 100;
  const imports = { 'basketball-monster': dataset('basketball-monster', [1, 4, 7, 2, undefined, 7, 9, 3, 7]
    .map((providerRank, index) => ({ ...projection(index + 1), providerRank }))
    .concat([{ ...projection(999, 20), providerRank: 1 }])) };
  const before = structuredClone({ pool, imports, board: input.board });
  const ranks = buildDraftCandidateRanks(pool, imports, {}, input.board);
  // Drafted player 1 still consumes a rank; keeper 2 does not. Ties use name then ID.
  assert.deepEqual([...ranks.bbmAfterKeepersByPlayerId], [[1, 1], [4, 2], [8, 3], [6, 4], [9, 5], [3, 6]]);
  assert.deepEqual(ranks.byPlayerId, buildDraftCandidateRanks(pool, imports).byPlayerId);
  assert.equal(ranks.byPlayerId.get(2)!.bbmRank, 4);
  assert.equal(ranks.byPlayerId.get(3)!.bbmRank, 7);
  assert.equal(ranks.byPlayerId.get(3)!.bbmValue, -4);
  assert.equal(ranks.bbmAfterKeepersByPlayerId.has(5), false); // Missing source rank stays missing.
  assert.equal(ranks.bbmAfterKeepersByPlayerId.has(7), false); // Nonselectable players do not consume a rank.
  assert.equal(ranks.bbmAfterKeepersByPlayerId.has(999), false); // Unknown identities do not consume a rank.
  const available = [...pool.players].reverse().filter(row => row.selectable && row.id !== 1 && row.id !== 2).map(row => candidate(row));
  const filtered = filterDraftCandidatesByEspnRank(available, ranks, 9);
  const sorted = sortDraftCandidates(filtered, ranks, 'bbm-after-keepers', filtered.length);
  assert.deepEqual(sorted.map(row => row.player.id), [4, 8, 6, 3, 5]);
  const secondPage = paginateDraftCandidates(sorted, 2, 2);
  assert.deepEqual(secondPage.candidates.map(row => ranks.bbmAfterKeepersByPlayerId.get(row.player.id)), [4, 6]);
  assert.deepEqual(sortDraftCandidates(available, ranks, 'bbm-after-keepers').map(row => row.player.id), [4, 8, 6, 9, 3, 5]);
  assert.deepEqual(sortDraftCandidates(available, ranks, 'bbm-after-keepers', 15, 'descending').map(row => row.player.id), [3, 9, 6, 8, 4, 5]);
  assert.deepEqual({ pool, imports, board: input.board }, before);
  input.board.picks.push({ ...input.board.picks[0], id: 'pick-8', overallPick: 3, playerId: 8, playerName: 'Player 8', selectionId: 'selection-8' });
  assert.deepEqual(buildDraftCandidateRanks(pool, imports, {}, input.board), ranks);
});

test('BBM after keepers uses compatible private ranks and excludes conflicting snapshots', () => {
  const input = advisorFixture(), pool = catalog(5);
  const supplied = { ...rankSnapshot(), ranks: [...rankSnapshot().ranks, { id: 4, providerRank: 3 }] };
  const snapshots = { 'basketball-monster': supplied };
  const imports = { 'basketball-monster': dataset('basketball-monster', [{ ...projection(1), providerRank: 7 }, projection(2)]) };
  const before = structuredClone({ imports, snapshots });
  const ranks = buildDraftCandidateRanks(pool, imports, snapshots, input.board);
  assert.deepEqual([...ranks.bbmAfterKeepersByPlayerId], [[3, 1], [4, 2], [1, 3]]);
  assert.deepEqual(buildDraftCandidateRanks(pool, {}, snapshots, input.board).bbmAfterKeepersByPlayerId, ranks.bbmAfterKeepersByPlayerId);
  assert.deepEqual({ imports, snapshots }, before);
  imports['basketball-monster'].players[0].providerRank = 5;
  const conflicting = buildDraftCandidateRanks(pool, imports, snapshots, input.board);
  assert.deepEqual([...conflicting.bbmAfterKeepersByPlayerId], [[1, 1]]);
  assert.equal(conflicting.byPlayerId.get(1)!.bbmRank, 5);
  assert.equal(conflicting.byPlayerId.get(3)!.bbmRank, null);
});

test('pagination covers every globally sorted candidate once and clamps only pages outside the current pool', () => {
  const pool = catalog(32), ranks = buildDraftCandidateRanks(pool, library(32));
  const sorted = sortDraftCandidates(pool.players.map(row => candidate(row)), ranks, 'bbm-value', pool.players.length);
  const before = structuredClone(sorted);
  const first = paginateDraftCandidates(sorted, 1), second = paginateDraftCandidates(sorted, 2), last = paginateDraftCandidates(sorted, 3);
  assert.deepEqual(first.candidates.concat(second.candidates, last.candidates), sorted);
  assert.deepEqual([first.start, first.end, first.total, first.pageCount], [1, 15, 32, 3]);
  assert.deepEqual([second.start, second.end, second.page], [16, 30, 2]);
  assert.deepEqual([last.start, last.end, last.candidates.length], [31, 32, 2]);
  assert.equal(paginateDraftCandidates(sorted, 99).page, 3);
  assert.equal(paginateDraftCandidates(sorted.slice(0, 31), 2).page, 2);
  const shrunk = paginateDraftCandidates(sorted.slice(0, 16), 3);
  assert.deepEqual([shrunk.page, shrunk.pageCount, shrunk.start, shrunk.end], [2, 2, 16, 16]);
  assert.deepEqual(paginateDraftCandidates([], 3), { candidates: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
  assert.equal(paginateDraftCandidates(sorted, NaN).page, 1);
  assert.deepEqual(sorted, before);
});
