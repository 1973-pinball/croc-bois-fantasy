import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculateLuckbox, extractPlayoffSeason, validatePlayoffSeason } from '../../src/lib/playoff-history';
import { importPlayoffHistory } from '../../scripts/import-playoff-history';

const mapping = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), String(index + 1)]));
const provenance = { leagueId: 139935, sourceSha256: 'a'.repeat(64) };
function fixture(seasonId = 2026) {
  return {
    id: 139935, seasonId, members: [{ secret: 'PRIVATE_MEMBER_SENTINEL' }],
    settings: { scheduleSettings: { playoffTeamCount: 4 } },
    teams: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, rankCalculatedFinal: index + 1, playoffSeed: 8 - index, owner: 'PRIVATE_OWNER_SENTINEL' })),
    schedule: [
      { id: 77, matchupPeriodId: 20, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 7 }, away: { teamId: 2 } },
      { id: 75, matchupPeriodId: 19, playoffTierType: 'LOSERS_CONSOLATION_LADDER', home: { teamId: 8 }, away: { teamId: 5 } },
      { id: 73, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 7 }, away: { teamId: 1 } },
      { id: 78, matchupPeriodId: 20, playoffTierType: 'WINNERS_CONSOLATION_LADDER', home: { teamId: 6 }, away: { teamId: 1 } },
      { id: 74, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', home: { teamId: 6 }, away: { teamId: 2 } },
    ],
  };
}
const orders = (season: number) => [2, 3, 7, 8, 1, 4, 5, 6].map((id, index) => ({ season, franchiseId: String(id), position: index + 1 }));

test('qualifiers come from complete first championship round, not finals, seeds, or consolation', () => {
  const result = extractPlayoffSeason(fixture(), mapping, provenance);
  assert.deepEqual(result.qualifiedFranchiseIds, ['1', '2', '6', '7']);
  assert.equal(result.firstChampionshipMatchupPeriod, 19);
  assert.equal(result.draftYear, 2026); assert.equal(result.priorSeasonStartYear, 2025);
  assert.equal(result.participants.length, 8);
  assert.equal(result.participants.find(team => team.franchiseId === '8')?.qualified, false);
  assert.deepEqual(result.source.matchups.map(matchup => matchup.id), [73, 74]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|members|rankCalculatedFinal|playoffSeed/);
  validatePlayoffSeason(result);
});

test('missing brackets, byes, duplicate teams/games, unknown mappings and wrong leagues fail review', () => {
  const noBracket = fixture(); noBracket.schedule = noBracket.schedule.filter(game => game.playoffTierType !== 'WINNERS_BRACKET');
  assert.throws(() => extractPlayoffSeason(noBracket, mapping, provenance), /No championship bracket/);
  const bye = fixture(); bye.schedule = bye.schedule.filter(game => game.id !== 74);
  assert.throws(() => extractPlayoffSeason(bye, mapping, provenance), /exactly two/);
  const duplicate = fixture(); duplicate.schedule.find(game => game.id === 74)!.away.teamId = 1;
  assert.throws(() => extractPlayoffSeason(duplicate, mapping, provenance), /Duplicate first-round/);
  const duplicatedId = fixture(); duplicatedId.schedule.find(game => game.id === 74)!.id = 73;
  assert.throws(() => extractPlayoffSeason(duplicatedId, mapping, provenance), /Duplicate championship matchup/);
  const unknown = fixture(); unknown.schedule.find(game => game.id === 74)!.away.teamId = 99;
  assert.throws(() => extractPlayoffSeason(unknown, mapping, provenance), /known, distinct/);
  assert.throws(() => extractPlayoffSeason(fixture(), { '1': '1' }, provenance), /Mapping/);
  assert.throws(() => extractPlayoffSeason(fixture(), { ...mapping, '2': '1' }, provenance), /Duplicate mapped/);
  assert.throws(() => extractPlayoffSeason({ ...fixture(), id: 99 }, mapping, provenance), /league ID/);
  const six = fixture(); six.settings.scheduleSettings.playoffTeamCount = 6;
  assert.throws(() => extractPlayoffSeason(six, mapping, provenance), /four-team/);
});

