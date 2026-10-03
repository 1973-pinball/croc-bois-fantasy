import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import identities from '../../data/identities.json';
import published from '../../data/lottery-standings.json';
import { buildLotteryStandings, reviewedManagers2026 } from '../../scripts/build-lottery-standings';
import { extractLotteryStandings } from '../../src/lib/lottery-standings';

const participants = Object.entries(identities.franchises).map(([id, franchiseId]) => ({ espnTeamId: Number(id), franchiseId }));
const source = { sha256: 'a'.repeat(64), url: 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935?view=mTeam&view=mMatchup&view=mRoster', capturedAt: '2026-10-03T15:58:26.024Z' };
const finalOrder = [2, 7, 6, 1, 4, 8, 3, 5];
const regularOrder = [7, 6, 2, 1, 8, 5, 4, 3];
function currentFixture() {
  return { id: 139935, seasonId: 2027,
    teams: participants.map(({ espnTeamId }) => ({ id: espnTeamId, name: `Current team ${espnTeamId}`,
      owners: espnTeamId === 6 ? ['PRIVATE_CO_OWNER', `PRIVATE_OWNER_${espnTeamId}`] : [`PRIVATE_OWNER_${espnTeamId}`], primaryOwner: espnTeamId === 6 ? 'PRIVATE_CO_OWNER' : `PRIVATE_OWNER_${espnTeamId}` })),
    members: [...reviewedManagers2026.map(manager => ({ id: `PRIVATE_OWNER_${manager.espnTeamId}`, firstName: manager.espnFirstName, lastName: 'PRIVATE_LAST_NAME' })),
      { id: 'PRIVATE_CO_OWNER', firstName: 'Justin', lastName: 'PRIVATE_LAST_NAME' }],
  };
}
const options = { leagueId: 139935, draftYear: 2026, currentParticipants: participants, reviewedManagers: reviewedManagers2026,
  currentSeason: { raw: currentFixture(), source: { ...source, sha256: 'b'.repeat(64), url: source.url.replace('/2026/', '/2027/') } } };
function fixture() {
  return { id: 139935, seasonId: 2026, scoringPeriodId: 175, status: { finalScoringPeriod: 160 },
    settings: { scheduleSettings: { playoffTeamCount: 4 } }, members: [{ secret: 'PRIVATE_MEMBER_SENTINEL' }],
    teams: participants.map(({ espnTeamId }) => {
      const seed = regularOrder.indexOf(espnTeamId) + 1, wins = 90 - seed * 10;
      return { id: espnTeamId, name: `Prior team ${espnTeamId}`, rankCalculatedFinal: finalOrder.indexOf(espnTeamId) + 1,
        playoffSeed: seed, record: { overall: { wins, losses: 100 - wins, ties: 0, percentage: wins / 100 } }, owner: 'PRIVATE_OWNER_SENTINEL' };
    }),
    schedule: [
      { id: 73, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', winner: 'HOME', home: { teamId: 7 }, away: { teamId: 1 } },
      { id: 74, matchupPeriodId: 19, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 6 }, away: { teamId: 2 } },
      { id: 77, matchupPeriodId: 20, playoffTierType: 'WINNERS_BRACKET', winner: 'AWAY', home: { teamId: 7 }, away: { teamId: 2 } },
      { id: 78, matchupPeriodId: 20, playoffTierType: 'WINNERS_CONSOLATION_LADDER', winner: 'HOME', home: { teamId: 6 }, away: { teamId: 1 } },
      { id: 79, matchupPeriodId: 20, playoffTierType: 'LOSERS_CONSOLATION_LADDER', winner: 'AWAY', home: { teamId: 8 }, away: { teamId: 4 } },
      { id: 80, matchupPeriodId: 20, playoffTierType: 'LOSERS_CONSOLATION_LADDER', winner: 'AWAY', home: { teamId: 5 }, away: { teamId: 3 } },
    ],
  };
}

test('regular-season places, postseason places and actual championship qualification stay distinct', () => {
  const extracted = extractLotteryStandings(fixture(), source, options);
  assert.deepEqual(extracted.standings.map(team => team.espnTeamId), regularOrder);
  assert.deepEqual(extracted.standings.map(team => team.regularSeasonPlace), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...extracted.standings].sort((a, b) => a.finalPlace - b.finalPlace).map(team => team.espnTeamId), finalOrder);
  assert.deepEqual(extracted.standings.filter(team => team.playoffQualified).map(team => team.espnTeamId).sort(), [1, 2, 6, 7]);
  assert.equal(extracted.standings[0].franchiseId, identities.franchises['7']);
  assert.equal(extracted.draftYear, 2026); assert.equal(extracted.priorSeasonStartYear, 2025);
  assert.deepEqual(extracted.source.qualifyingMatchupIds, [73, 74]);
  assert.equal(extracted.source.championshipMatchupId, 77);
  assert.deepEqual(extracted.source.finalPlacementMatchups.map(game => [game.winnerPlace, game.loserPlace]), [[1, 2], [3, 4], [5, 6], [7, 8]]);
  assert.doesNotMatch(JSON.stringify(extracted), /PRIVATE_|primaryOwner|lastName|notificationSettings|\.local/);
  assert.equal(extracted.standings.find(team => team.espnTeamId === 6)?.managerLabel, 'Amber');
  assert.equal(extracted.managerSource.espnSeasonId, 2027);
  assert.deepEqual(published.standings.map(team => [team.espnTeamId, team.regularSeasonPlace, team.finalPlace, team.managerLabel]),
    extracted.standings.map(team => [team.espnTeamId, team.regularSeasonPlace, team.finalPlace, team.managerLabel]));
  assert.equal(published.standings.find(team => team.espnTeamId === 4)?.displayName, 'The ManyFacedBron');
  assert.equal(published.standings.find(team => team.espnTeamId === 4)?.priorTeamName, 'Luka Deez Nuts');
});

