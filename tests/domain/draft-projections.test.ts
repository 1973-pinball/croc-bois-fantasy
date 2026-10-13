import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProjectionDatasetSchema, extractEspnDraftProjections, importDraftProjections } from '../../src/lib/draft-projections';
import type { DraftCatalogPlayer } from '../../src/lib/draft-player-catalog';

const player = (id: number, name: string): DraftCatalogPlayer => ({ id, name, nbaTeam: 'DEN', primaryPosition: 'C', eligiblePositions: ['C'], rank: id, rankSource: 'ROTO', active: true, selectable: true });
const catalog = { espnSeasonId: 2027, players: [player(1, 'Nikola Jokić'), player(2, 'Test, Player'), player(3, 'Other Player')] };
const importedAt = '2026-10-13T12:00:00.000Z';
const titles = 'Player,GP,PTS,REB,AST,STL,BLK,TO,3PM,FGM,FGA,FTM,FTA';
const line = 'Nikola Jokic,70,28,12,10,1.5,0.8,3,2,10,18,6,8';
const options = (text: string) => ({ source: 'yahoo' as const, text, basis: 'per-game' as const, seasonId: 2027, catalog, importedAt });

test('CSV resolves exact normalized names, preserves shooting volumes, and keeps ESPN ranking external', () => {
  const result = importDraftProjections(options(`${titles}\n${line}`));
  assert.equal(result.players[0].id, 1);
  assert.equal(result.players[0].stats.fgm, 10);
  assert.equal(result.players[0].stats.fga, 18);
  assert.equal(result.players[0].games, 70);
  assert.equal(result.source, 'yahoo');
  assert.equal('rank' in result.players[0], false);
});

test('quoted CSV fields, BOM, CRLF and repeated headers are accepted', () => {
  const result = importDraftProjections(options(`\uFEFF${titles}\r\n"Test, Player",70,28,12,10,1.5,0.8,3,2,10,18,6,8\r\n${titles}`));
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].id, 2);
  assert.throws(() => importDraftProjections(options(`${titles}\n"broken`)), /closing quote/);
});

test('Hashtag pasted TSV recognizes TREB and makes/attempts embedded in percent cells', () => {
  const result = importDraftProjections({ ...options('PLAYER\tGP\tPTS\tTREB\tAST\tSTL\tBLK\tTO\t3PM\tFG%\tFT%\nNikola Jokic\t70\t28\t12\t10\t1.5\t0.8\t3\t2\t.556 (10/18)\t.750 (6/8)'), source: 'hashtag' });
  assert.equal(result.players[0].stats.fgm, 10);
  assert.equal(result.players[0].stats.fta, 8);
});

test('Yahoo FGM/A and FTM/A headers retain shot counts without interpreting provider ID or rank as ESPN identity', () => {
  const result = importDraftProjections(options('ID,Rank,Player,GP,FGM/A,FG%,FTM/A,FT%,3PTM,PTS,REB,AST,STL,BLK,TO\n3,99,Nikola Jokic,70,10/18,.556,6/8,.750,2,28,12,10,1.5,.8,3'));
  assert.equal(result.players[0].id, 1);
  assert.equal(result.players[0].stats.fgm, 10);
  assert.equal(result.players[0].stats.fga, 18);
  assert.equal(result.players[0].stats.ftm, 6);
  assert.equal(result.players[0].stats.fta, 8);
});

test('Basketball Monster published per-game headers import stats and ignore provider value columns', () => {
  // Header layout verified against https://basketballmonster.com/playerrankings.aspx.
  const text = 'Round,Rank,Value,Name,Team,Pos,Inj,g,m/g,p/g,3/g,r/g,a/g,s/g,b/g,fg%,fga/g,ft%,fta/g,to/g,USG,pV,3V,rV,aV,sV,bV,fg%V,ft%V,toV,ID\n1,99,9.5,Nikola Jokic,DEN,C,,70,34,28,2,12,10,1.5,.8,.5,18,.75,8,3,30,5,4,3,2,1,0,-1,-2,-3,3';
  const result = importDraftProjections({ ...options(text), source: 'basketball-monster' });
  assert.equal(result.players[0].id, 1);
  assert.deepEqual(result.players[0].stats, { pts: 28, reb: 12, ast: 10, stl: 1.5, blk: .8, tov: 3, three: 2, fgm: 9, fga: 18, ftm: 6, fta: 8 });
  assert.throws(() => importDraftProjections({ ...options(text), source: 'basketball-monster', basis: 'totals' }), /labeled \/g are per-game/);
  assert.throws(() => importDraftProjections({ ...options(text.replace(',to/g,', ',unused,')), source: 'basketball-monster' }), /Missing projection columns: TOV/);
  assert.throws(() => importDraftProjections(options(text)), /Missing projection columns/);
});

test('Basketball Monster short totals headers convert once and remain restricted to that provider', () => {
  const text = 'Name,g,p,3,r,a,s,b,fg%,fga,ft%,fta,to,ID\nNikola Jokic,10,280,20,120,100,15,8,.5,180,.75,80,30,3';
  const result = importDraftProjections({ ...options(text), source: 'basketball-monster', basis: 'totals' });
  assert.equal(result.players[0].id, 1);
  assert.deepEqual(result.players[0].stats, { pts: 28, reb: 12, ast: 10, stl: 1.5, blk: .8, tov: 3, three: 2, fgm: 9, fga: 18, ftm: 6, fta: 8 });
  assert.throws(() => importDraftProjections(options(text)), /Missing projection columns/);
});

