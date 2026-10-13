import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareAiOwners } from '../../src/lib/ai-owner-comparison';
import type { AiLeagueResponse, AiLeagueRun } from '../../src/lib/ai-league-types';
import type { AiOwnerSnapshot } from '../../src/lib/ai-owner-types';
import type { LeagueData } from '../../src/lib/types';

const saved = JSON.parse(readFileSync(new URL('../../data/ai-league.json', import.meta.url), 'utf8')) as AiLeagueResponse;
const league = JSON.parse(readFileSync(new URL('../../data/league.json', import.meta.url), 'utf8')) as LeagueData;
const historical = () => structuredClone(saved.runs.find(run => run.season === 2026)!);
const upcoming = () => structuredClone(saved.runs.find(run => run.season === 2027)!);
function withoutSnapshot(): AiLeagueRun {
  const run = historical();
  delete run.actual;
  return run;
}
function onePeriodOwner(run: AiLeagueRun): AiOwnerSnapshot {
  const actual = structuredClone(run.actual!);
  actual.categories!.completedMatchupPeriods = [1];
  for (const team of actual.categories!.teams) {
    team.matchups = 1;
    team.standingsMatch = null;
    for (const category of team.categories) { category.wins = 0; category.losses = 0; category.ties = 1; }
  }
  // Retain later-period counters to ensure unfinished owner weeks are excluded independently.
  return actual;
}

test('saved owner evidence yields all eight rows and verified descriptive headlines without mutating inputs', () => {
  const run = historical(), current = structuredClone(league);
  const before = structuredClone(run), beforeLeague = structuredClone(current);
  const result = compareAiOwners(run, current);
  assert.deepEqual(run, before);
  assert.deepEqual(current, beforeLeague);
  assert.equal(result.teams.length, 8);
  assert.equal(result.completedPeriods, 18);
  assert.deepEqual(result.headline.biggestGain, { teamId: '3', teamName: 'Antiques Roadshow', delta: 21 });
  assert.deepEqual(result.headline.biggestDecrease, { teamId: '5', teamName: 'Paramaribo Potoos', delta: -19 });
  const antiques = result.teams.find(team => team.teamId === '3')!;
  assert.equal(antiques.categories!.owner.wins, 62);
  assert.equal(antiques.categories!.ai.wins, 83);
  assert.equal(antiques.categories!.rows.length, 9);
  assert.equal(antiques.categories!.biggestSwings.length, 3);
  assert.match(result.limitations.join(' '), /do not isolate|different starting conditions/);
});

test('historical archive fallback uses draft year and historical manager instead of a current replacement', () => {
  const run = withoutSnapshot(), current = structuredClone(league);
  current.teams.find(team => team.id === 4)!.owner = 'A future manager';
  current.teams.find(team => team.id === 4)!.managers = ['A future manager'];
  const result = compareAiOwners(run, current);
  const team = result.teams.find(row => row.teamId === '4')!;
  assert.equal(team.historicalOwner, 'Julian');
  assert.equal(team.draft.source, 'archive');
  assert.equal(result.draftYear, 2025);
  assert.equal(result.categoriesAvailable, true);
  assert.equal(result.acquisitionsAvailable, false);
  assert.ok(result.teams.every(row => row.acquisitions === null));
});

test('different traded-pick totals do not inflate the number of AI selections absent from the owner draft', () => {
  const team = compareAiOwners(historical(), league).teams.find(row => row.teamId === '1')!;
  assert.equal(team.draft.aiPicks, 13);
  assert.equal(team.draft.ownerPicks, 14);
  assert.equal(team.draft.sharedCount, 2);
  assert.equal(team.draft.aiOnly.length, 11);
  assert.equal(team.draft.ownerOnly.length, 12);
  assert.equal(team.draft.departureCount, 11);
  for (const list of [team.draft.shared, team.draft.aiOnly, team.draft.ownerOnly]) {
    assert.deepEqual(list.map(pick => pick.overallPick), list.map(pick => pick.overallPick).sort((a, b) => a - b));
  }
});

test('snapshot player IDs take precedence over names and preserve keeper annotations', () => {
  const run = historical();
  const selected = run.actual!.draft!.find(pick => pick.teamId === '1' && pick.playerId === 4433136)!;
  selected.name = 'An updated display name';
  selected.keeper = true;
  const team = compareAiOwners(run, league).teams.find(row => row.teamId === '1')!;
  assert.equal(team.draft.source, 'snapshot');
  const matched = team.draft.shared.find(pick => pick.playerId === selected.playerId)!;
  assert.equal(matched.keeper, true);
  assert.equal(matched.ownerPick, selected.overallPick);
});

test('accent, punctuation and unique suffix differences match conservatively', () => {
  for (const name of ['Wálker Kessler.', 'Walker Kessler Jr.']) {
    const run = withoutSnapshot();
    for (const player of [...run.players, ...run.initialPlayers!]) if (player.id === 4433136) player.name = name;
    const team = compareAiOwners(run, league).teams.find(row => row.teamId === '1')!;
    assert.ok(team.draft.shared.some(pick => pick.playerId === 4433136));
    assert.equal(team.draft.complete, true);
  }
});

