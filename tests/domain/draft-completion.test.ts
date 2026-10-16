import assert from 'node:assert/strict';
import test from 'node:test';
import { completeDraftScenario, prepareDraftCompletion, type DraftCompletionInput } from '../../src/lib/draft-completion';
import type { DraftBoardPick } from '../../src/lib/draft-board';
import type { DraftRosterSettings } from '../../src/lib/espn-roster-settings';

const a = 'team-a', b = 'team-b';
const source = { sha256: 'a'.repeat(64), url: 'https://example.test/fixture', capturedAt: '2026-10-16T00:00:00.000Z' };
function fixture(rounds = 3, capacity = 3, count = 24): DraftCompletionInput {
  const slots: DraftRosterSettings['slots'] = [{ slotId: 11, label: 'UTIL', count: capacity, kind: 'normal' }, { slotId: 13, label: 'IR', count: 2, kind: 'reserve' }];
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const picks: DraftBoardPick[] = Array.from({ length: rounds * 2 }, (_, index) => {
    const overallPick = index + 1, round = Math.floor(index / 2) + 1, owner = round % 2 ? index % 2 ? b : a : index % 2 ? a : b;
    const playerId = index === rounds * 2 - 2 ? 10 : index === rounds * 2 - 1 ? 11 : null;
    return { id: `pick-${overallPick}`, overallPick, round, originalFranchiseId: owner, currentOwnerId: owner,
      status: playerId === null ? 'available' : 'keeper', playerId, playerName: playerId === null ? null : `Player ${playerId}`, selectionId: null };
  });
  return { franchiseId: a, scenarioCount: 12, seed: 42,
    board: { seasonId: 'season', draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: rounds, revision: 1,
      keepersRevealedAt: source.capturedAt, orderComplete: true, orderLocked: true, nextPickId: picks.find(pick => pick.status === 'available')?.id ?? null,
      clock: { status: 'waiting', durationSeconds: 90, remainingSeconds: 90, deadlineAt: null, startedAt: null, serverNow: source.capturedAt },
      teams: [{ franchiseId: a, espnTeamId: 1, displayName: 'A', draftPosition: 1 }, { franchiseId: b, espnTeamId: 2, displayName: 'B', draftPosition: 2 }], picks },
    settings: { version: 1, leagueId: 139935, espnSeasonId: 2027, source, slots, slotDefinitionsSource: source, positionLimitsSource: source,
      slotDefinitions: slots.map(slot => ({ slotId: slot.slotId, label: slot.label, name: slot.label, bench: false, reserve: slot.kind === 'reserve', lineupSlotEligible: true })),
      normalCapacity: capacity, reserveCapacity: 2, lineupSlotCounts: { 11: capacity, 13: 2 }, positionLimits: { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1 }, isBenchUnlimited: true,
      primaryPositionLimits: [1, 2, 3, 4, 5].map(positionId => ({ positionId, label: String(positionId), maximum: null })), limitations: [] },
    eligibility: { version: 1, leagueId: 139935, espnSeasonId: 2027, source,
      players: ids.map(id => ({ id, name: `Player ${id}`, eligibleSlots: [0, 5, 11, 12, 13], primaryPositionId: 1, injuryStatus: 'ACTIVE', active: true, poolStatus: 'FREEAGENT' })) },
    catalog: { version: 1, leagueId: 139935, espnSeasonId: 2027, fetchedAt: source.capturedAt, source,
      rankingSource: { field: 'ROTO', label: 'ESPN category rankings', rankType: 'ROTO', customLeagueWeighting: false, limitations: [] },
      categories: [0, 6, 3, 2, 1, 17, 11, 19, 20].map(id => ({ id, label: String(id), lowerIsBetter: id === 11 })),
      coverage: { players: count, ranked: count, unranked: 0, selectable: count, unsigned: 0 },
      players: ids.map(id => ({ id, name: `Player ${id}`, nbaTeam: id % 2 ? 'ATL' : 'BOS', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: id, rankSource: 'ROTO', active: true, selectable: true })) },
    projections: { source: 'basketball-monster', sourceLabel: 'BBM fixture', seasonId: 2027, importedAt: source.capturedAt, warnings: [],
      players: ids.map(id => ({ id, name: `Player ${id}`, games: 70, stats: { pts: 15, reb: 5, ast: 3, stl: 1, blk: 1, tov: 2, three: 1, fgm: 5, fga: 10, ftm: 4, fta: 5 } })) } };
}
const selected = (input: DraftCompletionInput, overall: number, playerId: number, rosterOwnerId?: string) => {
  Object.assign(input.board.picks[overall - 1], { status: 'selected', playerId, playerName: `Player ${playerId}`, selectionId: `selection-${overall}`, ...(rosterOwnerId ? { rosterOwnerId } : {}) });
  input.board.nextPickId = input.board.picks.find(pick => pick.status === 'available')?.id ?? null;
};

