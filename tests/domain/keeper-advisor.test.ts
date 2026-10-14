import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKeeperAdvisor, rankKeeperProjections, type KeeperAdvisorInput } from '../../src/lib/keeper-advisor';
import { validatePlanner } from '../../src/lib/planner';
import { keeperPaymentOptions } from '../../src/lib/keeper-payment-options';
import type { DraftPlayerCatalog } from '../../src/lib/draft-player-catalog';
import type { DraftPlayerProjection, DraftProjectionDataset, DraftProjectionStats } from '../../src/lib/draft-projections';
import type { LeagueData, LeaguePlayer } from '../../src/lib/types';

const stats: DraftProjectionStats = { pts: 20, reb: 5, ast: 5, stl: 1, blk: 1, tov: 2, three: 2, fgm: 7, fga: 15, ftm: 4, fta: 5 };
const player = (id: number, overrides: Partial<LeaguePlayer> = {}): LeaguePlayer => ({ id, name: `Player ${id}`, teamId: 1, baseCost: 13, tenure: 1, status: 'eligible', reason: 'Verified', wasKept: false, previousRound: null, rosterSlot: 'Active', ...overrides });
function fixture(keepers = [player(1), player(9)]): KeeperAdvisorInput {
  const projections: DraftProjectionDataset = { source: 'espn', sourceLabel: 'ESPN projections', seasonId: 2027, importedAt: '2026-10-13T10:00:00.000Z', warnings: [], players: Array.from({ length: 110 }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, games: 70, stats: { ...stats, pts: 150 - index } })) };
  const catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'> = { espnSeasonId: 2027, players: projections.players.map(p => ({ id: p.id, name: p.name, nbaTeam: 'BOS', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: 111 - p.id, rankSource: 'ROTO', selectable: true, active: true })) };
  const leagueData: LeagueData = { season: 2026, snapshotDate: '2026-10-13', teams: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}`, owner: 'Owner', managers: [], shortName: `T${index + 1}`, color: '#ffffff' })), players: keepers, picks: Array.from({ length: 13 }, (_, index) => ({ id: `pick-${index + 1}`, season: 2026, round: index + 1, originalTeamId: 1, ownerTeamId: 1 })), drafts: [], trades: [], reviewItems: [], charter: [] };
  return { teamId: 1, projections, catalog, leagueData };
}

test('keeper ranks derive nine-category value rather than provider ranks, and reverse turnovers', () => {
  const projections: DraftPlayerProjection[] = [
    { id: 1, name: 'High turnovers', games: 70, stats: { ...stats, tov: 5 } },
    { id: 2, name: 'Low turnovers', games: 70, stats: { ...stats, tov: 1 } },
  ];
  assert.deepEqual(rankKeeperProjections(projections).map(row => row.id), [2, 1]);
  const input = fixture();
  const report = buildKeeperAdvisor(input);
  assert.equal(report.rows.find(row => row.player.id === 1)?.projectedRank, 1);
  assert.equal(input.catalog.players[0].rank, 110);
});

test('percentage impact rewards shooting volume at equal above-average percentages', () => {
  const ranked = rankKeeperProjections([
    { id: 1, name: 'Small volume', games: 70, stats: { ...stats, fgm: 1, fga: 2, three: 0 } },
    { id: 2, name: 'Large volume', games: 70, stats: { ...stats, fgm: 10, fga: 20, three: 0 } },
    { id: 3, name: 'Low percentage', games: 70, stats: { ...stats, fgm: 1, fga: 10, three: 0 } },
  ]);
  assert.deepEqual(ranked.map(row => row.id), [2, 1, 3]);
});

test('keeper recommendations jointly allocate actual picks and show positive round savings', () => {
  const input = fixture([player(1), player(17)]);
  const report = buildKeeperAdvisor(input);
  assert.equal(report.assignments.length, 2);
  assert.deepEqual(new Set(report.rows.map(row => row.paymentRound)), new Set([12, 13]));
  assert.ok(report.rows.every(row => row.keep === true && row.roundSavings! > 0));
  assert.equal(report.rows.find(row => row.player.id === 17)?.projectedRound, 3);
  assert.deepEqual(validatePlanner(1, report.assignments, input.leagueData), []);
  assert.equal(report.rows.reduce((sum, row) => sum + row.roundSavings!, 0), 21);
});

test('competing keepers cannot both claim the same pick and losing rows retain their individual comparison', () => {
  const input = fixture(); input.leagueData.picks = [input.leagueData.picks[12]];
  const report = buildKeeperAdvisor(input);
  assert.deepEqual(report.assignments, [{ playerId: 1, pickId: 'pick-13' }]);
  const excluded = report.rows.find(row => row.player.id === 9)!;
  assert.equal(excluded.keep, false);
  assert.equal(excluded.paymentRound, 13);
  assert.equal(excluded.roundSavings, 11);
  assert.match(excluded.reasons.join(' '), /allocated to Player 1/);
});

test('pick trades and consumed picks control the real payment cost, not the original franchise or nominal cost', () => {
  const input = fixture([player(17)]);
  input.leagueData.picks = [
    { id: 'traded-away', season: 2026, round: 13, originalTeamId: 1, ownerTeamId: 2 },
    { id: 'acquired', season: 2026, round: 10, originalTeamId: 2, ownerTeamId: 1 },
    { id: 'used', season: 2026, round: 12, originalTeamId: 1, ownerTeamId: 1 },
    { id: 'wrong-year', season: 2027, round: 13, originalTeamId: 1, ownerTeamId: 1 },
  ];
  input.usedPickIds = ['used'];
  const row = buildKeeperAdvisor(input).rows[0];
  assert.equal(row.pickId, 'acquired');
  assert.equal(row.paymentRound, 10);
  assert.equal(row.roundSavings, 7);
  assert.equal(row.keep, true);
});

test('an earlier legal payment can erase nominal keeper value', () => {
  const input = fixture([player(17)]); input.leagueData.picks = [input.leagueData.picks[1]];
  const row = buildKeeperAdvisor(input).rows[0];
  assert.equal(row.projectedRound, 3);
  assert.equal(row.baseCost, 13);
  assert.equal(row.paymentRound, 2);
  assert.equal(row.roundSavings, -1);
  assert.equal(row.keep, false);
});

test('deadline payment inventory prevents a later pick acquisition from improving keeper value', () => {
  const input = fixture([player(17)]);
  input.leagueData.picks = [
    { id: 'retained', season: 2026, round: 2, originalTeamId: 1, ownerTeamId: 1 },
    { id: 'later-acquired', season: 2026, round: 13, originalTeamId: 2, ownerTeamId: 1 },
    { id: 'traded-away', season: 2026, round: 12, originalTeamId: 1, ownerTeamId: 2 },
  ];
  assert.equal(buildKeeperAdvisor(input).rows[0].keep, true);
  input.deadlinePicks = input.leagueData.picks.map(pick => ({ ...pick, ownerTeamId: pick.id === 'later-acquired' ? 2 : 1 }));
  const row = buildKeeperAdvisor(input).rows[0];
  assert.equal(row.pickId, 'retained');
  assert.equal(row.paymentRound, 2);
  assert.equal(row.roundSavings, -1);
  assert.equal(row.keep, false);
});

test('pending deadline inventory leaves payment decisions unavailable without hiding projection ranks', () => {
  const input = fixture([player(17)]);
  input.deadlinePicks = null;
  const report = buildKeeperAdvisor(input);
  assert.equal(report.rows[0].keep, null);
  assert.equal(report.rows[0].projectedRank, 17);
  assert.equal(report.rows[0].paymentRound, null);
  assert.deepEqual(report.assignments, []);
  assert.match(report.warnings.join(' '), /deadline pick-ownership snapshot/);
});

test('existing keeper rules reject fresh first-round players and expired tenure; unresolved history stays undecided', () => {
  const input = fixture([player(1, { previousRound: 1 }), player(9, { tenure: 5 }), player(17, { status: 'review', reason: 'Needs ruling' }), player(25, { tenure: null })]);
  const rows = new Map(buildKeeperAdvisor(input).rows.map(row => [row.player.id, row]));
  assert.equal(rows.get(1)?.keep, false);
  assert.match(rows.get(1)!.reasons.join(' '), /round one/);
  assert.equal(rows.get(9)?.keep, false);
  assert.equal(rows.get(17)?.keep, null);
  assert.equal(rows.get(25)?.keep, null);
});

test('missing projections, too-small pools, stale seasons and unverified identities do not generate keeper calls', () => {
  const missing = fixture(); missing.projections!.players = missing.projections!.players.filter(player => player.id !== 1);
  assert.equal(buildKeeperAdvisor(missing).rows.find(row => row.player.id === 1)?.keep, null);
  const small = fixture(); small.projections!.players = small.projections!.players.slice(0, 8);
  assert.ok(buildKeeperAdvisor(small).rows.every(row => row.keep === null));
  const stale = fixture(); stale.projections!.seasonId = 2026;
  assert.ok(buildKeeperAdvisor(stale).rows.every(row => row.keep === null));
  const duplicates = fixture(); duplicates.leagueData.picks.push(duplicates.leagueData.picks[0]);
  assert.ok(buildKeeperAdvisor(duplicates).rows.every(row => row.keep === null));
});

test('zero projected games are never presented as a positive keep recommendation', () => {
  const input = fixture([player(1)]); input.projections!.players[0].games = 0;
  const row = buildKeeperAdvisor(input).rows[0];
  assert.equal(row.keep, false);
  assert.equal(row.projectedRank, 1);
  assert.match(row.reasons.join(' '), /zero games/);
});

test('known keeper ineligibility is a no even when this source has no player projection', () => {
  const input = fixture([player(1, { status: 'ineligible', reason: 'First-round keeper restriction' }), player(9, { tenure: 5 }), player(17, { status: 'review' })]);
  input.projections!.players = input.projections!.players.filter(player => ![1, 9, 17].includes(player.id));
  const rows = new Map(buildKeeperAdvisor(input).rows.map(row => [row.player.id, row]));
  assert.equal(rows.get(1)?.keep, false);
  assert.equal(rows.get(9)?.keep, false);
  assert.equal(rows.get(1)?.projectedRank, null);
  assert.equal(rows.get(17)?.keep, null);
  input.projections = null;
  assert.equal(buildKeeperAdvisor(input).rows.find(row => row.player.id === 9)?.keep, false);
});

test('the joint choice beats greedy single-player savings under competition for earlier picks', () => {
  const input = fixture([player(1, { baseCost: 4 }), player(9, { baseCost: 4 }), player(17, { baseCost: 13 })]);
  input.leagueData.picks = input.leagueData.picks.filter(pick => [2, 4, 13].includes(pick.round));
  const result = buildKeeperAdvisor(input);
  assert.deepEqual(validatePlanner(1, result.assignments, input.leagueData), []);
  assert.deepEqual(new Set(result.assignments.map(assignment => assignment.playerId)), new Set([1, 17]));
  assert.equal(result.rows.filter(row => row.keep).reduce((sum, row) => sum + row.roundSavings!, 0), 13);
});

test('bounded keeper search matches exhaustive legal subsets across changing pick holdings and costs', () => {
  let seed = 431;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed; };
  for (let example = 0; example < 40; example += 1) {
    const input = fixture([1, 9, 17, 25, 33].map(id => player(id, { baseCost: random() % 13 + 1 })));
    input.leagueData.picks = input.leagueData.picks.filter(() => random() % 2 === 0);
    const actual = buildKeeperAdvisor(input);
    let expectedScore = 0;
    for (let mask = 0; mask < 32; mask += 1) {
      const selected = input.leagueData.players.filter((_, index) => mask & (1 << index));
      const allocation = keeperPaymentOptions({ season: 2026, teamId: 1, picks: input.leagueData.picks, includeOptions: false, keepers: selected.map(row => ({ playerId: row.id, pickId: '', baseRound: row.baseCost })) }).assignments;
      if (!allocation || validatePlanner(1, allocation, input.leagueData).length) continue;
      const score = allocation.reduce((sum, assignment) => sum + input.leagueData.picks.find(pick => pick.id === assignment.pickId)!.round - Math.ceil(assignment.playerId / 8), 0);
      expectedScore = Math.max(expectedScore, score);
    }
    assert.equal(actual.rows.filter(row => row.keep).reduce((sum, row) => sum + row.roundSavings!, 0), expectedScore);
    assert.ok(actual.rows.filter(row => row.keep).every(row => row.roundSavings! > 0));
    assert.deepEqual(validatePlanner(1, actual.assignments, input.leagueData), []);
  }
});

test('allocation-only mode keeps the same legal payment without building alternate UI choices', () => {
  const input = fixture();
  const request = { season: 2026, teamId: 1, picks: input.leagueData.picks, keepers: [{ playerId: 1, pickId: '', baseRound: 13 }, { playerId: 9, pickId: '', baseRound: 13 }] };
  assert.deepEqual(keeperPaymentOptions({ ...request, includeOptions: false }).assignments, keeperPaymentOptions(request).assignments);
  assert.deepEqual(keeperPaymentOptions({ ...request, includeOptions: false }).options, {});
});

test('confirmed own keeper reservations can be compared again while draft-used and other-team picks stay unavailable', () => {
  const input = fixture([player(1), player(9)]);
  input.leagueData.picks = [
    { id: 'keeper-reservation', season: 2026, round: 12, originalTeamId: 1, ownerTeamId: 1 },
    { id: 'actual-draft-selection', season: 2026, round: 13, originalTeamId: 1, ownerTeamId: 1 },
    { id: 'other-team-keeper', season: 2026, round: 13, originalTeamId: 1, ownerTeamId: 2 },
  ];
  input.usedPickIds = input.leagueData.picks.map(pick => pick.id);
  input.reusablePickIds = ['keeper-reservation', 'other-team-keeper'];
  const before = JSON.stringify(input);
  const result = buildKeeperAdvisor(input);
  assert.deepEqual(result.assignments, [{ playerId: 1, pickId: 'keeper-reservation' }]);
  assert.equal(result.rows.find(row => row.player.id === 1)?.paymentRound, 12);
  assert.equal(result.rows.find(row => row.player.id === 9)?.keep, false);
  assert.equal(JSON.stringify(input), before);
  input.reusablePickIds = [];
  assert.deepEqual(buildKeeperAdvisor(input).assignments, []);
});
