import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProjectionRankSnapshotSchema, mergeDraftProjectionRanks, needsDirectRankRefresh, needsEspnCatalogRefresh, needsEspnParserRefresh, needsYahooRankRefresh, type DraftProjectionRankSnapshot } from '../../src/lib/draft-projection-ranks';
import { ESPN_PROJECTION_PARSER_VERSION } from '../../src/lib/draft-projections';
import type { DraftPlayerProjection, DraftProjectionDataset } from '../../src/lib/draft-projections';

const player = (id: number, providerRank?: number): DraftPlayerProjection => ({ id, name: `Synthetic player ${id}`, games: 70,
  stats: { pts: 20, reb: 5, ast: 3, stl: 1, blk: 1, tov: 2, three: 2, fgm: 7, fga: 15, ftm: 4, fta: 5 }, ...(providerRank === undefined ? {} : { providerRank }) });
const dataset = (source: DraftProjectionDataset['source'] = 'basketball-monster'): DraftProjectionDataset => ({ source, sourceLabel: `${source} projections`, seasonId: 2027,
  importedAt: '2026-10-13T10:00:00.000Z', players: [player(1), player(2), player(3)], warnings: ['Synthetic forecast coverage notice.'] });
const snapshot = (): DraftProjectionRankSnapshot => ({ source: 'basketball-monster', seasonId: 2027, importedAt: '2026-10-14T10:00:00.000Z',
  ranks: [{ id: 2, providerRank: 1 }, { id: 1, providerRank: 9 }, { id: 99, providerRank: 15 }] });

test('legacy Yahoo forecasts require a rank refresh, while ranked, different-season and other-source imports do not', () => {
  const yahoo = dataset('yahoo');
  assert.equal(needsYahooRankRefresh(yahoo, 2027), true);
  assert.equal(needsYahooRankRefresh({ ...yahoo, players: [player(1, 17), player(2)] }, 2027), false);
  assert.equal(needsYahooRankRefresh(yahoo, 2026), false);
  assert.equal(needsYahooRankRefresh(dataset(), 2027), false);
  assert.equal(needsYahooRankRefresh(dataset('espn'), 2027), false);
  assert.equal(needsYahooRankRefresh(undefined, 2027), false);
  assert.equal(needsYahooRankRefresh({ ...yahoo, players: [player(1, 0)] }, 2027), false);
});

test('both direct providers can migrate old rankless imports without refreshing a mismatched or partially ranked import', () => {
  for (const source of ['espn', 'yahoo'] as const) {
    const legacy = dataset(source);
    assert.equal(needsDirectRankRefresh(source, legacy, 2027), true);
    assert.equal(needsDirectRankRefresh(source, { ...legacy, players: [player(1, 8), player(2)] }, 2027), false);
    assert.equal(needsDirectRankRefresh(source, legacy, 2026), false);
    assert.equal(needsDirectRankRefresh(source, dataset(source === 'espn' ? 'yahoo' : 'espn'), 2027), false);
    assert.equal(needsDirectRankRefresh(source, null, 2027), false);
  }
});

test('a newer catalog refreshes only older matching ESPN imports and preserves provider data', () => {
  const espn = { ...dataset('espn'), players: [player(1, 8), player(2, 12)] };
  const original = structuredClone(espn);
  assert.equal(needsEspnCatalogRefresh(espn, 2027, '2026-10-16T10:00:00.000Z'), true);
  assert.equal(needsEspnCatalogRefresh(espn, 2027, espn.importedAt), false);
  assert.equal(needsEspnCatalogRefresh(espn, 2027, '2026-10-12T10:00:00.000Z'), false);
  assert.equal(needsEspnCatalogRefresh(espn, 2028, '2026-10-16T10:00:00.000Z'), false);
  assert.equal(needsEspnCatalogRefresh(espn, 2027, 'invalid date'), false);
  for (const value of [dataset('yahoo'), dataset(), undefined, { ...espn, importedAt: 'invalid date' }]) {
    assert.equal(needsEspnCatalogRefresh(value, 2027, '2026-10-16T10:00:00.000Z'), false);
  }
  assert.deepEqual(espn, original);
});

