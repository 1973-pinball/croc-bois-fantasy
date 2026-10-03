import { extractPlayoffSeason } from './playoff-history';

export interface LotteryStanding {
  espnTeamId: number;
  franchiseId: string;
  managerLabel: string;
  displayName: string;
  priorTeamName: string;
  regularSeasonPlace: number;
  finalPlace: number;
  record: { wins: number; losses: number; ties: number; percentage: number };
  playoffQualified: boolean;
}

export interface LotteryStandings {
  version: 1;
  leagueId: number;
  priorEspnSeasonId: number;
  priorSeasonStartYear: number;
  draftYear: number;
  standings: LotteryStanding[];
  managerSource: {
    espnSeasonId: number; sha256: string; url: string; capturedAt: string;
    description: string; paths: string[];
  };
  source: {
    sha256: string;
    url: string;
    capturedAt: string;
    description: string;
    paths: string[];
    firstChampionshipMatchupPeriod: number;
    qualifyingMatchupIds: number[];
    championshipMatchupId: number;
    finalPlacementMatchups: {
      id: number; winnerEspnTeamId: number; loserEspnTeamId: number;
      winnerPlace: number; loserPlace: number;
    }[];
  };
}

type Source = { sha256: string; url: string; capturedAt: string };
type CurrentParticipant = { espnTeamId: number; franchiseId: string };
export type ReviewedLotteryManager = { espnTeamId: number; managerLabel: string; espnFirstName: string };
type Options = {
  leagueId: number; draftYear: number; currentParticipants: readonly CurrentParticipant[];
  reviewedManagers: readonly ReviewedLotteryManager[];
  currentSeason: { raw: unknown; source: Source };
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function regularSeasonRecord(value: unknown): LotteryStanding['record'] {
  const overall = record(record(value, 'Team record').overall, 'Overall record');
  const values = [overall.wins, overall.losses, overall.ties];
  if (values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Regular-season W/L/T must be non-negative integers.');
  const [wins, losses, ties] = values as number[];
  const total = wins + losses + ties;
  if (!total || typeof overall.percentage !== 'number' || !Number.isFinite(overall.percentage)
    || Math.abs(overall.percentage - (wins + ties / 2) / total) > 1e-12) throw new Error('Regular-season percentage must agree with the observed W/L/T record.');
  return { wins, losses, ties, percentage: overall.percentage };
}

function checkedSource(source: Source, leagueId: number, seasonId: number): Source {
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) throw new Error('Verified source SHA256 is required.');
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error('Invalid source URL.'); }
  if (url.protocol !== 'https:' || !['fantasy.espn.com', 'lm-api-reads.fantasy.espn.com'].includes(url.hostname)
    || url.username || url.password || url.hash || url.port
    || url.pathname !== `/apis/v3/games/fba/seasons/${seasonId}/segments/0/leagues/${leagueId}`) throw new Error('Source URL must identify the matching ESPN season without credentials.');
  const allowedViews = new Set(['mTeam', 'mSettings', 'mMatchup', 'mMatchupScore', 'mStandings', 'mRoster']);
  for (const [key, value] of url.searchParams) {
    if (key !== 'view' || !allowedViews.has(value)) throw new Error('Unsupported source URL query parameter.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(source.capturedAt) || !Number.isFinite(Date.parse(source.capturedAt))) throw new Error('Source capture time must be an ISO timestamp.');
  return { sha256: source.sha256.toLowerCase(), url: url.href, capturedAt: new Date(source.capturedAt).toISOString() };
}

/** Official final ranks supply finishing places; the actual championship bracket supplies qualification. */
export function extractLotteryStandings(raw: unknown, source: Source, options: Options): LotteryStandings {
  const payload = record(raw, 'ESPN season');
  const leagueId = positiveInteger(payload.id, 'ESPN league ID');
  const seasonId = positiveInteger(payload.seasonId, 'ESPN season ID');
  if (leagueId !== options.leagueId || seasonId !== options.draftYear || seasonId < 2000 || seasonId > 2100) throw new Error('The prior ESPN season must match the league and following draft year.');
  const provenance = checkedSource(source, leagueId, seasonId);
  const participants = options.currentParticipants;
  if (participants.length !== 8 || new Set(participants.map(team => team.espnTeamId)).size !== 8
    || new Set(participants.map(team => team.franchiseId)).size !== 8
    || participants.some(team => !Number.isSafeInteger(team.espnTeamId) || team.espnTeamId < 1
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(team.franchiseId))) throw new Error('Exactly eight current participants with distinct ESPN IDs and franchise UUIDs are required.');
  const current = record(options.currentSeason.raw, 'Current ESPN season');
  if (current.id !== leagueId || current.seasonId !== seasonId + 1) throw new Error('Manager evidence must come from the upcoming ESPN season for this league.');
  const managerSource = checkedSource(options.currentSeason.source, leagueId, seasonId + 1);
  if (!Array.isArray(current.teams) || current.teams.length !== 8 || !Array.isArray(current.members)) throw new Error('Complete current team and manager evidence is required.');
  const currentTeams = current.teams.map(value => record(value, 'Current team'));
  const currentMembers = current.members.map(value => record(value, 'Current manager'));
  if (new Set(currentTeams.map(team => team.id)).size !== 8 || currentTeams.some(team => !participants.some(participant => participant.espnTeamId === team.id))) throw new Error('Current ESPN participants do not match the eight mapped franchises.');
  if (new Set(currentMembers.map(member => member.id)).size !== currentMembers.length) throw new Error('Duplicate current ESPN manager evidence.');
  if (options.reviewedManagers.length !== 8 || new Set(options.reviewedManagers.map(manager => manager.espnTeamId)).size !== 8
    || options.reviewedManagers.some(manager => !manager.managerLabel.trim() || !manager.espnFirstName.trim()
      || !participants.some(team => team.espnTeamId === manager.espnTeamId))) throw new Error('An explicit reviewed manager label is required for each current franchise.');
  if (!Array.isArray(payload.teams) || payload.teams.length !== 8) throw new Error('A complete eight-team final standing is required.');
  const status = record(payload.status, 'ESPN season status');
  if (positiveInteger(payload.scoringPeriodId, 'Recorded scoring period') <= positiveInteger(status.finalScoringPeriod, 'Final scoring period')) throw new Error('The captured ESPN season has not passed its final scoring period.');
  const teams = payload.teams.map(value => record(value, 'ESPN team'));
  const standings = teams.map(team => {
    const espnTeamId = positiveInteger(team.id, 'ESPN team ID');
    const participant = participants.find(current => current.espnTeamId === espnTeamId);
    if (!participant) throw new Error('Historical participants do not match the current eight franchises.');
    const finalPlace = positiveInteger(team.rankCalculatedFinal, 'Official final place');
    const regularSeasonPlace = positiveInteger(team.playoffSeed, 'Official regular-season place');
    const currentTeam = currentTeams.find(current => current.id === espnTeamId)!;
    const reviewedManager = options.reviewedManagers.find(manager => manager.espnTeamId === espnTeamId)!;
    // Validate the explicitly chosen label against every current owner, including
    // co-managers. Do not assume primaryOwner is the user's preferred display name.
    if (!Array.isArray(currentTeam.owners) || !currentTeam.owners.some(owner => currentMembers.some(member => member.id === owner && member.firstName === reviewedManager.espnFirstName))) throw new Error(`Reviewed manager does not match current ESPN owners for team ${espnTeamId}.`);
    if (typeof currentTeam.name !== 'string' || !currentTeam.name.trim() || typeof team.name !== 'string' || !team.name.trim()) throw new Error('Current and prior team names are required.');
    return { espnTeamId, franchiseId: participant.franchiseId, managerLabel: reviewedManager.managerLabel,
      displayName: currentTeam.name, priorTeamName: team.name, regularSeasonPlace, finalPlace,
      record: regularSeasonRecord(team.record), playoffQualified: false };
  });
  if (new Set(standings.map(team => team.espnTeamId)).size !== 8 || new Set(standings.map(team => team.finalPlace)).size !== 8 || standings.some(team => team.finalPlace > 8)) throw new Error('Final places and participants must each cover 1–8 exactly once.');
  if (new Set(standings.map(team => team.regularSeasonPlace)).size !== 8 || standings.some(team => team.regularSeasonPlace > 8)) throw new Error('Regular-season places must cover 1–8 exactly once.');
  const ordered = [...standings].sort((a, b) => a.regularSeasonPlace - b.regularSeasonPlace);
  if (ordered.some((team, index) => index > 0 && team.record.percentage > ordered[index - 1].record.percentage + 1e-12)) throw new Error('Official regular-season places conflict with the observed W/L/T percentages.');

  // The historical extractor uses canonical numeric franchise IDs. Convert to
  // current UUIDs only after proving the complete participant mapping above.
  // The full capture URL includes mRoster, validated separately above.
  const numericMapping = Object.fromEntries(participants.map(team => [String(team.espnTeamId), String(team.espnTeamId)]));
  const playoff = extractPlayoffSeason(raw, numericMapping, { leagueId, sourceSha256: provenance.sha256, capturedAt: provenance.capturedAt });
  const championship = playoff.source.championship;
  if (!championship || !playoff.championFranchiseId) throw new Error('Completed championship evidence is required for final standings.');
  standings.forEach(team => { team.playoffQualified = playoff.qualifiedFranchiseIds.includes(String(team.espnTeamId)); });
  if (standings.some(team => team.playoffQualified !== (team.finalPlace <= 4) || team.playoffQualified !== (team.regularSeasonPlace <= 4)) || standings.find(team => team.finalPlace === 1)?.espnTeamId !== championship.winnerEspnTeamId) throw new Error('Official places conflict with the championship bracket.');

  const schedule = payload.schedule as unknown[];
  const finals = schedule.map((value, index) => ({ game: record(value, 'ESPN matchup'), index }))
    .filter(({ game }) => game.matchupPeriodId === championship.matchupPeriod && game.playoffTierType !== 'NONE');
  if (finals.length !== 4) throw new Error('All four completed placement games are required.');
  const placementMatchups = finals.map(({ game }) => {
    const home = positiveInteger(record(game.home, 'Home side').teamId, 'Home team');
    const away = positiveInteger(record(game.away, 'Away side').teamId, 'Away team');
    if (game.winner !== 'HOME' && game.winner !== 'AWAY') throw new Error('Every placement game must have a declared winner.');
    const winnerEspnTeamId = game.winner === 'HOME' ? home : away;
    const loserEspnTeamId = game.winner === 'HOME' ? away : home;
    const winnerPlace = standings.find(team => team.espnTeamId === winnerEspnTeamId)?.finalPlace;
    const loserPlace = standings.find(team => team.espnTeamId === loserEspnTeamId)?.finalPlace;
    if (winnerPlace === undefined || loserPlace === undefined || winnerPlace % 2 !== 1 || loserPlace !== winnerPlace + 1) throw new Error('Placement-game results conflict with official final places.');
    return { id: positiveInteger(game.id, 'Placement matchup ID'), winnerEspnTeamId, loserEspnTeamId, winnerPlace, loserPlace };
  }).sort((a, b) => a.winnerPlace - b.winnerPlace);
  if (new Set(placementMatchups.flatMap(game => [game.winnerEspnTeamId, game.loserEspnTeamId])).size !== 8 || new Set(placementMatchups.map(game => game.id)).size !== 4) throw new Error('Placement games must cover each current franchise exactly once.');

  return { version: 1, leagueId, priorEspnSeasonId: seasonId, priorSeasonStartYear: seasonId - 1, draftYear: seasonId,
    standings: ordered,
    managerSource: { ...managerSource, espnSeasonId: seasonId + 1,
      description: 'Current team names and manager assignments were verified against the upcoming ESPN season. Display labels were explicitly confirmed by the commissioner on 2026-10-03: Jon means Jonathan, Arod means Anthony, and Amber is the chosen label among the current co-managers of team 6. Account identifiers are not published.',
      paths: ['id', 'seasonId', 'teams[].{id,name,owners}', 'members[].{id,firstName}'],
    }, source: { ...provenance,
      description: 'Regular-season places are ESPN teams[].playoffSeed, checked against record.overall W/L/T and percentage. Postseason finalPlace is rankCalculatedFinal, corroborated by all four completed placement games. Playoff qualification comes separately from the first complete WINNERS_BRACKET round. Lottery configuration uses regular-season places from last to first.',
      paths: [...new Set(['status.finalScoringPeriod', 'scoringPeriodId', 'teams[].{name,playoffSeed,rankCalculatedFinal}', 'teams[].record.overall.{wins,losses,ties,percentage}',
        ...playoff.source.paths.filter(value => !value.includes('record.overall.wins')),
        ...finals.map(({ index }) => `schedule[${index}].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}`)])],
      firstChampionshipMatchupPeriod: playoff.firstChampionshipMatchupPeriod,
      qualifyingMatchupIds: playoff.source.matchups.map(game => game.id), championshipMatchupId: championship.id,
      finalPlacementMatchups: placementMatchups,
    } };
}