test('finishes the actual snake pick inventory, preserves keepers, and changes no input data', () => {
  const input = fixture(), before = structuredClone(input), context = prepareDraftCompletion(input);
  assert.equal(context.available, true); assert.equal(context.targetPick?.overallPick, 1);
  const result = completeDraftScenario(context, 0);
  assert.equal(result.valid, true);
  assert.deepEqual(result.picks.map(pick => [pick.overallPick, pick.franchiseId, pick.playerId]), [[1, a, 1], [2, b, 2], [3, b, 3], [4, a, 4]]);
  assert.deepEqual(result.teams.get(a), [1, 4, 10]); assert.deepEqual(result.teams.get(b), [2, 3, 11]);
  assert.deepEqual(result.additions, []); assert.deepEqual(result.cuts, []);
  assert.deepEqual(input, before);
});

test('traded picks create hypothetical cuts and free-agent additions without reusing cut players or adding IR capacity', () => {
  const input = fixture(); input.board.picks[3].currentOwnerId = b;
  const result = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.equal(result.valid, true);
  assert.deepEqual(result.cuts, [{ franchiseId: b, playerId: 11, wasFixed: true, reason: 'roster_capacity' }]);
  assert.deepEqual(result.additions, [{ franchiseId: a, playerId: 5, reason: 'roster_shortfall' }]);
  assert.deepEqual(result.teams.get(a), [1, 10, 5]); assert.deepEqual(result.teams.get(b), [2, 3, 4]);
  const all = [...result.teams.values()].flat(); assert.equal(new Set(all).size, all.length); assert.ok(!all.includes(11));
  assert.ok([...result.teams.values()].every(players => players.length === input.settings.normalCapacity));
});

test('fixed roster ownership follows player trades while future selections follow current pick ownership', () => {
  const input = fixture(); selected(input, 1, 12, b); input.board.picks[4].rosterOwnerId = b;
  const result = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.equal(result.valid, true);
  assert.deepEqual(result.teams.get(b), [1, 2, 10]);
  assert.ok(!result.teams.get(a)!.includes(10)); assert.ok(!result.teams.get(a)!.includes(12));
  assert.deepEqual(result.cuts.map(cut => [cut.franchiseId, cut.playerId, cut.wasFixed]), [[b, 11, true], [b, 12, true]]);
});

test('candidate availability is tested after prior opponents pick and the baseline branch uses the same market order', () => {
  const input = fixture(); input.franchiseId = b;
  const context = prepareDraftCompletion(input), baseline = completeDraftScenario(context, 0);
  assert.equal(context.targetPick?.overallPick, 2);
  const gone = completeDraftScenario(context, 0, 1);
  assert.equal(gone.available, false); assert.equal(gone.valid, false); assert.match(gone.reason!, /before your next owned pick/);
  assert.deepEqual(completeDraftScenario(context, 0, 2).teams, baseline.teams);
  const branch = completeDraftScenario(context, 0, 4);
  assert.equal(branch.valid, true); assert.equal(branch.available, true); assert.equal(branch.forcedCandidateRetained, true);
  assert.deepEqual(branch.picks[0], baseline.picks[0]);
  assert.equal(branch.picks[1].playerId, 4);
  assert.deepEqual(branch.picks.filter(pick => pick.playerId !== 4).map(pick => pick.playerId), baseline.picks.filter(pick => pick.playerId !== 4).map(pick => pick.playerId));
  assert.equal(completeDraftScenario(context, 0, 10).available, false);
});

test('seeded scenarios are reproducible, differ across seeds, and cannot be corrupted through returned maps', () => {
  const input = fixture(5, 5); input.rankJitter = 0.5;
  const context = prepareDraftCompletion(input), repeated = prepareDraftCompletion(structuredClone(input));
  const traces = Array.from({ length: context.scenarioCount }, (_, index) => completeDraftScenario(context, index));
  assert.ok(traces.every(result => result.valid));
  assert.deepEqual(traces, traces.map((_, index) => completeDraftScenario(repeated, index)));
  assert.ok(new Set(traces.map(result => JSON.stringify(result.picks))).size > 1);
  const changed = prepareDraftCompletion({ ...input, seed: 4312 });
  assert.notDeepEqual(traces.slice(1).map(result => result.picks), traces.slice(1).map((_, index) => completeDraftScenario(changed, index + 1).picks));
  traces[0].teams.get(a)!.push(999); traces[0].picks[0].playerId = 999;
  assert.ok(!completeDraftScenario(context, 0).teams.get(a)!.includes(999));
  assert.notEqual(completeDraftScenario(context, 0).picks[0].playerId, 999);
});

