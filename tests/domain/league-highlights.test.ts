import { test } from 'node:test';
import assert from 'node:assert/strict';
import history from '../../data/playoff-history.json';
import { summarizeLeagueHistory } from '../../src/lib/league-highlights';
import type { PlayoffHistory, StatisticsOnlySeason } from '../../src/lib/playoff-history';

const seasons = (history as PlayoffHistory).seasons;
test('overview totals do not rank a partial historical archive as all-time', () => {
  const result = summarizeLeagueHistory(seasons, [2025, 2026]);
  assert.equal(result.championshipsComplete, false);
  assert.deepEqual(result.championships, []);
  assert.equal(result.wins, undefined);
});
test('verified championship and category wins are available for a fully covered period', () => {
  const result = summarizeLeagueHistory(seasons, [2026]);
  assert.deepEqual(result.championships, [{ franchiseId: '2', count: 1 }]);
  assert.equal(result.wins?.find(row => row.franchiseId === '1')?.count, 82);
  assert.equal(result.winsComplete, true);
});
test('missing team wins suppress the complete-period wins ranking without losing championship proof', () => {
  const partial = structuredClone(seasons);
  delete partial[0].participants[0].regularSeasonWins;
  const result = summarizeLeagueHistory(partial, [2026]);
  assert.equal(result.championshipsComplete, true);
  assert.equal(result.wins, undefined);
  assert.throws(() => summarizeLeagueHistory(seasons, [2026, 2026]), /duplicate/);
});

test('2025 and later category results join stored history even without a verified bracket', () => {
  const stats: StatisticsOnlySeason = {
    draftYear: 2025, espnSeasonId: 2025, priorSeasonStartYear: 2024, qualificationStatus: 'unverified',
    participants: seasons[0].participants.map(team => ({ espnTeamId: team.espnTeamId, franchiseId: team.franchiseId, regularSeasonWins: 10 })),
    source: { kind: 'espn-local-json', leagueId: 139935, sha256: 'a'.repeat(64), paths: ['teams[].record.overall.wins'] },
  };
  const result = summarizeLeagueHistory(seasons, [2025, 2026], [stats]);
  assert.equal(result.winsComplete, true);
  assert.equal(result.wins?.find(team => team.franchiseId === '1')?.count, 92);
  assert.equal(result.championshipsComplete, false);
  assert.deepEqual(result.championships, []);
  assert.equal(summarizeLeagueHistory(seasons, [2025, 2026, 2027], [stats]).wins, undefined);
});
