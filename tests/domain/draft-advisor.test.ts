import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDraftAdvisor, type DraftAdvisorInput } from '../../src/lib/draft-advisor';
import type { DraftBoardPick } from '../../src/lib/draft-board';
import type { DraftRosterSettings } from '../../src/lib/espn-roster-settings';
import type { DraftProjectionStats } from '../../src/lib/draft-projections';

const teamA = '71000000-0000-4000-8000-000000000001', teamB = '71000000-0000-4000-8000-000000000002';
const source = { sha256: 'a'.repeat(64), url: 'https://example.com/fixture', capturedAt: '2026-10-13T00:00:00Z' };
const labels: Record<number, string> = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 11: 'UTIL', 12: 'BE', 13: 'IR' };
const stats = (overrides: Partial<DraftProjectionStats> = {}): DraftProjectionStats => ({ pts: 15, reb: 5, ast: 3, stl: 1, blk: 1, tov: 2, three: 1, fgm: 5, fga: 10, ftm: 2, fta: 3, ...overrides });
function settings(counts: Record<number, number>): DraftRosterSettings {
  const slots = Object.entries(counts).map(([id, count]) => ({ slotId: Number(id), label: labels[Number(id)], count, kind: Number(id) === 13 ? 'reserve' as const : 'normal' as const }));
  return { version: 1, leagueId: 139935, espnSeasonId: 2027, source, slots, slotDefinitionsSource: source, positionLimitsSource: source,
    slotDefinitions: slots.map(slot => ({ slotId: slot.slotId, label: slot.label, name: slot.label, bench: slot.slotId === 12, reserve: slot.kind === 'reserve', lineupSlotEligible: true })),
    normalCapacity: slots.filter(slot => slot.kind === 'normal').reduce((sum, slot) => sum + slot.count, 0), reserveCapacity: slots.filter(slot => slot.kind === 'reserve').reduce((sum, slot) => sum + slot.count, 0),
    lineupSlotCounts: Object.fromEntries(Object.entries(counts)), positionLimits: { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1 }, isBenchUnlimited: true,
    primaryPositionLimits: [1, 2, 3, 4, 5].map(positionId => ({ positionId, label: labels[positionId - 1], maximum: null })), limitations: [] };
}
function pick(playerId: number, owner = teamA, overrides: Partial<DraftBoardPick> = {}): DraftBoardPick {
  return { id: `pick-${playerId}`, round: playerId, overallPick: playerId, originalFranchiseId: owner, currentOwnerId: owner, status: 'selected', playerId, playerName: `Player ${playerId}`, selectionId: `selection-${playerId}`, ...overrides };
}
function fixture(count = 22): DraftAdvisorInput {
  return {
    franchiseId: teamA,
    board: { seasonId: '72000000-0000-4000-8000-000000000001', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13, revision: 1,
      clock: { status: 'running', durationSeconds: 90, remainingSeconds: 60, deadlineAt: '2026-10-13T00:00:00Z', startedAt: '2026-10-13T00:00:00Z', serverNow: '2026-10-13T00:00:00Z' },
      keepersRevealedAt: '2026-10-13T00:00:00Z', orderComplete: true, orderLocked: true, nextPickId: null,
      teams: [{ franchiseId: teamA, espnTeamId: 1, displayName: 'A', draftPosition: 1 }, { franchiseId: teamB, espnTeamId: 2, displayName: 'B', draftPosition: 2 }], picks: [pick(1), pick(2, teamB)] },
    settings: settings({ 0: 1, 1: 1, 4: 1, 11: 2, 12: 5, 13: 2 }),
    eligibility: { version: 1, leagueId: 139935, espnSeasonId: 2027, source,
      players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, eligibleSlots: [0, 1, 11, 12, 13], primaryPositionId: 1, injuryStatus: 'ACTIVE', active: true, poolStatus: 'FREEAGENT' })) },
    catalog: { version: 1, leagueId: 139935, espnSeasonId: 2027, fetchedAt: source.capturedAt, source,
      rankingSource: { field: 'ROTO', label: 'ESPN category rankings', rankType: 'ROTO', customLeagueWeighting: false, limitations: [] },
      categories: [{ id: 0, label: 'PTS' }, { id: 6, label: 'REB' }, { id: 3, label: 'AST' }, { id: 2, label: 'STL' }, { id: 1, label: 'BLK' }, { id: 17, label: '3PM' }, { id: 11, label: 'TO' }, { id: 19, label: 'FG%' }, { id: 20, label: 'FT%' }].map(category => ({ ...category, lowerIsBetter: category.id === 11 })),
      coverage: { players: count, ranked: count, unranked: 0, selectable: count, unsigned: 0 },
      players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, nbaTeam: index === 1 ? 'BOS' : 'ATL', primaryPosition: 'PG', eligiblePositions: ['PG', 'SG'], rank: index + 1, rankSource: 'ROTO', active: true, selectable: true })) },
    projections: { source: 'espn', sourceLabel: 'ESPN fixture', seasonId: 2027, importedAt: source.capturedAt, warnings: [], players: Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Player ${index + 1}`, games: 82, stats: stats() })) },
  };
}
const projection = (input: DraftAdvisorInput, id: number) => input.projections!.players.find(player => player.id === id)!;

test('weighs percentages by attempts, reverses turnovers, and leaves the source immutable', () => {
  const input = fixture(); input.board.picks.push(pick(3));
  projection(input, 1).stats = stats({ fgm: 1, fga: 1, ftm: 1, fta: 1, tov: 0.2 });
  projection(input, 3).stats = stats({ fgm: 9, fga: 19, ftm: 9, fta: 19, tov: 0.2 });
  projection(input, 2).stats = stats({ fgm: 6, fga: 10, ftm: 6, fta: 10, tov: 10 });
  const before = structuredClone(input), report = buildDraftAdvisor(input), team = report.selectedTeam!;
  assert.deepEqual(input, before);
  assert.equal(team.categories.find(category => category.id === 19)!.projectedValue, 0.5);
  assert.equal(team.categories.find(category => category.id === 20)!.projectedValue, 0.5);
  assert.ok(team.categories.find(category => category.id === 19)!.winProbability! < 0.5);
  assert.ok(team.categories.find(category => category.id === 20)!.winProbability! < 0.5);
  assert.ok(team.categories.find(category => category.id === 11)!.winProbability! > 0.5);
  assert.equal(report.matchups[0].categoryWinRate, team.categoryWinRate);
  assert.ok(report.warnings.some(warning => warning.includes('partial rosters')));
});

test('shows the first 15 available by ESPN rank but optimizes the entire projected player pool', () => {
  const input = fixture(25);
  projection(input, 25).stats = stats({ pts: 50, reb: 20, ast: 15, stl: 4, blk: 4, tov: 0.1, three: 8, fgm: 20, fga: 25, ftm: 10, fta: 11 });
  const report = buildDraftAdvisor(input);
  assert.deepEqual(report.topAvailable.map(row => row.player.id), Array.from({ length: 15 }, (_, index) => index + 3));
  assert.equal(report.evaluatedCandidates, 23);
  assert.equal(report.categoryRecommendation?.player.id, 25);
  assert.ok(report.categoryRecommendation!.categoryGain! > 0);
  assert.ok(report.fitRanking.some(row => row.player.id === 25));
});

test('rebuilds ownership after corrections, undo, keepers, and current-owner trades', () => {
  const input = fixture(); input.board.picks.push(pick(3, teamA, { status: 'keeper' }));
  const initial = buildDraftAdvisor(input);
  assert.deepEqual(initial.selectedTeam!.roster.players.map(player => player.id), [1, 3]);
  assert.ok(!initial.topAvailable.some(row => row.player.id === 3));
  input.board.revision = 2;
  input.board.picks[0] = { ...input.board.picks[0], playerId: 4, playerName: 'Player 4', currentOwnerId: teamB };
  input.board.picks[2] = { ...input.board.picks[2], status: 'available', playerId: null, playerName: null };
  const next = buildDraftAdvisor(input);
  assert.equal(next.revision, 2); assert.equal(next.selectedTeam!.roster.totalPlayers, 0);
  assert.deepEqual(next.teams[1].roster.players.map(player => player.id), [4, 2]);
  assert.deepEqual(next.topAvailable.slice(0, 2).map(row => row.player.id), [1, 3]);
});

test('does not reveal a supplied keeper until the board reveals keepers', () => {
  const input = fixture(); input.board.keepersRevealedAt = null; input.board.picks.push(pick(3, teamA, { status: 'keeper' }));
  const report = buildDraftAdvisor(input);
  assert.deepEqual(report.selectedTeam!.roster.players.map(player => player.id), [1]);
  assert.ok(report.warnings.some(warning => warning.includes('Unrevealed keepers')));
});

test('missing projections suppress incomplete team odds instead of silently counting absent stats as zero', () => {
  const input = fixture(); input.projections!.players = input.projections!.players.filter(player => player.id !== 1 && player.id !== 3);
  const report = buildDraftAdvisor(input);
  assert.deepEqual(report.selectedTeam!.coverage.missing, [{ id: 1, name: 'Player 1' }]);
  assert.equal(report.selectedTeam!.totals, null); assert.equal(report.selectedTeam!.categoryWinRate, null);
  assert.equal(report.categoryRecommendation, null); assert.equal(report.fitRecommendation, null);
  assert.equal(report.topAvailable[0].hasProjection, false);
  assert.ok(report.warnings.some(warning => warning.includes('excluded from opponent averages')));
});

test('an unknown opponent is excluded rather than predicted to lose every counting category', () => {
  const input = fixture(); input.projections!.players = input.projections!.players.filter(player => player.id !== 2);
  const report = buildDraftAdvisor(input);
  assert.equal(report.selectedTeam!.categoryWinRate, null);
  assert.ok(report.selectedTeam!.categories.every(category => category.opponentsCompared === 0));
  assert.equal(report.categoryRecommendation, null);
  assert.ok(report.warnings.some(warning => warning.includes('At least one non-empty opponent')));
});

test('zero shooting attempts make percentage odds and the aggregate rate unavailable', () => {
  const input = fixture(); projection(input, 1).stats = stats({ fgm: 0, fga: 0, three: 0 });
  const report = buildDraftAdvisor(input);
  assert.equal(report.selectedTeam!.categories.find(category => category.id === 19)!.winProbability, null);
  assert.equal(report.selectedTeam!.categoryWinRate, null);
});

test('centers are downranked separately from pure category value after three centers', () => {
  const input = fixture(7); input.board.picks.push(pick(3), pick(4));
  for (const id of [1, 3, 4, 5]) { const row = input.eligibility.players.find(player => player.id === id)!; row.eligibleSlots = [4, 11, 12, 13]; row.primaryPositionId = 5; }
  for (const id of [6, 7]) { const row = input.eligibility.players.find(player => player.id === id)!; row.eligibleSlots = [0, 11, 12, 13]; }
  const report = buildDraftAdvisor(input), center = report.topAvailable.find(row => row.player.id === 5)!, guard = report.topAvailable.find(row => row.player.id === 6)!;
  assert.equal(center.categoryWinRate, guard.categoryWinRate);
  assert.equal(center.fitAdjustment, -0.015);
  assert.equal(guard.fitAdjustment, 0.006);
  assert.equal(report.categoryRecommendation?.player.id, 5);
  assert.equal(report.fitRecommendation?.player.id, 6);
  assert.ok(center.reasons.some(reason => reason.includes('3 C-eligible')));
});

test('normal capacity and primary-position maxima block picks without counting IR capacity', () => {
  const input = fixture(4); input.settings = settings({ 0: 1, 13: 2 });
  const full = buildDraftAdvisor(input);
  assert.equal(full.categoryRecommendation, null); assert.equal(full.fitRecommendation, null);
  assert.ok(full.topAvailable.every(row => row.blocked));
  input.settings = settings({ 0: 1, 12: 5 });
  input.settings.primaryPositionLimits[0].maximum = 1;
  const limited = buildDraftAdvisor(input);
  assert.equal(limited.categoryRecommendation, null);
  assert.ok(limited.topAvailable[0].reasons.some(reason => reason.includes('primary-position maximum')));
});

test('actual schedule uses daily eligible active slots and distinguishes useful games from bench congestion', () => {
  const input = fixture(4); input.settings = settings({ 0: 1, 4: 1, 12: 3 });
  for (const id of [1, 2, 3]) { const row = input.eligibility.players.find(player => player.id === id)!; row.eligibleSlots = [4, 12]; row.primaryPositionId = 5; }
  input.eligibility.players[3].eligibleSlots = [0, 12]; input.catalog.players[3].nbaTeam = 'CHI';
  projection(input, 1).stats = stats({ pts: 40, reb: 15, ast: 8, blk: 4, stl: 3, fgm: 15, fga: 25, ftm: 8, fta: 10 });
  projection(input, 2).stats = { ...projection(input, 1).stats };
  projection(input, 3).stats = stats({ pts: 25, reb: 8, ast: 4, blk: 2, stl: 2 });
  projection(input, 4).stats = stats({ pts: 10, reb: 4, ast: 3, blk: 1, stl: 1 });
  input.schedule = { seasonId: 2027, fetchedAt: source.capturedAt, sourceLabel: 'Schedule fixture', startDate: '2026-10-19', endDate: '2026-10-25', warnings: [], games: [
    { date: '2026-10-21', team: 'ATL' }, { date: '2026-10-22', team: 'ATL' },
    { date: '2026-10-21', team: 'BOS' }, { date: '2026-10-22', team: 'BOS' },
    { date: '2026-10-23', team: 'CHI' }, { date: '2026-10-24', team: 'CHI' },
  ] };
  const report = buildDraftAdvisor(input), congested = report.topAvailable.find(row => row.player.id === 3)!, flexible = report.topAvailable.find(row => row.player.id === 4)!;
  assert.equal(report.scheduleMode, 'actual');
  assert.equal(report.categoryRecommendation?.player.id, 3);
  assert.equal(congested.scheduledGames, 2); assert.equal(congested.usableGames, 0);
  assert.equal(flexible.usableGames, 2);
  assert.ok(flexible.scheduleWinRate! > congested.scheduleWinRate!);
  assert.equal(report.fitRecommendation?.player.id, 4);
});

test('fallback schedule is labeled, missing imports remain usable, and wrong-season inputs are rejected', () => {
  const input = fixture(); const fallback = buildDraftAdvisor(input);
  assert.equal(fallback.scheduleMode, 'equal_games');
  assert.equal(fallback.selectedTeam!.scheduleWinRate, fallback.selectedTeam!.categoryWinRate);
  assert.ok(fallback.warnings.some(warning => warning.includes('cannot identify light-day')));
  assert.equal(fallback.topAvailable[0].scheduledGames, null);
  input.projections = null;
  const empty = buildDraftAdvisor(input);
  assert.equal(empty.available, true); assert.equal(empty.topAvailable.length, 15); assert.equal(empty.categoryRecommendation, null);
  input.projections = fixture().projections; input.projections!.seasonId = 2026;
  assert.equal(buildDraftAdvisor(input).available, false);
});

test('projected season games adjust expected availability while preserving attempt-weighted percentages', () => {
  const input = fixture(); projection(input, 1).games = 41;
  const report = buildDraftAdvisor(input);
  assert.equal(report.selectedTeam!.totals!.pts, 15 * 3.5 / 2);
  assert.equal(report.selectedTeam!.categories.find(category => category.id === 19)!.projectedValue, 0.5);
});

test('daily slot assignment reassigns a flexible incumbent so a single-position candidate can start', () => {
  const input = fixture(3); input.settings = settings({ 0: 1, 1: 1, 12: 2 });
  input.eligibility.players[0].eligibleSlots = [0, 1, 12];
  input.eligibility.players[2].eligibleSlots = [0, 12];
  projection(input, 1).stats = stats({ pts: 30, reb: 10, ast: 8 });
  input.schedule = { seasonId: 2027, fetchedAt: source.capturedAt, sourceLabel: 'Fixture', startDate: '2026-10-19', endDate: '2026-10-25', warnings: [], games: [{ date: '2026-10-21', team: 'ATL' }, { date: '2026-10-21', team: 'BOS' }] };
  const report = buildDraftAdvisor(input);
  assert.equal(report.topAvailable[0].scheduledGames, 1);
  assert.equal(report.topAvailable[0].usableGames, 1);
});

test('missing existing eligibility suppresses roster-fit scores while preserving known category projections', () => {
  const input = fixture(3); input.eligibility.players = input.eligibility.players.filter(player => player.id !== 1);
  const report = buildDraftAdvisor(input);
  assert.notEqual(report.selectedTeam!.categoryWinRate, null);
  assert.notEqual(report.categoryRecommendation, null);
  assert.equal(report.fitRecommendation, null);
  assert.ok(report.warnings.some(warning => warning.includes('position eligibility is missing')));
});

test('a wrong-season schedule falls back explicitly and unsupported categories fail closed', () => {
  const input = fixture(3);
  input.schedule = { seasonId: 2026, fetchedAt: source.capturedAt, sourceLabel: 'Wrong season', startDate: '2025-10-20', endDate: '2025-10-26', warnings: [], games: [{ date: '2025-10-21', team: 'ATL' }, { date: '2025-10-21', team: 'BOS' }] };
  const report = buildDraftAdvisor(input);
  assert.equal(report.scheduleMode, 'equal_games');
  assert.ok(report.warnings.some(warning => warning.includes('another season')));
  input.catalog.categories[0].id = 42;
  assert.equal(buildDraftAdvisor(input).available, false);
  assert.match(buildDraftAdvisor(input).unavailableReason!, /nine supported/);
});

test('zero projected games stay visible but cannot beat eligible players by adding no turnovers or shooting attempts', () => {
  const alone = fixture(3); projection(alone, 3).games = 0;
  const empty = buildDraftAdvisor(alone);
  assert.equal(empty.topAvailable[0].player.id, 3);
  assert.equal(empty.topAvailable[0].blocked, true);
  assert.ok(empty.topAvailable[0].reasons.some(reason => reason.includes('no games this season')));
  assert.equal(empty.categoryRecommendation, null);
  assert.equal(empty.fitRecommendation, null);
  assert.deepEqual(empty.fitRanking, []);

  const input = fixture(4); projection(input, 3).games = 0;
  projection(input, 4).stats = stats({ pts: 3, reb: 0, ast: 0, stl: 0, blk: 0, three: 0, tov: 20, fgm: 1, fga: 40, ftm: 1, fta: 40 });
  const report = buildDraftAdvisor(input);
  const active = report.topAvailable.find(row => row.player.id === 4)!;
  assert.ok(active.categoryWinRate! < report.selectedTeam!.categoryWinRate!);
  assert.equal(report.categoryRecommendation?.player.id, 4);
  assert.equal(report.fitRecommendation?.player.id, 4);
  assert.ok(report.fitRanking.every(row => row.player.id !== 3));
});

test('season odds average nonlinear weekly probabilities and expose matching weekly production and matchup categories', () => {
  const input = fixture(3);
  input.schedule = { scope: 'season', seasonId: 2027, fetchedAt: source.capturedAt, sourceLabel: 'Full-season fixture', startDate: '2026-10-20', endDate: '2026-10-28', warnings: [], games: [
    ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-27'].map(date => ({ date, team: 'ATL' as const })),
    ...['2026-10-20', '2026-10-27', '2026-10-28'].map(date => ({ date, team: 'BOS' as const })),
  ] };
  const full = buildDraftAdvisor(input);
  const weekly = [['2026-10-19', '2026-10-25'], ['2026-10-26', '2026-11-01']].map(([startDate, endDate]) => buildDraftAdvisor({ ...input,
    schedule: { ...input.schedule!, scope: 'week', startDate, endDate, games: input.schedule!.games.filter(game => game.date >= startDate && game.date <= endDate) },
  }));
  const expected = weekly.reduce((sum, report) => sum + report.selectedTeam!.scheduleWinRate!, 0) / 2;
  assert.ok(Math.abs(full.selectedTeam!.scheduleWinRate! - expected) < 1e-12);
  assert.equal(full.selectedTeam!.scheduleTotals!.pts, 15 * 5 / 2);
  assert.equal(full.selectedTeam!.totals!.pts, 15 * 3.5, 'equal-game category model is unchanged');
  for (const category of full.selectedTeam!.scheduleCategories) {
    const mean = weekly.reduce((sum, report) => sum + report.selectedTeam!.scheduleCategories.find(row => row.id === category.id)!.winProbability!, 0) / 2;
    assert.ok(Math.abs(category.winProbability! - mean) < 1e-12);
  }
  assert.equal(full.scheduleMatchups[0].categoryWinRate, expected);
  // Pooling 5 versus 3 season games into one comparison gives a different probability.
  const pooled = buildDraftAdvisor({ ...input, schedule: null,
    projections: { ...input.projections!, players: input.projections!.players.map(row => ({ ...row, stats: Object.fromEntries(Object.entries(row.stats).map(([key, value]) => [key, value * (row.id === 2 ? 3 : 5) / 3.5])) as DraftProjectionStats })) },
  });
  assert.ok(Math.abs(pooled.selectedTeam!.categoryWinRate! - expected) > 0.001);
  assert.equal(full.candidates[0].scheduledGames, 5); assert.equal(full.candidates[0].usableGames, 5);
});

test('later-season schedule changes the best pick beyond the opening week and missing NBA teams stay unavailable', () => {
  const input = fixture(4); input.catalog.players[2].nbaTeam = 'CHI'; input.catalog.players[3].nbaTeam = 'DEN';
  const games: NonNullable<DraftAdvisorInput['schedule']>['games'] = [];
  for (let week = 0; week < 3; week++) {
    for (const team of ['ATL', 'BOS', 'CHI', 'DEN'] as const) {
      const count = team === 'CHI' ? (week === 0 ? 4 : 1) : team === 'DEN' ? (week === 0 ? 1 : 4) : 2;
      for (let day = 0; day < count; day++) games.push({ team, date: new Date(Date.parse('2026-10-20T12:00:00Z') + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10) });
    }
  }
  input.schedule = { scope: 'season', seasonId: 2027, fetchedAt: source.capturedAt, sourceLabel: 'Fixture', startDate: '2026-10-20', endDate: '2026-11-06', warnings: [], games };
  const full = buildDraftAdvisor(input);
  const opening = buildDraftAdvisor({ ...input, schedule: { ...input.schedule, scope: 'week', startDate: '2026-10-19', endDate: '2026-10-25', games: games.filter(game => game.date <= '2026-10-25') } });
  assert.equal(opening.scheduleRecommendation?.player.id, 3);
  assert.equal(full.scheduleRecommendation?.player.id, 4);
  assert.equal(full.categoryRecommendation?.player.id, 3);
  assert.equal(full.candidates.find(row => row.player.id === 4)!.scheduledGames, 9);
  assert.equal(full.candidates.find(row => row.player.id === 4)!.usableGames, 9);
  const missing = buildDraftAdvisor({ ...input, schedule: { ...input.schedule, games: games.filter(game => game.team !== 'DEN') } });
  assert.equal(missing.candidates.find(row => row.player.id === 4)!.scheduleWinRate, null);
  assert.equal(missing.candidates.find(row => row.player.id === 4)!.scheduledGames, null);
  assert.equal(missing.scheduleRecommendation?.player.id, 3);
});
