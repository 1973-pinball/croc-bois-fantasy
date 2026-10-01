import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDraftPickGrids, readAllInventoryPages, type InventoryFranchise, type InventoryParticipant, type InventoryPick } from '../../src/lib/live-draft-pick-grids';
import { orderPickGridTeams } from '../../src/lib/draft-pick-grids';

function fixture() {
  const franchises: InventoryFranchise[] = Array.from({ length: 10 }, (_, i) => ({ id: `franchise-${String(i + 1).padStart(2, '0')}`, name: `Team ${i + 1}`, espn_team_id: i < 8 ? i + 1 : null }));
  const seasons = [{ id: 'current', draft_year: 2026, participant_count: 8, rule_version_id: 'rule-13' }, { id: 'future', draft_year: 2031, participant_count: 10, rule_version_id: 'rule-14' }];
  const rules = [{ id: 'rule-13', draft_rounds: 13 }, { id: 'rule-14', draft_rounds: 14 }];
  const participants: InventoryParticipant[] = seasons.flatMap(s => franchises.slice(0, s.participant_count).map(f => ({ season_id: s.id, franchise_id: f.id, display_name: `${s.draft_year} ${f.name}`, draft_position: null })));
  const picks: InventoryPick[] = seasons.flatMap(s => franchises.slice(0, s.participant_count).flatMap(f => Array.from({ length: rules.find(r => r.id === s.rule_version_id)!.draft_rounds }, (_, i) => ({ id: `${s.id}:${f.id}:${i + 1}`, season_id: s.id, original_franchise_id: f.id, current_owner_id: f.id, round: i + 1, status: 'available' }))));
  return { seasons, rules, franchises, participants, picks };
}

test('eight-team present and ten-team future inventories preserve season-specific rounds and expansion UUIDs', () => {
  const input = fixture();
  const grids = buildLiveDraftPickGrids(input);
  assert.deepEqual(grids.map(g => [g.year, g.roundCount, g.teams.length, g.picks.length]), [[2026, 13, 8, 104], [2031, 14, 10, 140]]);
  assert.equal(grids.some(g => g.year === 2027), false, 'No phantom future year is created');
  const expansion = grids[1].teams.filter(t => t.id < 0) as ({ id: number; franchiseId: string })[];
  assert.equal(new Set(expansion.map(t => t.id)).size, 2);
  assert.deepEqual(expansion.map(t => t.franchiseId).sort(), ['franchise-09', 'franchise-10']);
  const shuffled = buildLiveDraftPickGrids({ ...input, franchises: [...input.franchises].reverse(), participants: [...input.participants].reverse() });
  assert.deepEqual(shuffled[1].teams, grids[1].teams);
  assert.equal(grids[1].teams.every(t => t.name.startsWith('2031 ')), true);
});

test('the three current ownership differences count once and preserve original pick IDs, including used picks', () => {
  const input = fixture();
  for (const pick of input.picks.filter(p => p.season_id === 'current')) {
    if (pick.original_franchise_id === 'franchise-02' && [3, 4].includes(pick.round)) pick.current_owner_id = 'franchise-01';
    if (pick.original_franchise_id === 'franchise-01' && pick.round === 8) { pick.current_owner_id = 'franchise-05'; pick.status = 'used'; }
  }
  const current = buildLiveDraftPickGrids(input)[0];
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => current.picks.filter(p => p.ownerTeamId === i + 1).length), [14, 11, 13, 13, 14, 13, 13, 13]);
  assert.equal(current.picks.find(p => p.originalTeamId === 1 && p.round === 8)?.id, 'current:franchise-01:8');
  assert.equal(current.picks.find(p => p.originalTeamId === 1 && p.round === 8)?.ownerTeamId, 5);
});

test('known franchise labels are retained, expansion labels are explicit, and grid order ignores lottery position', () => {
  const input = fixture();
  const referenceTeams = [{ id: 1, name: 'Reference name', shortName: 'ONE', owner: 'Current owner', managers: ['Current owner'], color: '#123456' }];
  for (const season of input.seasons) input.participants.filter(p => p.season_id === season.id).forEach((p, i) => { p.draft_position = season.participant_count - i; });
  const future = buildLiveDraftPickGrids({ ...input, referenceTeams })[1];
  const known = future.teams.find(t => t.id === 1)!;
  assert.equal(known.name, '2031 Team 1');
  assert.equal(known.shortName, 'ONE');
  assert.equal(known.owner, 'Current owner');
  assert.deepEqual(known.managers, ['Current owner']);
  assert.equal(future.teams.find(t => t.franchiseId === 'franchise-09')?.owner, 'Manager assignment pending');
  assert.deepEqual(future.teams, orderPickGridTeams(future.teams));
  const withoutLottery = buildLiveDraftPickGrids({ ...input, referenceTeams, participants: input.participants.map(p => ({ ...p, draft_position: null })) })[1];
  assert.deepEqual(future.teams, withoutLottery.teams);
});

test('partial, empty, duplicate, out-of-range, and cross-season inventories fail instead of inventing ownership', () => {
  assert.throws(() => buildLiveDraftPickGrids({ ...fixture(), picks: fixture().picks.slice(1) }), /incomplete/);
  assert.throws(() => buildLiveDraftPickGrids({ ...fixture(), picks: [] }), /incomplete/);
  assert.throws(() => buildLiveDraftPickGrids({ ...fixture(), participants: fixture().participants.slice(1) }), /incomplete/);
  const duplicate = fixture(); duplicate.picks[0] = { ...duplicate.picks[1], id: 'different-id' };
  assert.throws(() => buildLiveDraftPickGrids(duplicate), /Duplicate original/);
  const invalid = fixture(); invalid.picks[0].round = 14;
  assert.throws(() => buildLiveDraftPickGrids(invalid), /round or status/);
  const foreignOwner = fixture(); foreignOwner.picks[0].current_owner_id = 'franchise-10';
  assert.throws(() => buildLiveDraftPickGrids(foreignOwner), /outside its season/);
});

test('pagination reads beyond 1000 rows and handles a smaller server cap without truncation', async () => {
  const source = Array.from({ length: 1400 }, (_, id) => ({ id }));
  const ranges: number[][] = [];
  const rows = await readAllInventoryPages(async (from, to) => { ranges.push([from, to]); return { data: source.slice(from, Math.min(to + 1, from + 600)), error: null, count: source.length }; });
  assert.deepEqual(rows, source);
  assert.deepEqual(ranges, [[0, 999], [600, 1599], [1200, 2199]]);
  let page = 0;
  await assert.rejects(() => readAllInventoryPages(async () => ({ data: page++ === 0 ? source.slice(0, 1000) : [], count: 1400, error: null })), /before the expected count/);
  await assert.rejects(() => readAllInventoryPages(async () => ({ data: null, count: null, error: { message: 'database unavailable' } })), /query failed/);
});
