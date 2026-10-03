import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ESPN_LINEUP_SLOT_LABELS, extractDraftRosterEligibility, extractDraftRosterSettings, extractEspnSlotDefinitions, verifyEspnUnlimitedPositionLimit, type DraftRosterSettings, type DraftRosterEligibility, type EspnRosterSource } from '../../src/lib/espn-roster-settings';

const settingsFile = new URL('../../data/draft-roster-settings.json', import.meta.url);
const savedSettings = JSON.parse(await readFile(settingsFile, 'utf8')) as DraftRosterSettings;
const source: EspnRosterSource = { sha256: 'a'.repeat(64), capturedAt: '2026-10-03T18:00:00Z', url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/139935?view=mSettings' };
const clientSource = { ...source, url: 'https://cdn1.espn.net/kona/verified/client.js' };
const playerSource = { ...source, url: source.url.replace('mSettings', 'kona_player_info') };
const settingsPayload = () => ({ id: 139935, seasonId: 2027, settings: { rosterSettings: {
  lineupSlotCounts: { ...savedSettings.lineupSlotCounts }, positionLimits: { ...savedSettings.positionLimits }, isBenchUnlimited: true,
} } });
const extract = (payload: unknown) => extractDraftRosterSettings(payload, source, savedSettings.slotDefinitions, clientSource, clientSource);
const player = (id = 1) => ({ id, status: 'FREEAGENT', player: { id, fullName: `Player ${id}`, active: true, defaultPositionId: 1, injuryStatus: 'ACTIVE', eligibleSlots: [4, 11, 12, 13, 15] } });

test('roster capacity comes from ESPN slot counts while primary limits and IR remain separate', () => {
  const input = settingsPayload();
  const result = extract(input);
  assert.deepEqual(result.slots.map(slot => [slot.label, slot.count]), [['PG', 1], ['SG', 1], ['SF', 1], ['PF', 1], ['C', 1], ['G', 1], ['F', 1], ['UTIL', 3], ['BE', 3], ['IR', 1]]);
  assert.equal(result.normalCapacity, 13); assert.equal(result.reserveCapacity, 1);
  assert.ok(result.primaryPositionLimits.every(limit => limit.maximum === null));
  assert.equal(result.isBenchUnlimited, true);
  input.settings.rosterSettings.lineupSlotCounts['11'] = 4;
  input.settings.rosterSettings.lineupSlotCounts['13'] = 2;
  input.settings.rosterSettings.positionLimits['1'] = 5;
  const changed = extract(input);
  assert.equal(changed.normalCapacity, 14); assert.equal(changed.reserveCapacity, 2);
  assert.equal(changed.primaryPositionLimits[0].maximum, 5);
  assert.equal(changed.slots.find(slot => slot.label === 'PG')!.count, 1);
});

test('wrong seasons, invalid counts, unknown active slots, and missing primary limits fail closed', () => {
  assert.throws(() => extract({ ...settingsPayload(), seasonId: 2026 }), /season 2027/);
  for (const value of [-1, 1.5, '3']) {
    const input = settingsPayload(); Object.assign(input.settings.rosterSettings.lineupSlotCounts, { 11: value });
    assert.throws(() => extract(input), /numeric roster settings/);
  }
  for (const slot of ['99', '15']) {
    const input = settingsPayload(); input.settings.rosterSettings.lineupSlotCounts[slot] = 1;
    assert.throws(() => extract(input), /unknown or cannot hold/);
  }
  const input = settingsPayload(); delete input.settings.rosterSettings.positionLimits['5'];
  assert.throws(() => extract(input), /primary-position limit/);
});

test('player slot eligibility is copied exactly rather than inferred from primary position or injury', () => {
  const result = extractDraftRosterEligibility({ players: [player()] }, playerSource);
  assert.deepEqual(result.players[0].eligibleSlots, [4, 11, 12, 13, 15]);
  assert.equal(result.players[0].primaryPositionId, 1);
  assert.equal(result.players[0].eligibleSlots.includes(0), false);
  assert.equal(result.players[0].injuryStatus, 'ACTIVE');
  assert.equal('irEligible' in result.players[0], false);
  assert.throws(() => extractDraftRosterEligibility({ players: [player(), player()] }, playerSource), /duplicate/);
  assert.throws(() => extractDraftRosterEligibility({ players: [{ ...player(), player: { ...player().player, eligibleSlots: undefined } }] }, playerSource), /slot eligibility/);
  assert.throws(() => extractDraftRosterEligibility({ players: [{ ...player(), player: { ...player().player, eligibleSlots: [99] } }] }, playerSource), /slot eligibility/);
  assert.throws(() => extractDraftRosterEligibility({ players: [player()] }, { ...playerSource, url: playerSource.url.replace('2027', '2026') }), /upcoming ESPN/);
  assert.throws(() => extractDraftRosterEligibility({ players: Array(2000).fill(player()) }, playerSource), /truncated/);
});

test('public extracts allowlist provenance and players without owners, account identifiers, cookies or private payloads', () => {
  const sensitiveSource = { ...source, cookie: 'secret credential', account: 'private owner' };
  const payload = { ...settingsPayload(), members: [{ id: 'private owner' }] };
  const result = extractDraftRosterSettings(payload, sensitiveSource, savedSettings.slotDefinitions, clientSource, clientSource);
  assert.deepEqual(Object.keys(result.source).sort(), ['capturedAt', 'sha256', 'url']);
  assert.doesNotMatch(JSON.stringify(result), /secret credential|private owner|members/);
  const eligible = extractDraftRosterEligibility({ players: [{ ...player(), ownerId: 'private owner', player: { ...player().player, privateAccount: 'secret credential' } }] }, playerSource);
  assert.doesNotMatch(JSON.stringify(eligible), /private owner|secret credential|ownerId|privateAccount/);
  assert.throws(() => extractDraftRosterEligibility({ players: [player()] }, { ...playerSource, url: playerSource.url + '&espn_s2=secret' }), /source provenance/);
});

test('official slot-label extraction parses data without executing code and detects changed ESPN conventions', () => {
  const literal = 'e.exports=[' + savedSettings.slotDefinitions.map(slot => `{abbrev:${JSON.stringify(slot.label)},active:true,bench:${slot.bench},id:${slot.slotId},injuryRequired:${slot.reserve},lineupSlotEligible:${slot.lineupSlotEligible},name:${JSON.stringify(slot.name)}}`).join(',') + ']';
  assert.deepEqual(extractEspnSlotDefinitions(literal), savedSettings.slotDefinitions);
  assert.throws(() => extractEspnSlotDefinitions(literal.replace('abbrev:"UTIL"', 'abbrev:"FLEX"')), /definitions changed/);
  assert.throws(() => extractEspnSlotDefinitions('throw new Error("must never execute downloaded code");'), /not found/);
  const sentinel = 'let et="rosterSettings.lineupSlotCounts";const tt=10;const nt=-1; rosterSettings.positionLimits title:i.formatMessage(ot.noLimit),value:nt';
  verifyEspnUnlimitedPositionLimit(sentinel);
  assert.throws(() => verifyEspnUnlimitedPositionLimit(sentinel.replace('nt=-1', 'nt=0')), /source review/);
});

test('published fresh artifacts cover the complete player catalog and every frozen keeper roster identity', async () => {
  const eligibility = JSON.parse(await readFile(new URL('../../data/draft-roster-eligibility.json', import.meta.url), 'utf8')) as DraftRosterEligibility;
  const catalog = JSON.parse(await readFile(new URL('../../data/draft-player-catalog.json', import.meta.url), 'utf8')) as { players: { id: number }[] };
  const league = JSON.parse(await readFile(new URL('../../data/league.json', import.meta.url), 'utf8')) as { players: { id: number }[] };
  const ids = new Set(eligibility.players.map(player => player.id));
  assert.equal(ids.size, eligibility.players.length);
  assert.equal(catalog.players.filter(player => !ids.has(player.id)).length, 0);
  assert.equal(league.players.filter(player => !ids.has(player.id)).length, 0);
  assert.ok(eligibility.players.every(player => player.eligibleSlots.length && player.eligibleSlots.every(slot => ESPN_LINEUP_SLOT_LABELS[slot])));
  assert.equal(savedSettings.leagueId, eligibility.leagueId); assert.equal(savedSettings.espnSeasonId, eligibility.espnSeasonId);
  assert.ok(savedSettings.source.url.includes('view=mSettings'));
  assert.equal(savedSettings.slots.find(slot => slot.slotId === 12)!.label, 'BE');
});