test('neighbor scenarios cover alternating available-pick boundaries once, excluding fixed keepers', () => {
  const input = fixture(4, 4); input.franchiseId = b;
  input.board.picks[6].playerId = 2; input.board.picks[7].playerId = 6;
  const context = prepareDraftCompletion(input);
  const traces = [0, 1, 2].map(index => completeDraftScenario(context, index));
  assert.ok(traces.every(result => result.valid));
  assert.deepEqual(traces.map(result => result.picks.map(pick => pick.playerId)), [
    [1, 3, 4, 5, 7, 8], [3, 1, 5, 4, 8, 7], [1, 4, 3, 7, 5, 9],
  ]);
  assert.equal(completeDraftScenario(context, 0, 1).available, false);
  assert.equal(completeDraftScenario(context, 1, 1).available, true);
  assert.equal(completeDraftScenario(context, 1, 3).available, false);
  for (const index of [1, 2]) {
    const baseline = traces[index], next = baseline.picks[1].playerId;
    assert.deepEqual(completeDraftScenario(context, index, next).teams, baseline.teams);
    const changedSeed = prepareDraftCompletion({ ...input, seed: 999, rankJitter: 0 });
    assert.deepEqual(completeDraftScenario(changedSeed, index), baseline);
  }
  assert.match(context.warnings.join(' '), /neighboring available-player swaps/);
  assert.match(context.warnings.join(' '), /not calibrated draft odds/);
});

test('neighbor scenarios keep unranked players last and use the same market order for hypothetical cuts', () => {
  const input = fixture(3, 1);
  input.catalog.players.filter(player => player.id >= 4 && player.id !== 10 && player.id !== 11).forEach(player => { player.rank = null; });
  const context = prepareDraftCompletion(input), result = completeDraftScenario(context, 1);
  assert.equal(result.valid, true);
  assert.deepEqual(result.picks.map(pick => pick.playerId), [2, 1, 3, 12]);
  assert.deepEqual(result.teams.get(a), [2]); assert.deepEqual(result.teams.get(b), [1]);
  assert.ok(result.cuts.some(cut => cut.playerId === 12));
  assert.ok(!result.cuts.some(cut => cut.playerId === 1 || cut.playerId === 2));
});

test('newer supplied ESPN market ranks override catalog order while unranked players remain last', () => {
  const input = fixture(); input.espnRanks = new Map([[5, 1], [1, 100]]);
  input.catalog.players.find(player => player.id === 6)!.rank = null;
  const result = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.deepEqual(result.picks.map(pick => pick.playerId), [5, 2, 3, 4]);
});