test('only verified qualification plus original top-four slots scores; ties share a complete award', () => {
  const qualification = extractPlayoffSeason(fixture(2018), mapping, provenance);
  const result = calculateLuckbox(orders(2018), [qualification]);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.winners, [{ franchiseId: '2', value: 1, seasons: [2018] }, { franchiseId: '7', value: 1, seasons: [2018] }]);
  assert.equal(result.evidence.find(row => row.franchiseId === '3')?.countsForAward, false);
  assert.equal(result.evidence.find(row => row.franchiseId === '1')?.countsForAward, false);
  assert.deepEqual(result.coveredDraftYears, [2018]);
});

test('wins stay optional and championships require a declared final between declared semifinal winners', () => {
  const raw = fixture();
  const complete = { ...raw, teams: raw.teams.map(team => ({ ...team, record: { overall: { wins: team.id === 1 ? 0 : 82 } } })), schedule: raw.schedule.map(game => ({ ...game, winner: game.id === 73 ? 'HOME' : game.id === 74 || game.id === 77 ? 'AWAY' : 'UNDECIDED' })) };
  const result = extractPlayoffSeason(complete, mapping, provenance);
  assert.equal(result.championFranchiseId, '2'); assert.equal(result.source.championship?.id, 77);
  assert.equal(result.participants[0].regularSeasonWins, 0);
  validatePlayoffSeason(result);
  assert.equal(extractPlayoffSeason(raw, mapping, provenance).championFranchiseId, undefined);
  assert.equal(extractPlayoffSeason(raw, mapping, provenance).participants[0].regularSeasonWins, undefined);
  const missingSemiWinner = structuredClone(complete); missingSemiWinner.schedule.find(game => game.id === 74)!.winner = 'UNDECIDED';
  assert.equal(extractPlayoffSeason(missingSemiWinner, mapping, provenance).championFranchiseId, undefined);
  const wrongFinal = structuredClone(complete); wrongFinal.schedule.find(game => game.id === 77)!.away.teamId = 1;
  assert.equal(extractPlayoffSeason(wrongFinal, mapping, provenance).championFranchiseId, undefined);
  const tampered = structuredClone(result); tampered.championFranchiseId = '7';
  assert.throws(() => validatePlayoffSeason(tampered), /Champion must be proven/);
});

test('unknown years are not zero; missing coverage suppresses the all-time winner', () => {
  const qualification = extractPlayoffSeason(fixture(2018), mapping, provenance);
  const partial = calculateLuckbox([...orders(2018), ...orders(2019)], [qualification]);
  assert.equal(partial.status, 'insufficient-data'); assert.deepEqual(partial.winners, []);
  assert.deepEqual(partial.coveredDraftYears, [2018]); assert.deepEqual(partial.missingDraftYears, [2019]);
  assert.equal(partial.evidence.some(row => row.draftYear === 2019), false);
  assert.deepEqual(calculateLuckbox(orders(2018), [extractPlayoffSeason(fixture(2026), mapping, provenance)], [2018]).coveredCounts, []);
  assert.deepEqual(calculateLuckbox([], [qualification], [2018]).missing, [{ draftYear: 2018, reason: 'draft-order' }]);
});

test('duplicate or incomplete order/season data and tampered qualification flags cannot score', () => {
  const qualification = extractPlayoffSeason(fixture(2018), mapping, provenance);
  assert.throws(() => calculateLuckbox([...orders(2018), orders(2018)[0]], [qualification]), /Duplicate draft franchise/);
  assert.throws(() => calculateLuckbox(orders(2018), [qualification, qualification]), /Duplicate playoff season/);
  assert.throws(() => calculateLuckbox(orders(2018).slice(0, 4), [qualification]), /every verified participant/);
  assert.throws(() => calculateLuckbox(orders(2018), [qualification], [2018, 2018]), /Duplicate requested/);
  const tampered = structuredClone(qualification); tampered.participants[0].qualified = false;
  assert.throws(() => validatePlayoffSeason(tampered), /disagree/);
});

