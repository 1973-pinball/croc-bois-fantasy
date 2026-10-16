import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { draftForecastRequestKey, type DraftForecastRequestInput } from '../../src/lib/draft-forecast-request';

function fixture(): DraftForecastRequestInput {
  const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8'));
  return {
    catalog: artifact('draft-player-catalog'), settings: artifact('draft-roster-settings'), eligibility: artifact('draft-roster-eligibility'),
    franchiseId: 'team-a', projections: { source: 'espn', sourceLabel: 'ESPN', seasonId: 2027, importedAt: '2026-10-16T12:00:00Z', warnings: [],
      players: [{ id: 1, name: 'Player', games: 70, providerRank: 1, stats: { pts: 20, reb: 5, ast: 4, stl: 1, blk: 1, tov: 2, three: 2, fgm: 7, fga: 15, ftm: 4, fta: 5 } }],
    }, schedule: null, espnRanks: [{ id: 2, rank: 2 }, { id: 1, rank: 1 }],
    board: {
      seasonId: 'season', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13, revision: 1,
      keepersRevealedAt: '2026-10-15T12:00:00Z', orderComplete: true, orderLocked: true, nextPickId: 'pick-a',
      clock: { status: 'waiting', durationSeconds: 90, remainingSeconds: 90, deadlineAt: null, startedAt: null, serverNow: '2026-10-16T12:00:00Z' },
      teams: [{ franchiseId: 'team-a', espnTeamId: 1, displayName: 'Alpha', draftPosition: 1 }, { franchiseId: 'team-b', espnTeamId: 2, displayName: 'Beta', draftPosition: 2 }],
      picks: [{ id: 'pick-a', round: 1, overallPick: 1, originalFranchiseId: 'team-a', currentOwnerId: 'team-a', status: 'available', playerId: null, playerName: null, selectionId: null },
        { id: 'pick-b', round: 1, overallPick: 2, originalFranchiseId: 'team-b', currentOwnerId: 'team-b', status: 'available', playerId: null, playerName: null, selectionId: null }],
    },
  };
}

test('forecast requests ignore clock polling, clock revisions and collection order without mutating input', () => {
  const input = fixture(), before = structuredClone(input), key = draftForecastRequestKey(input, 'completed');
  const next = structuredClone(input);
  next.board.revision += 3; next.board.clock.serverNow = '2026-10-16T12:00:15Z'; next.board.clock.remainingSeconds = 75;
  next.board.clock.status = 'running'; next.board.clock.deadlineAt = '2026-10-16T12:01:30Z';
  next.board.teams.reverse(); next.board.picks.reverse(); next.espnRanks!.reverse();
  assert.equal(draftForecastRequestKey(next, 'completed'), key);
  assert.deepEqual(input, before);
});

test('forecast requests invalidate on picks, corrections, ownership, reveal, order, team, source and ranking changes', () => {
  const input = fixture(), key = draftForecastRequestKey(input, 'completed');
  const changes: ((value: DraftForecastRequestInput) => void)[] = [
    value => { value.board.picks[0].status = 'selected'; value.board.picks[0].playerId = 1; },
    value => { value.board.picks[0].playerId = 2; },
    value => { value.board.picks[0].currentOwnerId = 'team-b'; },
    value => { value.board.picks[0].rosterOwnerId = 'team-b'; },
    value => { value.board.keepersRevealedAt = null; },
    value => { value.board.teams[0].draftPosition = 2; },
    value => { value.franchiseId = 'team-b'; },
    value => { value.projections!.source = 'basketball-monster'; },
    value => { value.projections!.players[0].stats.pts += 1; },
    value => { value.projections!.players[0].games = 60; },
    value => { value.espnRanks![0].rank = 20; },
    value => { value.scenarios = 24; },
    value => { value.schedule = { seasonId: 2027, scope: 'season', startDate: '2026-10-20', endDate: '2027-04-14', games: [], sourceLabel: 'Changed schedule', fetchedAt: '2026-10-16T12:00:00Z', warnings: [] }; },
  ];
  for (const change of changes) {
    const next = structuredClone(input); change(next);
    assert.notEqual(draftForecastRequestKey(next, 'completed'), key);
  }
  assert.notEqual(draftForecastRequestKey(input, 'current'), key);
});