test('ambiguous suffix identities and near-spellings suppress absence claims instead of fuzzy matching', () => {
  for (const ambiguous of [true, false]) {
    const run = withoutSnapshot();
    for (const player of [...run.players, ...run.initialPlayers!]) if (player.id === 4433136) player.name = ambiguous ? 'Walker Kessler Jr.' : 'Walkerr Kessler';
    if (ambiguous) run.players.push({ ...structuredClone(run.players.find(player => player.id === 4433136)!), id: 99999999, name: 'Walker Kessler III' });
    const result = compareAiOwners(run, league), team = result.teams.find(row => row.teamId === '1')!;
    assert.equal(team.draft.shared.some(pick => pick.playerId === 4433136), false);
    assert.equal(team.draft.complete, false);
    assert.equal(team.draft.departureCount, null);
    assert.deepEqual(team.draft.aiOnly, []);
    assert.match(result.limitations.join(' '), /could not be uniquely matched/);
  }
});

test('full owner season totals are withheld when any matching AI period is unfinished', () => {
  const run = historical();
  run.results.find(result => result.period === 18 && !result.playoff)!.complete = false;
  const result = compareAiOwners(run, league);
  assert.equal(result.categoriesAvailable, false);
  assert.deepEqual(result.periods, []);
  assert.ok(result.teams.every(team => team.categories === null));
  assert.equal(result.headline.biggestGain, null);
  assert.equal(result.headline.biggestDecrease, null);
  assert.match(result.limitations.join(' '), /partial-season versus full-season/);
});

test('a valid shorter owner snapshot is compared against exactly those AI periods, excluding playoffs', () => {
  const run = historical();
  run.actual = onePeriodOwner(run);
  const result = compareAiOwners(run, league);
  assert.deepEqual(result.periods, [1]);
  assert.equal(result.completedPeriods, 1);
  for (const team of result.teams) {
    const first = run.results.find(row => row.period === 1 && (row.home === team.teamId || row.away === team.teamId))!;
    assert.equal(team.categories!.ai.wins, first.home === team.teamId ? first.homeWins : first.awayWins);
    assert.equal(team.categories!.owner.ties, 9);
    assert.equal(team.categories!.ai.wins + team.categories!.ai.losses + team.categories!.ai.ties, 9);
    assert.deepEqual(team.acquisitions!.periods, [1]);
  }
});

test('unreconciled snapshot categories cannot override the verified historical fallback', () => {
  const run = historical();
  run.actual = onePeriodOwner(run);
  run.actual.categories!.teams[0].standingsMatch = false;
  const result = compareAiOwners(run, league);
  assert.equal(result.completedPeriods, 18);
  assert.equal(result.teams.find(team => team.teamId === '3')!.categories!.winsDelta, 21);
});

test('activity is counted from dated AI moves for matching regular periods, not cached counters or playoffs', () => {
  const run = historical();
  run.acquisitions = { '1:1': 999999 };
  const result = compareAiOwners(run, league);
  assert.equal(result.acquisitionsAvailable, true);
  assert.equal(result.teams.reduce((sum, team) => sum + team.acquisitions!.ai, 0), 576);
  assert.equal(run.decisions.filter(decision => decision.kind === 'add_drop').length, 600);
  assert.equal(result.teams.find(team => team.teamId === '4')!.acquisitions!.owner, 4);
  assert.deepEqual(result.headline.biggestAcquisitionGap, { teamId: '4', teamName: 'Luka Deez Nuts', delta: 68 });
  for (const team of run.actual!.acquisitions!) delete team.byPeriod['1'];
  const partial = compareAiOwners(run, league);
  assert.deepEqual(partial.teams[0].acquisitions!.periods, Array.from({ length: 17 }, (_, index) => index + 2));
  run.actual!.acquisitions![0].byPeriod = {};
  const unavailable = compareAiOwners(run, league);
  assert.equal(unavailable.acquisitionsAvailable, false);
  assert.ok(unavailable.teams.every(team => team.acquisitions === null));
});

test('upcoming and partially recorded owner drafts leave missing differences and activity pending', () => {
  const run = upcoming();
  const absent = compareAiOwners(run, league);
  assert.equal(absent.draftAvailable, false);
  assert.equal(absent.categoriesAvailable, false);
  assert.equal(absent.acquisitionsAvailable, false);
  const aiFirst = run.decisions.find(decision => decision.kind === 'draft')!;
  const player = run.players.find(player => player.id === aiFirst.playerIds[0])!;
  run.actual!.draft = [{ teamId: aiFirst.teamId, playerId: player.id, name: player.name, overallPick: 1, keeper: false }];
  run.actual!.draftComplete = false;
  const partial = compareAiOwners(run, league);
  assert.equal(partial.draftAvailable, true);
  assert.ok(partial.teams.every(team => !team.draft.complete && team.draft.departureCount === null && !team.draft.aiOnly.length));
  assert.equal(partial.headline.biggestDraftDeparture, null);
});