test('the ESPN parser migration refreshes recent old-version imports but leaves current versions and other providers intact', () => {
  const espn = { ...dataset('espn'), importedAt: '2026-10-16T23:00:00.000Z', players: [player(1, 8)] };
  const before = structuredClone(espn);
  assert.equal(needsEspnParserRefresh(espn, 2027), true);
  assert.equal(needsEspnParserRefresh({ ...espn, espnParserVersion: 1 }, 2027), true);
  assert.equal(needsEspnParserRefresh({ ...espn, espnParserVersion: ESPN_PROJECTION_PARSER_VERSION }, 2027), false);
  assert.equal(needsEspnParserRefresh({ ...espn, espnParserVersion: ESPN_PROJECTION_PARSER_VERSION + 1 }, 2027), false);
  assert.equal(needsEspnParserRefresh(espn, 2028), false);
  for (const value of [dataset('yahoo'), dataset(), undefined, { ...espn, espnParserVersion: -1 }]) {
    assert.equal(needsEspnParserRefresh(value, 2027), false);
  }
  assert.deepEqual(espn, before);
});

test('rank hydration preserves every forecast field, supplied gaps and input objects without inventing unmatched players', () => {
  const forecast = dataset(), supplied = snapshot();
  const original = structuredClone(forecast), originalRanks = structuredClone(supplied);
  const result = mergeDraftProjectionRanks(forecast, supplied);
  assert.deepEqual(result.players.map(row => [row.id, row.providerRank]), [[1, 9], [2, 1], [3, undefined]]);
  assert.deepEqual(result.players.map(({ providerRank: _rank, ...row }) => row), original.players);
  assert.deepEqual({ ...result, players: original.players }, original);
  assert.deepEqual(forecast, original); assert.deepEqual(supplied, originalRanks);
  assert.deepEqual(mergeDraftProjectionRanks(result, supplied), result);
});

test('an existing supplied rank is retained and a conflicting imported ranking cannot overwrite it', () => {
  const forecast = dataset(); forecast.players[0].providerRank = 9; forecast.players[2].providerRank = 31;
  const hydrated = mergeDraftProjectionRanks(forecast, snapshot());
  assert.equal(hydrated.players[0].providerRank, 9); assert.equal(hydrated.players[2].providerRank, 31);
  forecast.players[0].providerRank = 8;
  assert.throws(() => mergeDraftProjectionRanks(forecast, snapshot()), /Saved and supplied ranks disagree/);
  assert.equal(forecast.players[0].providerRank, 8);
});

test('legitimate supplied rank ties are preserved without renumbering', () => {
  const supplied = { ...snapshot(), ranks: [{ id: 1, providerRank: 8 }, { id: 2, providerRank: 8 }] };
  assert.equal(draftProjectionRankSnapshotSchema.safeParse(supplied).success, true);
  assert.deepEqual(mergeDraftProjectionRanks(dataset(), supplied).players.map(row => row.providerRank), [8, 8, undefined]);
});

test('wrong source, wrong season and malformed or ambiguous rank snapshots fail closed', () => {
  assert.throws(() => mergeDraftProjectionRanks(dataset('yahoo'), snapshot()), /match the projection source and season/);
  assert.throws(() => mergeDraftProjectionRanks(dataset(), { ...snapshot(), seasonId: 2028 }), /match the projection source and season/);
  for (const ranks of [[], [{ id: 1, providerRank: 0 }], [{ id: 1, providerRank: 1.5 }], [{ id: 0, providerRank: 1 }],
    [{ id: 1, providerRank: 1 }, { id: 1, providerRank: 2 }],
    [{ id: 1, providerRank: 1, pts: 20 }]]) assert.equal(draftProjectionRankSnapshotSchema.safeParse({ ...snapshot(), ranks }).success, false);
  assert.equal(draftProjectionRankSnapshotSchema.safeParse({ ...snapshot(), source: 'espn' }).success, false);
  assert.equal(draftProjectionRankSnapshotSchema.safeParse({ ...snapshot(), forecasts: [] }).success, false);
});
