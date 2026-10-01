import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leagueData } from '../../src/lib/league-data';
import { buildReferencePickGrids, hasTransferredPicks, partitionPickGridSeasons, pickGridCounts, pickOwnershipEvidence, type DraftPickGridSeason } from '../../src/lib/draft-pick-grids';

test('2026 owner grids reproduce every screenshot cell and verified original-pick transfer', () => {
  const current = buildReferencePickGrids(leagueData).find(season => season.year === 2026)!;
  const counts = pickGridCounts(current);
  const expectedTotals: Record<number, number> = { 1: 14, 2: 11, 3: 13, 4: 13, 5: 14, 6: 13, 7: 13, 8: 13 };
  for (const [id, record] of counts) {
    assert.equal(record.total, expectedTotals[id]);
    for (let round = 1; round <= 13; round++) {
      const expected = id === 2 && [3, 4].includes(round) || id === 1 && round === 8 ? 0 : id === 1 && [3, 4].includes(round) || id === 5 && round === 8 ? 2 : 1;
      assert.equal(record.rounds[round - 1], expected, `team ${id} round ${round}`);
    }
  }
  const transfers = current.picks.filter(pick => pick.originalTeamId !== pick.ownerTeamId).map(pick => ({ year: pick.season, round: pick.round, originalTeamId: pick.originalTeamId, ownerTeamId: pick.ownerTeamId }));
  const evidence = pickOwnershipEvidence.verifiedTransfers.map(({ year, round, originalTeamId, ownerTeamId }) => ({ year, round, originalTeamId, ownerTeamId }));
  assert.deepEqual(transfers.sort((a, b) => a.round - b.round), evidence.sort((a, b) => a.round - b.round));
  assert.deepEqual(current.teams.map(team => team.id), [2, 8, 4, 7, 1, 6, 5, 3]);
});

test('year selection includes distant same-round swaps despite unchanged totals and separates historical grids', () => {
  const reference = buildReferencePickGrids(leagueData);
  const future = reference.find(season => season.year === 2027)!;
  const swapped: DraftPickGridSeason = { ...future, year: 2041, source: 'live', picks: future.picks.map(pick => ({ ...pick, id: `2041-${pick.id}`, season: 2041, ownerTeamId: pick.round === 1 && pick.originalTeamId === 1 ? 2 : pick.round === 1 && pick.originalTeamId === 2 ? 1 : pick.ownerTeamId })) };
  assert.equal(hasTransferredPicks(swapped), true);
  assert.equal([...pickGridCounts(swapped).values()].every(count => count.total === 13 && count.rounds.every(value => value === 1)), true);
  const partition = partitionPickGridSeasons([...reference, swapped], 2026);
  assert.deepEqual(partition.active.map(season => season.year), [2026, 2041]);
  assert.deepEqual(partition.unchangedFuture.map(season => season.year), [2027]);
  assert.deepEqual(partition.historical.map(season => season.year), [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);
});

test('historical owner counts use completed draft records and preserve same-round original-pick swaps', () => {
  const reference = buildReferencePickGrids(leagueData);
  for (const season of reference.filter(season => season.source === 'archive')) {
    assert.equal(season.picks.length, 104, `draft ${season.year}`);
    assert.equal([...pickGridCounts(season).values()].reduce((sum, row) => sum + row.total, 0), 104);
  }
  const draft = reference.find(season => season.year === 2025)!;
  assert.equal(draft.picks.find(pick => pick.round === 7 && pick.originalTeamId === 2)?.ownerTeamId, 5);
  assert.equal(draft.picks.find(pick => pick.round === 7 && pick.originalTeamId === 5)?.ownerTeamId, 2);
  assert.equal(draft.picks.find(pick => pick.round === 8 && pick.originalTeamId === 2)?.ownerTeamId, 5);
  assert.equal(draft.picks.find(pick => pick.round === 8 && pick.originalTeamId === 5)?.ownerTeamId, 2);
  assert.equal(draft.teams.find(team => team.id === 4)?.owner, 'Julian');
});

test('pick counts support ten participants and season-specific round counts', () => {
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, shortName: `T${i + 1}`, owner: `Owner ${i + 1}`, managers: [], color: '#123456' }));
  const season: DraftPickGridSeason = { year: 2030, roundCount: 15, teams, source: 'live', picks: teams.flatMap(team => Array.from({ length: 15 }, (_, index) => ({ id: `2030-${team.id}-${index}`, season: 2030, round: index + 1, originalTeamId: team.id, ownerTeamId: team.id }))) };
  const counts = pickGridCounts(season);
  assert.equal(counts.size, 10);
  assert.equal([...counts.values()].every(row => row.total === 15 && row.rounds.length === 15), true);
});

test('duplicate and invalid pick entries fail instead of silently inflating owner counts', () => {
  const season = buildReferencePickGrids(leagueData).find(item => item.year === 2026)!;
  assert.throws(() => pickGridCounts({ ...season, picks: [...season.picks, season.picks[0]] }), /Invalid pick inventory/);
  assert.throws(() => pickGridCounts({ ...season, picks: [{ ...season.picks[0], ownerTeamId: 999 }] }), /Invalid pick inventory/);
  assert.throws(() => pickGridCounts({ ...season, picks: [{ ...season.picks[0], season: 2030 }] }), /Invalid pick inventory/);
});