test('all fixed players require valid source projections, schedule teams and normal eligibility', () => {
  const mutations: ((input: DraftCompletionInput) => void)[] = [
    input => { input.projections!.players = input.projections!.players.filter(player => player.id !== 10); },
    input => { input.eligibility.players.find(player => player.id === 10)!.eligibleSlots = [13]; },
    input => { input.catalog.players.find(player => player.id === 10)!.nbaTeam = 'FA'; },
    input => { input.scheduledTeams = new Set(['ATL']); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.equal(prepareDraftCompletion(input).available, false); }
  const input = fixture(); input.scheduledTeams = new Set(['ATL', 'BOS']);
  assert.equal(prepareDraftCompletion(input).available, true);
});

test('missing, zero-game and unknown-game future players are omitted explicitly without mixing providers', () => {
  const input = fixture(); input.projections!.players = input.projections!.players.filter(player => player.id !== 1);
  input.projections!.players.find(player => player.id === 2)!.games = 0;
  input.projections!.players.find(player => player.id === 3)!.games = null;
  const context = prepareDraftCompletion(input), result = completeDraftScenario(context, 0);
  assert.equal(context.available, true); assert.match(context.warnings.join(' '), /3 available players lack/);
  assert.ok(!context.candidateIds.some(id => [1, 2, 3].includes(id)));
  assert.equal(result.picks[0].playerId, 4); assert.equal(completeDraftScenario(context, 0, 1).available, false);
});

test('a future pick can be trimmed for primary-position limits and replaced with an eligible free agent', () => {
  const input = fixture(); input.settings.primaryPositionLimits[0].maximum = 2;
  input.eligibility.players.filter(player => player.id >= 5 && player.id !== 10 && player.id !== 11).forEach(player => { player.primaryPositionId = 5; player.eligibleSlots = [4, 11, 12, 13]; });
  const result = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.equal(result.valid, true); assert.equal(result.cuts.length, 2);
  assert.ok(result.cuts.every(cut => cut.reason === 'position_limit'));
  assert.deepEqual(result.additions.map(addition => addition.playerId), [5, 6]);
});

test('existing surplus players receive explicit hypothetical cuts without changing the recorded board', () => {
  const oversized = fixture(); selected(oversized, 1, 12, b); selected(oversized, 2, 13, b); selected(oversized, 3, 14, b);
  const before = structuredClone(oversized), result = completeDraftScenario(prepareDraftCompletion(oversized), 0);
  assert.equal(result.valid, true);
  assert.deepEqual(result.cuts, [{ franchiseId: b, playerId: 14, wasFixed: true, reason: 'roster_capacity' }]);
  assert.ok(!result.teams.get(b)!.includes(14)); assert.deepEqual(oversized, before);
  selected(oversized, 4, 15, b);
  const finished = prepareDraftCompletion(oversized), afterDraft = completeDraftScenario(finished, 0);
  assert.equal(finished.targetPick, null); assert.equal(afterDraft.valid, true);
  assert.deepEqual(afterDraft.picks, []);
  assert.deepEqual(afterDraft.cuts.map(cut => [cut.playerId, cut.wasFixed]), [[14, true], [15, true]]);
  assert.equal(afterDraft.additions.length, 2);
});

test('depleted free-agent pools cannot return a valid partial roster', () => {
  const depleted = fixture(2, 8, 12);
  const result = completeDraftScenario(prepareDraftCompletion(depleted), 0);
  assert.equal(result.available, true); assert.equal(result.valid, false); assert.match(result.reason!, /cannot fill every normal roster/);
});

test('unlimited bench allows congested positions within normal capacity; finite bench honors actual slot limits', () => {
  const input = fixture(4, 4);
  input.settings.slots = [0, 4, 11, 12, 13].map(slotId => ({ slotId, label: String(slotId), count: slotId === 13 ? 2 : 1, kind: slotId === 13 ? 'reserve' : 'normal' }));
  input.settings.slotDefinitions = input.settings.slots.map(slot => ({ slotId: slot.slotId, label: slot.label, name: slot.label, bench: slot.slotId === 12, reserve: slot.kind === 'reserve', lineupSlotEligible: true }));
  for (const id of [20, 21]) { const player = input.eligibility.players.find(player => player.id === id)!; player.primaryPositionId = 5; player.eligibleSlots = [4, 11, 12, 13]; }
  const unlimited = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.equal(unlimited.valid, true); assert.deepEqual(unlimited.cuts, []); assert.deepEqual(unlimited.additions, []);
  assert.ok([...unlimited.teams.values()].every(ids => ids.length === 4));
  input.settings.isBenchUnlimited = false;
  const finite = completeDraftScenario(prepareDraftCompletion(input), 0);
  assert.equal(finite.valid, true); assert.equal(finite.cuts.length, 2);
  assert.ok(finite.cuts.every(cut => cut.reason === 'slot_eligibility'));
  assert.deepEqual(finite.additions.map(addition => addition.playerId), [20, 21]);
});

test('incomplete order, unrevealed keepers, duplicate identities, wrong seasons and invalid options fail closed', () => {
  const mutations: ((input: DraftCompletionInput) => void)[] = [
    input => { input.board.keepersRevealedAt = null; }, input => { input.board.orderComplete = false; },
    input => { input.board.picks.pop(); }, input => { input.board.picks[0].overallPick = 2; },
    input => { input.board.picks[0].currentOwnerId = 'unknown'; }, input => { input.board.picks[5].playerId = 10; },
    input => { input.board.nextPickId = input.board.picks[1].id; }, input => { input.catalog.espnSeasonId = 2026; },
    input => { input.projections!.seasonId = 2026; }, input => { input.projections!.players.push(input.projections!.players[0]); },
    input => { input.scenarioCount = 17; }, input => { input.scenarioCount = 0; }, input => { input.rankJitter = 1; },
    input => { input.settings.slots[1].kind = 'normal'; input.settings.normalCapacity += 2; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.equal(prepareDraftCompletion(input).available, false); }
  const context = prepareDraftCompletion(fixture()); assert.equal(completeDraftScenario(context, 12).valid, false);
});

test('a team with no remaining picks still receives a completed baseline but cannot force an extra draft choice', () => {
  const input = fixture(); input.board.picks.filter(pick => pick.status === 'available').forEach(pick => { pick.currentOwnerId = b; });
  const context = prepareDraftCompletion(input), result = completeDraftScenario(context, 0);
  assert.equal(context.available, true); assert.equal(context.targetPick, null); assert.deepEqual(context.candidateIds, []);
  assert.equal(result.valid, true); assert.equal(result.teams.get(a)!.length, 3);
  assert.equal(completeDraftScenario(context, 0, 1).available, false);
});