test('incomplete, provisional and contradictory standings fail instead of substituting regular-season wins', () => {
  const duplicateRank = fixture(); duplicateRank.teams[0].rankCalculatedFinal = 1;
  assert.throws(() => extractLotteryStandings(duplicateRank, source, options), /cover 1–8/);
  const missingRank = fixture(); missingRank.teams[0].rankCalculatedFinal = 0;
  assert.throws(() => extractLotteryStandings(missingRank, source, options), /Official final place/);
  const unfinished = fixture(); unfinished.scoringPeriodId = 160;
  assert.throws(() => extractLotteryStandings(unfinished, source, options), /final scoring period/);
  const bracketConflict = fixture(); [bracketConflict.teams[0].rankCalculatedFinal, bracketConflict.teams[2].rankCalculatedFinal] = [7, 4];
  assert.throws(() => extractLotteryStandings(bracketConflict, source, options), /conflict with the championship/);
  const noFinal = fixture(); noFinal.schedule.find(game => game.id === 77)!.winner = 'UNDECIDED';
  assert.throws(() => extractLotteryStandings(noFinal, source, options), /Completed championship/);
  const wrongPlacement = fixture(); wrongPlacement.schedule.find(game => game.id === 80)!.winner = 'HOME';
  assert.throws(() => extractLotteryStandings(wrongPlacement, source, options), /Placement-game results/);
  const missingPlacement = fixture(); missingPlacement.schedule.pop();
  assert.throws(() => extractLotteryStandings(missingPlacement, source, options), /four completed placement/);
});

test('participant changes, wrong seasons and unsafe provenance cannot silently reach the lottery', () => {
  const changed = fixture(); changed.teams[0].id = 9;
  assert.throws(() => extractLotteryStandings(changed, source, options), /do not match the current/);
  assert.throws(() => extractLotteryStandings(fixture(), source, { ...options, currentParticipants: participants.slice(1) }), /eight current/);
  assert.throws(() => extractLotteryStandings(fixture(), source, { ...options, currentParticipants: participants.map(team => ({ ...team, franchiseId: participants[0].franchiseId })) }), /distinct ESPN IDs/);
  assert.throws(() => extractLotteryStandings({ ...fixture(), seasonId: 2025 }, source, options), /following draft year/);
  assert.throws(() => extractLotteryStandings(fixture(), { ...source, url: `${source.url}&token=PRIVATE_TOKEN` }, options), /Unsupported source URL/);
  assert.throws(() => extractLotteryStandings(fixture(), { ...source, url: source.url.replace('/2026/', '/2025/') }, options), /matching ESPN season/);
  assert.throws(() => extractLotteryStandings(fixture(), { ...source, sha256: 'unverified' }, options), /source SHA256/);
});

test('regular-season records and reviewed current managers are required, without assuming a primary owner', () => {
  const wrongPercentage = fixture(); wrongPercentage.teams[0].record.overall.percentage = 0.999;
  assert.throws(() => extractLotteryStandings(wrongPercentage, source, options), /percentage must agree/);
  const wrongOrder = fixture(); [wrongOrder.teams[0].playoffSeed, wrongOrder.teams[1].playoffSeed] = [3, 4];
  assert.throws(() => extractLotteryStandings(wrongOrder, source, options), /places conflict with the observed/);
  const missingSeed = fixture(); missingSeed.teams[0].playoffSeed = 0;
  assert.throws(() => extractLotteryStandings(missingSeed, source, options), /Official regular-season place/);
  const missingAmber = currentFixture(); missingAmber.teams.find(team => team.id === 6)!.owners = ['PRIVATE_CO_OWNER'];
  assert.throws(() => extractLotteryStandings(fixture(), source, { ...options, currentSeason: { ...options.currentSeason, raw: missingAmber } }), /Reviewed manager does not match/);
  const replacedCurrentTeam = currentFixture(); replacedCurrentTeam.teams[0].id = 99;
  assert.throws(() => extractLotteryStandings(fixture(), source, { ...options, currentSeason: { ...options.currentSeason, raw: replacedCurrentTeam } }), /Current ESPN participants/);
  assert.throws(() => extractLotteryStandings(fixture(), source, { ...options, currentSeason: { ...options.currentSeason, raw: { ...currentFixture(), seasonId: 2026 } } }), /upcoming ESPN season/);
});

test('the public artifact builder verifies exact source bytes before publishing only allowlisted evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lottery-standings-'));
  try {
    const raw = JSON.stringify(fixture());
    await writeFile(path.join(directory, 'espn-2026.json'), raw);
    const evidence = { ...source, sha256: createHash('sha256').update(raw).digest('hex') };
    await writeFile(path.join(directory, 'espn-2026.source.json'), JSON.stringify(evidence));
    const currentRaw = JSON.stringify(currentFixture());
    await writeFile(path.join(directory, 'espn-2027.json'), currentRaw);
    await writeFile(path.join(directory, 'espn-2027.source.json'), JSON.stringify({ ...options.currentSeason.source, sha256: createHash('sha256').update(currentRaw).digest('hex') }));
    const output = path.join(directory, 'standings.json');
    assert.equal((await buildLotteryStandings(directory, output)).participants, 8);
    const result = await readFile(output, 'utf8');
    assert.doesNotMatch(result, /PRIVATE_|primaryOwner|lastName|notificationSettings/);
    await writeFile(path.join(directory, 'espn-2026.json'), `${raw}\n`);
    await assert.rejects(buildLotteryStandings(directory, output), /source hash mismatch/);
    assert.equal(await readFile(output, 'utf8'), result);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
