import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeTradeDraft, type TradeDraftLeg } from '../../src/lib/trade-workspace';
import type { LeagueData, Team } from '../../src/lib/types';

const team = (id: number): Team => ({ id, name: `Team ${id}`, owner: '', managers: [], shortName: `T${id}`, color: '#193c32' });
const data: Pick<LeagueData, 'teams' | 'players' | 'picks'> = {
  teams: [team(1), team(2), team(-3)],
  players: [{ id: 10, name: 'Test Player', teamId: 1, baseCost: 4, tenure: 2, status: 'eligible', reason: '', wasKept: true, previousRound: 5, rosterSlot: 'Active' }],
  picks: [{ id: 'pick-2', season: 2026, round: 2, originalTeamId: 1, ownerTeamId: 2 }],
};
const franchises = { '1': 'franchise-a', '2': 'franchise-b', '-3': 'franchise-expansion' };
const player: TradeDraftLeg = { key: 'ui-1', kind: 'player', playerId: 10, fromTeamId: 1, toTeamId: 2 };
const pick: TradeDraftLeg = { key: 'ui-2', kind: 'pick', pickId: 'pick-2', fromTeamId: 2, toTeamId: -3 };
const obligation: TradeDraftLeg = { key: 'ui-3', kind: 'obligation', obligationKind: 'loan_return', terms: ' Return the loaned player. ', dueAt: '2026-11-01T12:00:00.000Z', fromTeamId: -3, toTeamId: 1 };
const input = { seasonId: 'season-id', category: 'advanced' as const, terms: ' Three-team agreement. ', legs: [player, pick, obligation], data, franchiseIds: franchises, usedPickIds: [] as string[] };

test('multi-team trade preserves directions and original pick identity while serializing only API fields', () => {
  const payload = serializeTradeDraft(input);
  assert.deepEqual(payload, {
    seasonId: 'season-id', category: 'advanced', terms: 'Three-team agreement.',
    players: [{ playerId: 10, fromFranchiseId: 'franchise-a', toFranchiseId: 'franchise-b' }],
    picks: [{ pickId: 'pick-2', fromFranchiseId: 'franchise-b', toFranchiseId: 'franchise-expansion' }],
    obligations: [{ kind: 'loan_return', terms: 'Return the loaned player.', dueAt: '2026-11-01T12:00:00.000Z', fromFranchiseId: 'franchise-expansion', toFranchiseId: 'franchise-a' }],
  });
  assert.equal(JSON.stringify(payload).includes('ui-'), false);
  assert.equal(data.picks[0].ownerTeamId, 2, 'Logging serializes a proposal and does not update the ownership snapshot');
  assert.equal(data.picks[0].originalTeamId, 1);
});

test('duplicate assets and player-only advanced entries are rejected before a proposal is sent', () => {
  assert.throws(() => serializeTradeDraft({ ...input, legs: [player, { ...player, key: 'duplicate', toTeamId: -3 }] }), /player can appear only once/);
  assert.throws(() => serializeTradeDraft({ ...input, legs: [pick, { ...pick, key: 'duplicate', toTeamId: 1 }] }), /pick can appear only once/);
  assert.throws(() => serializeTradeDraft({ ...input, category: 'player_only' }), /Choose Advanced/);
  assert.equal(serializeTradeDraft({ ...input, category: 'player_only', legs: [player] }).players.length, 1);
});

test('stale ownership and consumed picks cannot be serialized as available assets', () => {
  assert.throws(() => serializeTradeDraft({ ...input, data: { ...data, players: data.players.map(p => ({ ...p, teamId: 2 })) } }), /player is no longer/);
  assert.throws(() => serializeTradeDraft({ ...input, data: { ...data, picks: data.picks.map(p => ({ ...p, ownerTeamId: -3 })) } }), /pick is no longer/);
  assert.throws(() => serializeTradeDraft({ ...input, usedPickIds: ['pick-2'] }), /pick is no longer/);
});

test('each leg needs two participating franchises, including expansion teams', () => {
  assert.throws(() => serializeTradeDraft({ ...input, legs: [{ ...player, toTeamId: 1 }] }), /different sending and receiving/);
  assert.throws(() => serializeTradeDraft({ ...input, legs: [{ ...player, toTeamId: 99 }] }), /participate in this season/);
  assert.throws(() => serializeTradeDraft({ ...input, franchiseIds: { '1': 'franchise-a', '2': 'franchise-b' } }), /participate in this season/);
  assert.equal(serializeTradeDraft(input).obligations[0].fromFranchiseId, 'franchise-expansion');
});

test('obligation-only advanced trades are explicit and accept an unknown due date', () => {
  const loan = { ...obligation, dueAt: null };
  const payload = serializeTradeDraft({ ...input, legs: [loan] });
  assert.equal(payload.players.length, 0);
  assert.equal(payload.picks.length, 0);
  assert.equal(payload.obligations[0].dueAt, null);
  assert.throws(() => serializeTradeDraft({ ...input, legs: [{ ...loan, terms: '   ' }] }), /obligation needs terms/);
  assert.throws(() => serializeTradeDraft({ ...input, legs: [{ ...loan, dueAt: 'not-a-date' }] }), /valid obligation due date/);
});

test('trade size boundaries are enforced before the API request', () => {
  assert.throws(() => serializeTradeDraft({ ...input, legs: [] }), /between 1 and 100/);
  assert.throws(() => serializeTradeDraft({ ...input, legs: Array.from({ length: 101 }, (_, i) => ({ ...obligation, key: String(i) })) }), /between 1 and 100/);
  assert.throws(() => serializeTradeDraft({ ...input, terms: 'x'.repeat(10001) }), /10,000 characters/);
  assert.throws(() => serializeTradeDraft({ ...input, legs: Array.from({ length: 4 }, (_, i) => ({ ...obligation, key: String(i), terms: 'x'.repeat(10000) })) }), /too much text/);
});
