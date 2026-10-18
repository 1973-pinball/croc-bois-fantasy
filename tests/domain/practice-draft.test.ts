import test from 'node:test';
import assert from 'node:assert/strict';
import { createPracticeDraft, updatePracticeDraft, canUsePracticeDraft, type PracticeDraftAccess } from '../../src/lib/practice-draft';
import { draftBoardSchema, type DraftBoard } from '../../src/lib/draft-board';
import type { DraftCatalogPlayer } from '../../src/lib/draft-player-catalog';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = Date.parse('2026-10-18T18:00:00Z');
const access: PracticeDraftAccess = { userId: id(50), commissioner: true, seasonId: id(1), connection: 'live' };
const players: DraftCatalogPlayer[] = [1, 2, 3, 4, 5, 6].map(n => ({ id: n, name: `Player ${n}`, nbaTeam: 'BOS', primaryPosition: 'PG', eligiblePositions: ['PG'], rank: n === 5 ? null : n === 4 ? 1 : n, rankSource: 'ROTO', active: true, selectable: n !== 6 }));
function fixture(): DraftBoard {
  return draftBoardSchema.parse({ seasonId: id(1), draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 3, revision: 7,
    keepersRevealedAt: new Date(time - 1000).toISOString(), orderComplete: true, orderLocked: true, nextPickId: id(11),
    clock: { status: 'paused', durationSeconds: 90, remainingSeconds: 35, startedAt: new Date(time - 5000).toISOString(), deadlineAt: null, serverNow: new Date(time).toISOString() },
    teams: [{ franchiseId: id(2), espnTeamId: 1, displayName: 'Team A', draftPosition: 1 }, { franchiseId: id(3), espnTeamId: 2, displayName: 'Team B', draftPosition: 2 }],
    picks: Array.from({ length: 6 }, (_, index) => ({ id: id(11 + index), round: Math.floor(index / 2) + 1, overallPick: index + 1,
      originalFranchiseId: id(index % 2 ? 3 : 2), currentOwnerId: id(3),
      status: index === 1 ? 'selected' : index === 2 ? 'keeper' : 'available',
      playerId: index === 1 ? 2 : index === 2 ? 1 : null, playerName: index === 1 ? 'Player 2' : index === 2 ? 'Player 1' : null,
      selectionId: index === 1 ? id(60) : null, rosterOwnerId: index === 2 ? id(2) : index === 1 ? id(3) : null })) });
}

test('only the current commissioner can open practice from a ready snapshot for their season', () => {
  for (const invalid of [{ ...access, userId: undefined }, { ...access, commissioner: false }, { ...access, connection: 'preview' }, { ...access, seasonId: '' }]) {
    assert.equal(canUsePracticeDraft(invalid), false);
    assert.throws(() => createPracticeDraft(fixture(), invalid, time), /Commissioner access/);
  }
  assert.throws(() => createPracticeDraft(fixture(), { ...access, seasonId: id(99) }, time), /another season/);
  assert.throws(() => createPracticeDraft({ ...fixture(), keepersRevealedAt: null }, access, time), /revealed keepers/);
  assert.throws(() => createPracticeDraft({ ...fixture(), orderComplete: false }, access, time), /published draft order/);
  const state = createPracticeDraft(fixture(), access, time);
  assert.equal(state.board.clock.status, 'waiting');
  assert.equal(state.board.clock.startedAt, null);
  assert.notEqual(state.board, state.baseline);
});

test('pretend selections follow current traded owners, skip keeper and real selections, and never modify the source', () => {
  const liveBoard = fixture(); const original = structuredClone(liveBoard);
  let state = createPracticeDraft(liveBoard, access, time);
  assert.throws(() => updatePracticeDraft(state, { type: 'pick', playerId: 3, pickId: id(11) }, access, players, time), /Start or resume/);
  state = updatePracticeDraft(state, { type: 'start' }, access, players, time);
  for (const playerId of [1, 2, 6, 999]) assert.throws(() => updatePracticeDraft(state, { type: 'pick', playerId, pickId: id(11) }, access, players, time + 1000), /available player/);
  state = updatePracticeDraft(state, { type: 'pick', playerId: 3, pickId: id(11) }, access, players, time + 1000);
  assert.equal(state.board.picks[0].playerId, 3);
  assert.equal(state.board.picks[0].rosterOwnerId, id(3));
  assert.equal(state.board.nextPickId, id(14));
  assert.throws(() => updatePracticeDraft(state, { type: 'pick', playerId: 4, pickId: id(11) }, access, players, time + 2000), /turn changed/);
  assert.throws(() => updatePracticeDraft(state, { type: 'pick', playerId: 3, pickId: id(14) }, access, players, time + 2000), /available player/);
  assert.deepEqual(liveBoard, original);
  assert.deepEqual(state.baseline, original);
  assert.deepEqual(state.board.picks.slice(1, 3), original.picks.slice(1, 3));
  assert.equal(draftBoardSchema.safeParse(state.board).success, true);
});

