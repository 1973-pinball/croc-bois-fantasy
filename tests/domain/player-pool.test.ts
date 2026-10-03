import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlayerPool } from '../../src/lib/player-pool';
import type { DraftCatalogPlayer } from '../../src/lib/draft-player-catalog';
import type { LeaguePlayer } from '../../src/lib/types';

const rosterPlayer = (id: number, overrides: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  id, name: `Roster player ${id}`, teamId: -1, baseCost: 5, tenure: 2, status: 'eligible',
  reason: 'Verified keeper profile', wasKept: true, previousRound: 6, rosterSlot: 'IR', ...overrides,
});
const catalogPlayer = (id: number, overrides: Partial<DraftCatalogPlayer> = {}): DraftCatalogPlayer => ({
  id, name: `Catalog player ${id}`, nbaTeam: 'FA', primaryPosition: 'PG', eligiblePositions: ['PG'],
  rank: null, rankSource: null, active: true, selectable: true, ...overrides,
});

test('league ownership and keeper profiles remain authoritative over matching catalog records', () => {
  const roster = Object.freeze([
    Object.freeze(rosterPlayer(1)),
    Object.freeze(rosterPlayer(2, { status: 'ineligible', baseCost: null, reason: 'Five-year limit', tenure: 5 })),
    Object.freeze(rosterPlayer(3, { status: 'review', reason: 'Awaiting commissioner review' })),
  ]);
  const catalog = Object.freeze(roster.map(player => Object.freeze(catalogPlayer(player.id))));
  const result = buildPlayerPool(roster, catalog);
  assert.deepEqual(result, roster);
  assert.notEqual(result, roster);
});

test('unrostered unsigned and unranked players are browsable without invented ownership or keeper history', () => {
  const [player] = buildPlayerPool([], [catalogPlayer(40, { name: 'Unsigned prospect' })]);
  assert.equal(player.id, 40);
  assert.equal(player.name, 'Unsigned prospect');
  assert.equal(player.teamId, null);
  assert.equal(player.status, 'ineligible');
  assert.equal(player.baseCost, null);
  assert.equal(player.tenure, null);
  assert.equal(player.previousRound, null);
  assert.equal(player.wasKept, false);
  assert.equal(player.rosterSlot, '');
  assert.match(player.reason, /not on a current league roster/i);
  assert.match(player.reason, /keeper ineligibility does not prevent drafting/i);
});

test('ESPN identities deduplicate records without merging different players who share a name', () => {
  const authoritative = rosterPlayer(1, { name: 'Shared name' });
  const result = buildPlayerPool([authoritative, rosterPlayer(1, { teamId: 2 })], [
    catalogPlayer(1),
    catalogPlayer(2, { name: 'Shared name' }),
    catalogPlayer(2, { name: 'Duplicate catalog entry' }),
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.find(player => player.id === 1), authoritative);
  assert.equal(result.find(player => player.id === 2)?.name, 'Shared name');
  assert.equal(result.find(player => player.id === 2)?.teamId, null);
});

test('inactive or unavailable catalog additions are excluded while every league roster record remains visible', () => {
  const inactiveRosterPlayer = rosterPlayer(1);
  const missingCatalogPlayer = rosterPlayer(2);
  const result = buildPlayerPool([inactiveRosterPlayer, missingCatalogPlayer], [
    catalogPlayer(1, { active: false, selectable: false }),
    catalogPlayer(3, { active: false, selectable: false }),
    catalogPlayer(4, { active: true, selectable: false }),
    catalogPlayer(5, { active: false, selectable: true }),
    catalogPlayer(6),
  ]);
  assert.deepEqual(result.map(player => player.id), [1, 2, 6]);
  assert.deepEqual(result.find(player => player.id === 1), inactiveRosterPlayer);
  assert.deepEqual(result.find(player => player.id === 2), missingCatalogPlayer);
  assert.equal(result.find(player => player.id === 6)?.status, 'ineligible');
});
