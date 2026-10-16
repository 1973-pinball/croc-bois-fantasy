import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProjectionDatasetSchema, ESPN_PROJECTION_PARSER_VERSION, extractEspnDraftProjections, importDraftProjections } from '../../src/lib/draft-projections';
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
  assert.equal(result.players[0].providerRank, undefined);
});

test('quoted CSV fields, BOM, CRLF and repeated headers are accepted', () => {
  const result = importDraftProjections(options(`\uFEFF${titles}\r\n"Test, Player",70,28,12,10,1.5,0.8,3,2,10,18,6,8\r\n${titles}`));
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].id, 2);
  assert.throws(() => importDraftProjections(options(`${titles}\n"broken`)), /closing quote/);
});

test('pasted TSV recognizes TREB and makes/attempts embedded in percent cells', () => {
  const result = importDraftProjections(options('PLAYER\tGP\tPTS\tTREB\tAST\tSTL\tBLK\tTO\t3PM\tFG%\tFT%\nNikola Jokic\t70\t28\t12\t10\t1.5\t0.8\t3\t2\t.556 (10/18)\t.750 (6/8)'));
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
  assert.equal(result.players[0].providerRank, 99);
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

const nativeTitles = 'player_id,last_name,first_name,games,minutes,field_goals_attempted,field_goals,free_throws_attempted,free_throws,threes,threes_attempted,offensive_rebounds,defensive_rebounds,assists,blocks,steals,turnovers,comments';
// Entirely synthetic totals; provider ID intentionally belongs to another ESPN player.
const nativeLine = '3,Jokic,Nikola,10,300,180,100,80,60,20,50,30,90,100,8,15,30,';

test('Basketball Monster imports supplied ranks independently of row order and preserves gaps across excluded players', () => {
  const rankedCatalog = { ...catalog, players: [...catalog.players, player(4, 'Victor Wembanyama')] };
  const wembanyama = nativeLine.replace('Jokic,Nikola', 'Wembanyama,Victor');
  const unmatched = nativeLine.replace('Jokic,Nikola', 'Unknown,Player');
  const incomplete = nativeLine.replace('Jokic,Nikola', 'Player,Other').replace(',10,300,', ',0,300,');
  const result = importDraftProjections({ ...options(`${nativeTitles},ProviderRank\n${nativeLine},2\n${unmatched},3\n${nativeTitles},ProviderRank\n${incomplete},4\n${wembanyama},1`), source: 'basketball-monster', catalog: rankedCatalog });
  assert.deepEqual(result.players.map(({ name, providerRank }) => [name, providerRank]), [['Nikola Jokić', 2], ['Victor Wembanyama', 1]]);
  assert.match(result.warnings.join(' '), /2 rows excluded/);
  for (const rankHeader of ['ProviderRank', 'BBMRank', 'Rank', 'Rk']) {
    const pasted = importDraftProjections({ ...options(`${titles},${rankHeader},ADP,Adv ADP\n${line},42,1,3\n${line.replace('Nikola Jokic', 'Victor Wembanyama')},1,99,55`), source: 'basketball-monster', catalog: rankedCatalog });
    assert.deepEqual(pasted.players.map(({ providerRank }) => providerRank), [42, 1]);
  }
  assert.throws(() => importDraftProjections({ ...options(`${titles},Rank,ProviderRank\n${line},1,2`), source: 'basketball-monster' }), /More than one providerRank column/);
});

test('native or copied Basketball Monster projections without an explicit rank remain unranked', () => {
  for (const text of [`${nativeTitles}\n${nativeLine}`, `${nativeTitles},ProviderRank\n${nativeLine},`, `${titles},ADP,Adv ADP\n${line},1,2`, `${titles},Rank\n${line},`]) {
    const result = importDraftProjections({ ...options(text), source: 'basketball-monster' });
    assert.equal(result.players[0].providerRank, undefined);
  }
  for (const rank of ['0', '1.5', '9007199254740992']) assert.throws(() => importDraftProjections({ ...options(`${nativeTitles},BBMRank\n${nativeLine},${rank}`), source: 'basketball-monster' }), /positive safe integer/);
});

test('explicit ProviderRank imports unchanged for Yahoo while absent or invalid values are handled strictly', () => {
  const ranked = importDraftProjections(options(`${titles},ProviderRank\n${line},37`));
  assert.equal(ranked.players[0].providerRank, 37);
  assert.equal(importDraftProjections(options(`${titles},ProviderRank\n${line},`)).players[0].providerRank, undefined);
  for (const rank of ['0', '1.5', '9007199254740992']) assert.throws(() => importDraftProjections(options(`${titles},ProviderRank\n${line},${rank}`)), /positive safe integer/);
  assert.throws(() => importDraftProjections(options(`${titles},ProviderRank,Provider Rank\n${line},1,2`)), /More than one providerRank column/);
  const legacy = structuredClone(ranked); delete legacy.players[0].providerRank;
  assert.equal(draftProjectionDatasetSchema.safeParse(legacy).success, true);
  for (const rank of [0, -1, 1.5, Infinity, NaN]) {
    const invalid = structuredClone(ranked); invalid.players[0].providerRank = rank;
    assert.equal(draftProjectionDatasetSchema.safeParse(invalid).success, false);
  }
});

test('native Basketball Monster CSV combines names, derives categories and automatically normalizes season totals', () => {
  const nativeOptions = { ...options(`${nativeTitles}\n${nativeLine}`), source: 'basketball-monster' as const };
  const result = importDraftProjections(nativeOptions);
  assert.equal(result.players[0].id, 1);
  assert.equal(result.players[0].name, 'Nikola Jokić');
  assert.equal(result.players[0].games, 10);
  assert.deepEqual(result.players[0].stats, { pts: 28, reb: 12, ast: 10, stl: 1.5, blk: .8, tov: 3, three: 2, fgm: 10, fga: 18, ftm: 6, fta: 8 });
  assert.match(result.warnings.join(' '), /season-total export.*automatically/);
  assert.match(result.warnings.join(' '), /PTS = 2 × field goals \+ threes \+ free throws/);
  assert.match(result.warnings.join(' '), /REB = offensive rebounds \+ defensive rebounds/);
  assert.deepEqual(importDraftProjections({ ...nativeOptions, basis: 'totals' }).players, result.players);
});

test('native detection is provider-specific and rejects mixed units or duplicate stat columns', () => {
  assert.throws(() => importDraftProjections(options(`${nativeTitles}\n${nativeLine}`)), /Player\/Name or an explicit ESPN ID/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles},p/g\n${nativeLine},28`), source: 'basketball-monster' }), /Do not mix native.*per-game/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles},FGM\n${nativeLine},100`), source: 'basketball-monster' }), /More than one fgm column/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles},first_name\n${nativeLine},Nikola`), source: 'basketball-monster' }), /More than one firstname column/);
  // Merely splitting a name does not cause an arbitrary table to be treated as season totals.
  assert.throws(() => importDraftProjections({ ...options('first_name,last_name,GP,PTS,REB,AST,STL,BLK,TO,3PM,FGM,FGA,FTM,FTA\nNikola,Jokic,10,28,12,10,1.5,.8,3,2,10,18,6,8'), source: 'basketball-monster' }), /Player\/Name or an explicit ESPN ID/);
});

test('native rows retain strict identity checks and warn for incomplete or invalid totals', () => {
  const invalidRows = [
    nativeLine.replace('3,Jokic,Nikola,', '1,Unknown,Person,'),
    nativeLine.replace(',10,300,', ',0,300,'),
    nativeLine.replace(',30,90,', ',,90,'),
    nativeLine.replace(',180,100,', ',80,100,'),
    nativeLine.replace(',Jokic,Nikola,', ',Jokic,,'),
  ];
  const result = importDraftProjections({ ...options(`${nativeTitles}\n${invalidRows.join('\n')}\n${nativeLine}`), source: 'basketball-monster' });
  assert.equal(result.players.length, 1);
  assert.match(result.warnings.join(' '), /5 rows excluded/);
  assert.match(result.warnings.join(' '), /unique ESPN ID or full name/);
  assert.match(result.warnings.join(' '), /positive GP\/Games/);
  assert.match(result.warnings.join(' '), /Offensive and defensive rebounds/);
  assert.match(result.warnings.join(' '), /Shooting makes exceed attempts/);
  assert.match(result.warnings.join(' '), /both first_name and last_name/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles}\n${nativeLine}`), source: 'basketball-monster', catalog: { ...catalog, players: [...catalog.players, player(9, 'Nikola Jokic')] } }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles},ESPN ID\n${nativeLine},3`), source: 'basketball-monster' }), /does not match the supplied ESPN ID/);
  assert.throws(() => importDraftProjections({ ...options(`${nativeTitles}\n${nativeLine}\n${nativeLine}`), source: 'basketball-monster' }), /Duplicate player projection/);
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

test('name-only imports accept unique suffix differences but preserve explicit ID and duplicate checks', () => {
  const suffixCatalog = { espnSeasonId: 2027, players: [player(7, 'Trey Murphy III'), player(8, 'Derrick Jones Jr.')] };
  const noSuffix = line.replace('Nikola Jokic', 'Trey Murphy');
  const result = importDraftProjections({ ...options(`${titles}\n${noSuffix}`), catalog: suffixCatalog });
  assert.equal(result.players[0].id, 7);
  assert.match(result.warnings.join(' '), /1 player name matched after ignoring/);
  assert.throws(() => importDraftProjections({ ...options(`${titles},ESPN ID\n${noSuffix},7`), catalog: suffixCatalog }), /does not match the supplied ESPN ID/);
  assert.throws(() => importDraftProjections({ ...options(`${titles},ESPN ID\n${noSuffix},999`), catalog: suffixCatalog }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...options(`${titles}\n${noSuffix}\n${noSuffix.replace('Trey Murphy', 'Trey Murphy III')}`), catalog: suffixCatalog }), /Duplicate player projection/);
  const native = nativeLine.replace('Jokic,Nikola', 'Jones,Derrick');
  assert.equal(importDraftProjections({ ...options(`${nativeTitles}\n${native}`), source: 'basketball-monster', catalog: suffixCatalog }).players[0].id, 8);
});

test('suffix fallback rejects catalog collisions and never guesses nicknames or ambiguous exact names', () => {
  const text = `${titles}\n${line.replace('Nikola Jokic', 'Other Player Jr.')}`;
  const ambiguousCatalog = { ...catalog, players: [...catalog.players, player(4, 'Other Player Sr.')] };
  assert.throws(() => importDraftProjections({ ...options(text), catalog: ambiguousCatalog }), /unique ESPN ID or full name/);
  assert.equal(importDraftProjections({ ...options(`${titles}\n${line.replace('Nikola Jokic', 'Other Player')}`), catalog: ambiguousCatalog }).players[0].id, 3);
  assert.throws(() => importDraftProjections(options(`${titles}\n${line.replace('Nikola Jokic', 'N. Jokic')}`)), /unique ESPN ID or full name/);
  const duplicateExact = { ...catalog, players: [...catalog.players, player(4, 'Other Player'), player(5, 'Other Player Jr.')] };
  assert.throws(() => importDraftProjections({ ...options(`${titles}\n${line.replace('Nikola Jokic', 'Other Player')}`), catalog: duplicateExact }), /unique ESPN ID or full name/);
});

const verifiedMonsterNames = [
  ['Nicolas Claxton', 'Nic Claxton'], ['Alexandre Sarr', 'Alex Sarr'], ['Herb Jones', 'Herbert Jones'],
  ['Cam Johnson', 'Cameron Johnson'], ['Lu Dort', 'Luguentz Dort'], ['Ron Holland', 'Ronald Holland II'], ['EJ Harkless', 'Elijah Harkless'],
] as const;

test('verified Basketball Monster name aliases resolve to unique catalog players without provider IDs', () => {
  const aliasCatalog = { espnSeasonId: 2027, players: verifiedMonsterNames.map(([, name], index) => player(index + 20, name)) };
  const nativeRows = verifiedMonsterNames.map(([name]) => {
    const [first, ...last] = name.split(' ');
    return nativeLine.replace('Jokic,Nikola', `${last.join(' ')},${first}`);
  });
  const result = importDraftProjections({ ...options(`${nativeTitles}\n${nativeRows.join('\n')}`), source: 'basketball-monster', catalog: aliasCatalog });
  assert.deepEqual(result.players.map(({ id, name }) => [id, name]), aliasCatalog.players.map(({ id, name }) => [id, name]));
  assert.match(result.warnings.join(' '), /7 Basketball Monster names matched through verified NBA\/team name aliases/);
  const pasted = importDraftProjections({ ...options(`${titles}\n${line.replace('Nikola Jokic', 'E.J. Harkless')}`), source: 'basketball-monster', catalog: aliasCatalog });
  assert.equal(pasted.players[0].name, 'Elijah Harkless');
});

test('BBM aliases stay source-scoped and never override explicit IDs, unknown names or ambiguous catalog identities', () => {
  const aliasCatalog = { espnSeasonId: 2027, players: [player(20, 'Nic Claxton')] };
  const aliasLine = line.replace('Nikola Jokic', 'Nicolas Claxton');
  const base = { ...options(`${titles}\n${aliasLine}`), source: 'basketball-monster' as const, catalog: aliasCatalog };
  assert.throws(() => importDraftProjections({ ...base, source: 'yahoo' }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...base, text: `${titles},ESPN ID\n${aliasLine},20` }), /does not match the supplied ESPN ID/);
  assert.throws(() => importDraftProjections({ ...base, text: `${titles},ESPN ID\n${aliasLine},999` }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...base, text: `${titles}\n${aliasLine.replace('Nicolas', 'Nick')}` }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...base, catalog: { ...aliasCatalog, players: [...aliasCatalog.players, player(21, 'Nic Claxton')] } }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...base, catalog: { ...aliasCatalog, players: [...aliasCatalog.players, player(21, 'Nicolas Claxton Jr.'), player(22, 'Nicolas Claxton Sr.')] } }), /unique ESPN ID or full name/);
  assert.throws(() => importDraftProjections({ ...base, text: `${titles}\n${aliasLine}\n${aliasLine.replace('Nicolas', 'Nic')}` }), /Duplicate player projection/);
  // An exact supplied name remains authoritative over the verified alternate-name list.
  const exact = importDraftProjections({ ...base, catalog: { ...aliasCatalog, players: [...aliasCatalog.players, player(21, 'Nicolas Claxton')] } });
  assert.equal(exact.players[0].id, 21);
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

// ESPN's October 16 Duren projection omits zero 3PM but supplies this scoring identity.
function sparseThreeRecord() {
  const result = { ...record(), averageStats: { ...averages, '0': 1458 / 72, '13': 561 / 72, '14': 857 / 72, '15': 336 / 72, '16': 454 / 72 } as Record<string, unknown>,
    stats: { '42': 72, '0': 1458, '13': 561, '14': 857, '15': 336, '16': 454 } as Record<string, unknown> };
  delete result.averageStats['17'];
  return result;
}

test('ESPN recovers an omitted zero 3PM from its own full-season scoring totals and versions the parser result', () => {
  const sparse = sparseThreeRecord(), original = structuredClone(sparse);
  const result = extractEspnDraftProjections({ players: [entry(1, [sparse])] }, 2027, catalog, importedAt);
  assert.equal(result.players[0].games, 72);
  assert.equal(result.players[0].stats.three, 0);
  assert.equal(result.players[0].stats.pts, 20.25);
  assert.equal(result.players[0].stats.fgm, 561 / 72);
  assert.equal(result.espnParserVersion, ESPN_PROJECTION_PARSER_VERSION);
  assert.equal(draftProjectionDatasetSchema.parse(result).espnParserVersion, ESPN_PROJECTION_PARSER_VERSION);
  assert.match(result.warnings.join(' '), /same projection's points/);
  assert.deepEqual(sparse, original);
});

test('ESPN can recover nonzero missing 3PM only when same-source scoring totals and averages agree', () => {
  const sparse = sparseThreeRecord();
  sparse.stats['0'] = 1530; sparse.averageStats['0'] = 1530 / 72; sparse.stats['18'] = 200;
  const result = extractEspnDraftProjections({ players: [entry(1, [sparse])] }, 2027, catalog);
  assert.equal(result.players[0].stats.three, 1);
  sparse.averageStats['17'] = 0;
  assert.equal(extractEspnDraftProjections({ players: [entry(1, [sparse])] }, 2027, catalog).players[0].stats.three, 0);
});

test('ESPN never repairs explicitly invalid 3PM or guesses missing totals, other categories, or conflicting scoring data', () => {
  const mutations: ((value: ReturnType<typeof sparseThreeRecord>) => void)[] = [
    ...[null, -1, '0', Infinity].map(value => (row: ReturnType<typeof sparseThreeRecord>) => { row.averageStats['17'] = value; }),
    ...[undefined, null, -1, 1458.5, '1458'].map(value => (row: ReturnType<typeof sparseThreeRecord>) => { row.stats['0'] = value; }),
    ...[undefined, null, 0, 83, '72'].map(value => (row: ReturnType<typeof sparseThreeRecord>) => { row.stats['42'] = value; }),
    row => { row.averageStats['0'] = 21; },
    row => { row.stats['17'] = 1; },
    row => { row.stats['18'] = -1; },
    row => { row.stats['0'] = 1400; row.averageStats['0'] = 1400 / 72; },
    row => { row.stats['0'] = 2100; row.averageStats['0'] = 2100 / 72; },
    row => { row.stats['0'] = 1530; row.averageStats['0'] = 1530 / 72; row.stats['18'] = 10; },
    row => { delete row.averageStats['1']; },
    row => { row.seasonId = 2026; },
    row => { row.statSourceId = 0; },
  ];
  for (const mutate of mutations) {
    const sparse = sparseThreeRecord(); mutate(sparse);
    assert.throws(() => extractEspnDraftProjections({ players: [entry(1, [sparse])] }, 2027, catalog), /did not return complete projections/);
  }
});

test('ESPN projections preserve current overall ROTO ranks independently of catalog ranks and statistics', () => {
  const ranked = (id: number, rank: number, published: boolean) => ({ ...entry(id, [record()]), player: { ...entry(id, [record()]).player, draftRanksByRankType: { STANDARD: { rank: 1 }, ROTO: { rank, rankType: 'ROTO', slotId: 0, published } } } });
  const result = extractEspnDraftProjections({ players: [ranked(1, 27, true), ranked(2, 9, false)] }, 2027, catalog, importedAt);
  assert.deepEqual(result.players.map(({ id, providerRank }) => [id, providerRank]), [[1, 27], [2, 9]]);
  assert.deepEqual(result.players[0].stats, { pts: 28, reb: 12, ast: 10, stl: 1.5, blk: .8, tov: 3, three: 2, fgm: 10, fga: 18, ftm: 6, fta: 8 });
  assert.equal(result.players[0].games, 70);
  assert.equal(catalog.players[0].rank, 1);
});

test('missing, positional, non-ROTO and malformed ESPN ranks leave valid projections unranked', () => {
  const validRank = { rank: 27, rankType: 'ROTO', slotId: 0 };
  const unsupportedRanks: unknown[] = [undefined, null, [], '27', {}, { ...validRank, rankType: 'STANDARD' }, { ...validRank, slotId: 1 }, { ...validRank, slotId: '0' },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '27', null].map(rank => ({ ...validRank, rank }))];
  const original = entry(1, [record()]);
  for (const ROTO of unsupportedRanks) {
    const result = extractEspnDraftProjections({ players: [{ ...original, player: { ...original.player, draftRanksByRankType: { STANDARD: validRank, ROTO } } }] }, 2027, catalog);
    assert.equal(result.players.length, 1);
    assert.equal(result.players[0].providerRank, undefined);
    assert.equal(result.players[0].stats.pts, 28);
  }
});

test('saved browser datasets are revalidated for finite complete stats and unique player identity', () => {
  const dataset = importDraftProjections(options(`${titles}\n${line}`));
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, true);
  dataset.players.push({ ...dataset.players[0] });
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, false);
  dataset.players.pop(); dataset.players[0].stats.fga = Infinity;
  assert.equal(draftProjectionDatasetSchema.safeParse(dataset).success, false);
});
