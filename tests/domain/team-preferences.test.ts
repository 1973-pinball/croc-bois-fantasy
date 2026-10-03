import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateRosterPositions, extractRosterPositions, type RosterPositionHistory } from '../../src/lib/roster-position-history';
import { aggregateCategoryPreferences, extractCategoryPreferences, type CategoryPreferences } from '../../src/lib/category-preferences';
import { extractDraftPlayerCatalog, type DraftPlayerCatalog } from '../../src/lib/draft-player-catalog';
import categoryFile from '../../data/category-preferences.json';
import rosterFile from '../../data/roster-position-history.json';
import catalogFile from '../../data/draft-player-catalog.json';

const source = { sha256: 'a'.repeat(64), url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935', capturedAt: '2026-10-03T12:00:00.000Z' };
const rosterEntry = (id: number, position?: number) => ({ playerId: id, lineupSlotId: 13, playerPoolEntry: { player: { id, defaultPositionId: position, eligibleSlots: [0, 1, 5, 11, 13] } } });

test('roster averages use one primary position and equal season weights, preserving unknown and missing observations', () => {
  const first = extractRosterPositions({ id: 139935, seasonId: 2025, teams: [{ id: 1, roster: { entries: [rosterEntry(1, 1), rosterEntry(2)] } }] }, source);
  const second = extractRosterPositions({ id: 139935, seasonId: 2026, teams: [{ id: 1, roster: { entries: [rosterEntry(1, 1)] } }] }, source);
  const empty = extractRosterPositions({ id: 139935, seasonId: 2027, teams: [{ id: 1, roster: { entries: [] } }] }, source);
  const history: RosterPositionHistory = { version: 1, leagueId: 139935, coverage: { draftYears: [2024, 2025, 2026], limitations: [] }, seasons: [first, second, empty] };
  const row = aggregateRosterPositions(history)[0];
  assert.equal(row.snapshotCount, 2);
  assert.deepEqual(row.recordedSeasons, [2024, 2025]);
  assert.deepEqual(row.missingSeasons, [2026]);
  assert.equal(row.unknownPlayers, 1);
  assert.equal(row.averageRosterSize, 1.5);
  assert.equal(row.positions[0].averageCount, 1);
  assert.equal(row.positions[0].averageShare, 0.75);
  assert.equal(row.positions[1].averageCount, 0); // SG eligibility did not double-count the PG.
  assert.equal(aggregateRosterPositions(history, [2026])[0].positions[0].averageShare, null);
  assert.throws(() => extractRosterPositions({ id: 139935, seasonId: 2026, teams: [{ id: 1, roster: { entries: [rosterEntry(1, 1), rosterEntry(1, 2)] } }] }, source), /Duplicate player/);
  assert.throws(() => aggregateRosterPositions({ ...history, seasons: [first, first] }), /one roster snapshot/);
});

const stat = (result: string | null, score: number) => ({ result, score });
const matchup = (id: number, period: number, home: Record<string, ReturnType<typeof stat>>, away: Record<string, ReturnType<typeof stat>>) => ({
  id, matchupPeriodId: period, playoffTierType: 'NONE', winner: 'HOME', home: { teamId: 1, cumulativeScore: { scoreByStat: home } }, away: { teamId: 2, cumulativeScore: { scoreByStat: away } },
});
function categoryFixture() {
  return { id: 139935, seasonId: 2026, status: { currentMatchupPeriod: 4 },
    settings: { scoringSettings: { scoringType: 'H2H_CATEGORY', scoringItems: [{ statId: 0, points: 1 }, { statId: 11, points: 1, isReverseItem: true }] }, scheduleSettings: { matchupPeriodCount: 5 } },
    teams: [{ id: 1, record: { overall: { wins: 2, losses: 0, ties: 1 } } }, { id: 2, record: { overall: { wins: 0, losses: 2, ties: 1 } } }],
    schedule: [
      matchup(1, 1, { 0: stat('WIN', 100), 11: stat('WIN', 10), 13: stat('WIN', 50) }, { 0: stat('LOSS', 90), 11: stat('LOSS', 15), 13: stat('LOSS', 40) }),
      matchup(2, 2, { 0: stat('TIE', 80) }, { 0: stat('TIE', 80) }),
      matchup(3, 3, { 0: stat('TIE', 0), 11: stat('TIE', 0) }, { 0: stat('TIE', 0), 11: stat('TIE', 0) }),
      matchup(4, 4, { 0: stat('WIN', 10) }, { 0: stat('LOSS', 5) }),
      { ...matchup(5, 5, { 0: stat('WIN', 10) }, { 0: stat('LOSS', 5) }), winner: 'UNDECIDED' },
      { ...matchup(6, 2, { 0: stat('LOSS', 80) }, { 0: stat('WIN', 90) }), playoffTierType: 'WINNERS_BRACKET' },
    ] };
}

test('category outcomes exclude playoffs, cancelled zero weeks and incomplete periods; reverse categories use official outcomes', () => {
  const season = extractCategoryPreferences(categoryFixture(), source);
  assert.deepEqual(season.completedMatchupPeriods, [1, 2]);
  assert.equal(season.excludedUnscoredMatchups, 3);
  assert.equal(season.teams[0].matchups, 2);
  assert.equal(season.teams[0].standingsMatch, true);
  assert.deepEqual(season.teams[0].categories, [
    { id: 0, label: 'PTS', lowerIsBetter: false, wins: 1, losses: 0, ties: 1 },
    { id: 11, label: 'TO', lowerIsBetter: true, wins: 1, losses: 0, ties: 0 },
  ]);
  const history: CategoryPreferences = { version: 1, leagueId: 139935, coverage: { draftYears: [2024, 2025], limitations: [] }, seasons: [season] };
  const row = aggregateCategoryPreferences(history)[0];
  assert.deepEqual(row.missingSeasons, [2024]);
  assert.equal(row.categories[0].winRate, 0.75);
  assert.equal(row.categories[0].decisions, 2);
  assert.equal(row.categories[1].coverageMatchups, 1); // Missing TO is not a loss or tie.
  assert.equal(aggregateCategoryPreferences(history, [2024])[0].categories[0].winRate, null);
  const invalid = categoryFixture();
  invalid.schedule[0].away.cumulativeScore.scoreByStat[0].result = 'WIN';
  assert.throws(() => extractCategoryPreferences(invalid, source), /Inconsistent/);
});

test('catalog preserves ESPN identities and only supplied ROTO ranks; unsigned active players remain selectable', () => {
  const catalogEntry = (id: number, name: string, active: boolean, rank?: number) => ({ id, status: 'FREEAGENT', player: { id, fullName: name, active, proTeamId: id === 1 ? 0 : 20, defaultPositionId: 1, eligibleSlots: [0, 1, 5, 11, 13], draftRanksByRankType: { STANDARD: { rank: 1 }, ...(rank ? { ROTO: { rank, rankType: 'ROTO', slotId: 0 } } : {}) } } });
  const raw = { players: [catalogEntry(1, 'Unsigned Player', true), catalogEntry(2, 'Inactive Player', false, 2), catalogEntry(3, 'First Player', true, 1)] };
  const league = { ...categoryFixture(), seasonId: 2027 };
  const catalog = extractDraftPlayerCatalog(raw, league, source);
  assert.deepEqual(catalog.players.map(player => player.id), [3, 2, 1]);
  assert.equal(catalog.players[2].selectable, true);
  assert.equal(catalog.players[2].nbaTeam, 'FA');
  assert.equal(catalog.players[2].rank, null);
  assert.equal(catalog.players[1].selectable, false);
  assert.equal(catalog.players[1].nbaTeam, 'PHI');
  assert.deepEqual(catalog.players[0].eligiblePositions, ['PG', 'SG']);
  assert.equal(catalog.rankingSource.customLeagueWeighting, false);
  assert.throws(() => extractDraftPlayerCatalog({ players: [raw.players[0], raw.players[0]] }, league, source), /duplicate/);
});

test('published analytics cover each historical franchise and reconcile official standings without leaking raw source fields', () => {
  const category = categoryFile as CategoryPreferences;
  const roster = rosterFile as RosterPositionHistory;
  const catalog = catalogFile as DraftPlayerCatalog;
  assert.equal(category.seasons.length, 9);
  assert.equal(roster.seasons.length, 9);
  assert.ok(category.seasons.every(season => season.teams.length === 8 && season.teams.every(team => team.standingsMatch === true)));
  assert.ok(roster.seasons.every(season => season.teams.length === 8 && season.teams.every(team => team.rosterAvailable && team.unknownPlayers === 0)));
  assert.equal(catalog.players.length, 1095);
  assert.equal(catalog.coverage.ranked, 410);
  assert.equal(new Set(catalog.players.map(player => player.id)).size, 1095);
  assert.ok(!JSON.stringify([category, roster, catalog]).match(/"(?:espn_s2|swid|members|acquisitionDate|seasonOutlook|ownership)"\s*:/i));
});