test('reset restores the exact starting pick inventory, real selections, keepers, ownership, order, and timer', () => {
  const liveBoard = fixture(); const original = structuredClone(liveBoard);
  let state = createPracticeDraft(liveBoard, access, time);
  state = updatePracticeDraft(state, { type: 'configure', seconds: 10 }, access, players, time);
  state = updatePracticeDraft(state, { type: 'start' }, access, players, time);
  state = updatePracticeDraft(state, { type: 'pick', playerId: 3, pickId: id(11) }, access, players, time + 1000);
  state = updatePracticeDraft(state, { type: 'tick' }, access, players, time + 12000);
  assert.equal(state.practicePickIds.length, 2);
  state = updatePracticeDraft(state, { type: 'reset' }, access, players, time + 13000);
  assert.deepEqual(state.board.picks, original.picks);
  assert.deepEqual(state.board.teams, original.teams);
  assert.deepEqual(state.baseline, original);
  assert.equal(state.board.clock.status, 'waiting');
  assert.equal(state.board.clock.startedAt, null);
  assert.equal(state.board.clock.deadlineAt, null);
  assert.equal(state.board.clock.durationSeconds, 90);
  assert.equal(state.board.clock.remainingSeconds, 90);
  assert.equal(state.board.nextPickId, id(11));
  assert.deepEqual(state.practicePickIds, []);
  assert.equal(state.board.revision, original.revision);
  assert.deepEqual(liveBoard, original);
});

test('practice pause and resume preserve time; expiration takes one ranked player and never catches up multiple turns', () => {
  let state = updatePracticeDraft(createPracticeDraft(fixture(), access, time), { type: 'start' }, access, players, time);
  state = updatePracticeDraft(state, { type: 'pause' }, access, players, time + 10000);
  assert.equal(state.board.clock.remainingSeconds, 80);
  assert.equal(updatePracticeDraft(state, { type: 'tick' }, access, players, time + 900000), state);
  state = updatePracticeDraft(state, { type: 'resume' }, access, players, time + 1000000);
  assert.equal(Date.parse(state.board.clock.deadlineAt!), time + 1080000);
  state = updatePracticeDraft(state, { type: 'tick' }, access, players, time + 2000000);
  assert.equal(state.practicePickIds.length, 1);
  assert.equal(state.board.picks[0].playerId, 4);
  assert.equal(Date.parse(state.board.clock.deadlineAt!), time + 2090000);
  assert.equal(updatePracticeDraft(state, { type: 'tick' }, access, players, time + 2000000), state);
});

test('a late manual selection cannot overtake expiration; undo removes only practice picks and leaves the clock paused', () => {
  let state = updatePracticeDraft(createPracticeDraft(fixture(), access, time), { type: 'start' }, access, players, time);
  assert.throws(() => updatePracticeDraft(state, { type: 'undo' }, access, players, time), /no pretend pick/);
  state = updatePracticeDraft(state, { type: 'pick', playerId: 3, pickId: id(11) }, access, players, time + 90000);
  assert.equal(state.board.picks[0].playerId, 4);
  assert.equal(state.practicePickIds.length, 1);
  state = updatePracticeDraft(state, { type: 'undo' }, access, players, time + 91000);
  assert.deepEqual(state.board.picks, state.baseline.picks);
  assert.equal(state.board.clock.status, 'paused');
  assert.deepEqual(state.practicePickIds, []);
});

test('practice state cannot transfer between accounts or seasons and separately opened copies are isolated', () => {
  const first = createPracticeDraft(fixture(), access, time);
  const second = createPracticeDraft(fixture(), access, time);
  for (const changed of [{ ...access, userId: id(51) }, { ...access, commissioner: false }, { ...access, seasonId: id(99) }, { ...access, connection: 'offline' }]) {
    assert.throws(() => updatePracticeDraft(first, { type: 'start' }, changed, players, time), /commissioner account/);
    assert.throws(() => updatePracticeDraft(first, { type: 'reset' }, changed, players, time), /commissioner account/);
  }
  const started = updatePracticeDraft(first, { type: 'start' }, access, players, time);
  const selected = updatePracticeDraft(started, { type: 'pick', playerId: 3, pickId: id(11) }, access, players, time + 1000);
  assert.equal(selected.board.picks[0].playerId, 3);
  assert.equal(first.board.picks[0].playerId, null);
  assert.equal(second.board.picks[0].playerId, null);
  assert.equal(second.board.clock.status, 'waiting');
});

test('a completed practice stops the timer and can reset without removing existing official picks', () => {
  const pool = [...players, { ...players[2], id: 7, name: 'Extra available player', rank: 7 }];
  let state = updatePracticeDraft(createPracticeDraft(fixture(), access, time), { type: 'start' }, access, pool, time);
  for (const [index, playerId] of [3, 4, 5, 7].entries()) {
    state = updatePracticeDraft(state, { type: 'pick', playerId, pickId: state.board.nextPickId! }, access, pool, time + (index + 1) * 1000);
  }
  assert.equal(state.board.clock.status, 'completed');
  assert.equal(state.board.clock.deadlineAt, null);
  assert.equal(state.board.nextPickId, null);
  assert.equal(updatePracticeDraft(state, { type: 'tick' }, access, pool, time + 999999), state);
  state = updatePracticeDraft(state, { type: 'reset' }, access, pool, time + 1000000);
  assert.deepEqual(state.board.picks, fixture().picks);
  assert.equal(state.board.clock.status, 'waiting');
});