test('browser envelopes and raw arrays import sanitized seasons, preserve existing years, and reject repeated input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'croc-playoff-test-'));
  try {
    const outputPath = path.join(directory, 'sanitized.json'), currentPath = path.join(directory, 'misleading-2018-filename.json');
    await writeFile(currentPath, JSON.stringify([fixture(2026)]));
    await importPlayoffHistory({ paths: [currentPath], mapping, leagueId: 139935, outputPath });
    const exportPath = path.join(directory, 'browser.json');
    await writeFile(exportPath, JSON.stringify({ source: 'espn-browser-export', leagueId: 139935, exportedAt: '2026-10-01T00:00:00Z', seasons: [{ ...fixture(2018), exportSource: { url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2018/segments/0/leagues/139935?view=mMatchup&view=mTeam&view=mSettings', fetchedAt: '2026-10-01T00:00:00Z' } }], failures: [{ seasonId: 2019, status: 401, message: 'PRIVATE_FAILURE_SENTINEL' }] }));
    const result = await importPlayoffHistory({ paths: [exportPath], mapping, leagueId: 139935, outputPath });
    assert.deepEqual(result.seasons.map(season => season.draftYear), [2018, 2026]);
    assert.equal(result.seasons[0].source.capturedAt, '2026-10-01T00:00:00.000Z');
    const text = await readFile(outputPath, 'utf8'); assert.doesNotMatch(text, /PRIVATE_|misleading|exportPath|owner/);
    const corroborationPath = path.join(directory, 'browser-current.json');
    await writeFile(corroborationPath, JSON.stringify({ source: 'espn-browser-export', leagueId: 139935, exportedAt: '2026-10-01T00:00:00Z', seasons: [{ ...fixture(2026), exportSource: { url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935?view=mMatchup', fetchedAt: '2026-10-01T00:00:00Z' } }] }));
    const corroborated = await importPlayoffHistory({ paths: [corroborationPath], mapping, leagueId: 139935, outputPath });
    assert.equal(corroborated.seasons[1].additionalSourceEvidence?.length, 1);
    assert.match(corroborated.seasons[1].additionalSourceEvidence![0].url!, /seasons\/2026/);
    assert.equal((await importPlayoffHistory({ paths: [corroborationPath], mapping, leagueId: 139935, outputPath })).seasons[1].additionalSourceEvidence?.length, 1);
    const partialPath = path.join(directory, 'partial.json'), observed = fixture(2020);
    await writeFile(partialPath, JSON.stringify({ ...observed, schedule: [], teams: observed.teams.map(team => ({ ...team, record: { overall: { wins: team.id === 1 ? 0 : 70 } } })) }));
    const partial = await importPlayoffHistory({ paths: [partialPath], mapping, leagueId: 139935, outputPath });
    assert.equal(partial.seasons.some(season => season.draftYear === 2020), false);
    assert.equal(partial.statsOnlySeasons?.[0].qualificationStatus, 'unverified');
    assert.equal(partial.statsOnlySeasons?.[0].participants[0].regularSeasonWins, 0);
    assert.doesNotMatch(JSON.stringify(partial.statsOnlySeasons), /qualified|championFranchiseId|PRIVATE_/);
    await assert.rejects(importPlayoffHistory({ paths: [exportPath, exportPath], mapping, leagueId: 139935, outputPath }), /Repeated season/);
    const wrong = path.join(directory, 'wrong.json'); await writeFile(wrong, JSON.stringify({ source: 'espn-browser-export', leagueId: 9, exportedAt: '2026-10-01T00:00:00Z', seasons: [fixture(2018)] }));
    await assert.rejects(importPlayoffHistory({ paths: [wrong], mapping, leagueId: 139935, outputPath }), /league ID/);
    assert.throws(() => extractPlayoffSeason(fixture(), mapping, { ...provenance, sourceUrl: 'https://lm-api-reads.fantasy.espn.com/?token=PRIVATE' }), /unsupported query/);
  } finally {
    const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temporaryRoot); assert.match(path.basename(resolved), /^croc-playoff-test-/);
    await rm(resolved, { recursive: true, force: true });
  }
});