test('attempts plus percentage derive makes, and totals divide every counting stat by GP', () => {
  const result = importDraftProjections({ ...options('Name,GP,PTS,REB,AST,STL,BLK,TO,3,FG%,FGA,FT%,FTA\nNikola Jokic,10,280,120,100,15,8,30,20,50%,180,.75,80'), basis: 'totals', source: 'basketball-monster' });
  assert.equal(result.players[0].stats.pts, 28);
  assert.equal(result.players[0].stats.fgm, 9);
  assert.equal(result.players[0].stats.ftm, 6);
  assert.equal(result.players[0].stats.tov, 3);
});

test('missing shots and missing category cells never become zero projections', () => {
  assert.throws(() => importDraftProjections(options('Name,PTS,REB,AST,STL,BLK,TO,3PM,FG%,FT%\nNikola Jokic,28,12,10,1.5,0.8,3,2,.5,.8')), /shooting makes and attempts/);
  const missing = line.replace(',1.5,', ',,');
  assert.throws(() => importDraftProjections(options(`${titles}\n${missing}`)), /STL is missing/);
  assert.throws(() => importDraftProjections({ ...options(`${titles}\n${line.replace(',70,', ',0,')}`), basis: 'totals' }), /positive GP/);
});

test('source IDs are not interchangeable and unmatched or ambiguous names are reported', () => {
  const result = importDraftProjections(options(`${titles},ID\n${line},3\nUnknown Player,70,28,12,10,1.5,0.8,3,2,10,18,6,8,1`));
  assert.equal(result.players[0].id, 1);
  assert.equal(result.players.length, 1);
  assert.match(result.warnings.join(' '), /1 row excluded/);
  assert.throws(() => importDraftProjections(options(`${titles},ESPN ID\n${line},3`)), /does not match/);
  assert.throws(() => importDraftProjections({ ...options(`${titles}\n${line}`), catalog: { ...catalog, players: [...catalog.players, player(4, 'Nikola Jokic')] } }), /unique ESPN ID or full name/);
});

test('Yahoo provider ranks do not alter ESPN IDs, full names tolerate accents and suffix punctuation', () => {
  const result = importDraftProjections({ ...options(`${titles},Rank,ID\nJose Alvarado Jr,70,12,3,5,1,0.2,1,1,4,9,3,4,99,123456`), catalog: { espnSeasonId: 2027, players: [player(7, 'José Alvarado Jr.')] } });
  assert.equal(result.players[0].id, 7);
  assert.throws(() => importDraftProjections(options(`${titles}\n${line}\n${line}`)), /Duplicate player projection/);
  assert.throws(() => importDraftProjections(options(`${titles}\n${line.replace(',28,', ',"1,5",')}`)), /ambiguous comma/);
});

test('invalid shooting, malformed numeric values, and unsupported seasons are rejected', () => {
  assert.throws(() => importDraftProjections(options(`${titles}\n${line.replace(',10,18,', ',20,18,')}`)), /Shooting makes/);
  assert.throws(() => importDraftProjections(options(`${titles}\n${line.replace(',28,', ',=100,')}`)), /nonnegative number/);
  assert.throws(() => importDraftProjections({ ...options(`${titles}\n${line}`), seasonId: 2026 }), /matching season/);
});

const averages = { '0': 28, '6': 12, '3': 10, '2': 1.5, '1': 0.8, '11': 3, '17': 2, '13': 10, '14': 18, '15': 6, '16': 8 };
const record = (seasonId = 2027, statSourceId = 1) => ({ seasonId, statSourceId, statSplitTypeId: 0, scoringPeriodId: 0, averageStats: { ...averages }, stats: { '42': 70 } });
const entry = (id: number, stats: unknown[]) => ({ id, player: { id, fullName: 'Nikola Jokic', stats } });

test('ESPN accepts only current-season projections and preserves projected games', () => {
  const result = extractEspnDraftProjections({ players: [entry(1, [record()]), entry(2, [record(2026, 0)]), entry(3, [record(2027, 0)])] }, 2027, catalog, importedAt);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].games, 70);
  assert.match(result.warnings.join(' '), /Actual statistics were not substituted/);
  assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [record(2026, 0)])] }, 2027, catalog), /did not return complete projections/);
  assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [{ ...record(), scoringPeriodId: 4 }])] }, 2027, catalog), /did not return complete projections/);
  assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [{ ...record(), stats: { '42': 83 } }])] }, 2027, catalog), /did not return complete projections/);
});

test('ESPN excludes incomplete projections and rejects duplicated identities or conflicting projection records', () => {
  const bad = record(); delete (bad.averageStats as Record<string, unknown>)['13'];
  const result = extractEspnDraftProjections({ players: [entry(1, [record()]), entry(2, [bad])] }, 2027, catalog);
  assert.equal(result.players.length, 1);
  assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [record()]), entry(1, [record()])] }, 2027, catalog), /duplicate/);
  assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [record(), record()])] }, 2027, catalog), /conflicting full-season/);
});

test('saved browser datasets are revalidated for finite complete stats and unique player identity', () => {
  const dataset = importDraftProjections(options(`${titles}\n${line}`));
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, true);
  dataset.players.push({ ...dataset.players[0] });
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, false);
  dataset.players.pop(); dataset.players[0].stats.fga = Infinity;
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, false);
});
