import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTradePickInventory } from '../../src/lib/trade-pick-inventory';
import { emptyTradeDraft, isTradeComposerDraft, serializeTradeDraft } from '../../src/lib/trade-workspace';

const uuid = (id: number) => `87000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const franchises = { '1': uuid(1), '-3': uuid(2) };
const teams = [{ id: 1, name: 'One', shortName: 'ONE', owner: '', managers: [], color: '#000000' }, { id: -3, name: 'Expansion', shortName: 'EXP', owner: '', managers: [], color: '#ffffff' }];
function fixture() {
  const grid = (year: number, source = 'live') => ({
    year, source, roundCount: 2,
    // Inventory and current-season display handles deliberately differ; only franchise UUID is stable.
    teams: [{ id: 1, franchiseId: uuid(1) }, { id: -1, franchiseId: uuid(2) }],
    picks: [1, -1].flatMap((owner, index) => [1, 2].map(round => ({ id: uuid(year * 10 + index * 2 + round), season: year, round, originalTeamId: owner, ownerTeamId: owner }))),
  });
  return { source: 'supabase', usedPickIds: [uuid(20274)], seasons: [grid(2025, 'archive'), grid(2026), grid(2027), grid(2028, 'reference')] };
}

test('only real current and future inventory enters trade choices; UUID mapping and all-year used status are preserved', () => {
  const input = fixture(); const before = structuredClone(input);
  const inventory = buildTradePickInventory(input, 2026, franchises);
  assert.deepEqual(input, before);
  assert.deepEqual(inventory.years, [2026, 2027]); assert.equal(inventory.picks.length, 8);
  assert.deepEqual(inventory.usedPickIds, [uuid(20274)]);
  assert.ok(inventory.picks.every(pick => [1, -3].includes(pick.ownerTeamId)));
  assert.equal(inventory.picks.find(pick => pick.id === uuid(20273))!.ownerTeamId, -3);
  assert.equal(inventory.picks.some(pick => pick.season === 2028), false, 'A displayed reference year never becomes a synthetic trade asset');
});

test('a 2026-to-2027 swap preserves both real pick identities and rejects future stale ownership, used status and recipient mismatch', () => {
  const inventory = buildTradePickInventory(fixture(), 2026, franchises);
  const data = { teams, players: [], picks: inventory.picks };
  const input = { seasonId: uuid(50), category: 'advanced' as const, terms: 'Cross-year pick swap', data, franchiseIds: franchises, usedPickIds: inventory.usedPickIds, draftYear: 2026, pickParticipantIds: inventory.participantIdsByYear,
    legs: [{ key: 'a', kind: 'pick' as const, pickId: uuid(20261), fromTeamId: 1, toTeamId: -3 }, { key: 'b', kind: 'pick' as const, pickId: uuid(20273), fromTeamId: -3, toTeamId: 1 }] };
  const payload = serializeTradeDraft(input);
  assert.deepEqual(payload.picks, [{ pickId: uuid(20261), fromFranchiseId: uuid(1), toFranchiseId: uuid(2) }, { pickId: uuid(20273), fromFranchiseId: uuid(2), toFranchiseId: uuid(1) }]);
  assert.equal(data.picks.find(pick => pick.id === uuid(20273))!.ownerTeamId, -3, 'Serializing never executes a transfer');
  assert.throws(() => serializeTradeDraft({ ...input, data: { ...data, picks: data.picks.map(pick => pick.id === uuid(20273) ? { ...pick, ownerTeamId: 1 } : pick) } }), /no longer available/);
  assert.throws(() => serializeTradeDraft({ ...input, usedPickIds: [uuid(20273)] }), /no longer available/);
  assert.throws(() => serializeTradeDraft({ ...input, pickParticipantIds: { ...input.pickParticipantIds, 2027: [-3] } }), /Both teams must participate/);
});

test('fallback-only years and malformed availability never masquerade as live tradable picks', () => {
  const input = fixture(); input.seasons[1].source = 'reference';
  assert.throws(() => buildTradePickInventory(input, 2026, franchises), /current live/);
  assert.throws(() => buildTradePickInventory({ ...fixture(), usedPickIds: undefined }, 2026, franchises), /could not be verified/);
  const fake = fixture(); fake.seasons[2].picks[0].id = 'reference-2027-1-1';
  assert.throws(() => buildTradePickInventory(fake, 2026, franchises), /invalid identity/);
  const duplicate = fixture(); duplicate.seasons[2].picks[0] = { ...duplicate.seasons[2].picks[1] };
  assert.throws(() => buildTradePickInventory(duplicate, 2026, franchises), /invalid identity/);
});

test('existing saved private drafts remain valid and a selected future draft year can persist without changing their legs', () => {
  const legacy = { ...emptyTradeDraft(false), legs: [{ key: 'x', kind: 'pick' as const, pickId: uuid(20261), fromTeamId: 1, toTeamId: -3 }] };
  assert.equal(isTradeComposerDraft(legacy), true);
  assert.equal(isTradeComposerDraft({ ...legacy, pickYear: '2027' }), true);
  assert.equal(legacy.legs.length, 1);
});
