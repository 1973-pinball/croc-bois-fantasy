import { validatePlayoffSeason, type PlayoffSeason, type StatisticsOnlySeason } from './playoff-history';

/** Never turn a missing season into zero titles or zero wins. */
export function summarizeLeagueHistory(seasons: readonly PlayoffSeason[], expectedYears: readonly number[], statistics: readonly StatisticsOnlySeason[] = []) {
  if (new Set(expectedYears).size !== expectedYears.length || new Set(seasons.map(season => season.espnSeasonId)).size !== seasons.length || new Set(statistics.map(season => season.espnSeasonId)).size !== statistics.length) {
    throw new Error('League history contains duplicate seasons.');
  }
  seasons.forEach(validatePlayoffSeason);
  const selected = expectedYears.flatMap(year => seasons.filter(season => season.espnSeasonId === year));
  const selectedStats = expectedYears.flatMap<PlayoffSeason | StatisticsOnlySeason>(year => {
    const full = seasons.find(season => season.espnSeasonId === year);
    const stats = statistics.find(season => season.espnSeasonId === year);
    if (stats && (stats.qualificationStatus !== 'unverified' || stats.participants.length < 2 || new Set(stats.participants.map(team => team.franchiseId)).size !== stats.participants.length || stats.participants.some(team => team.regularSeasonWins !== undefined && (!Number.isSafeInteger(team.regularSeasonWins) || team.regularSeasonWins < 0)))) throw new Error('Season statistics require review.');
    if (full && stats && JSON.stringify(full.participants.map(team => team.franchiseId).sort()) !== JSON.stringify(stats.participants.map(team => team.franchiseId).sort())) throw new Error('Season participant records disagree.');
    return stats ? [stats] : full ? [full] : [];
  });
  const championshipYears = selected.filter(season => season.championFranchiseId !== undefined).length;
  const winsYears = selectedStats.filter(season => season.participants.every(team => team.regularSeasonWins !== undefined)).length;
  const championshipsComplete = expectedYears.length > 0 && championshipYears === expectedYears.length;
  const winsComplete = expectedYears.length > 0 && winsYears === expectedYears.length;
  const titles = new Map<string, number>();
  const wins = new Map<string, number>();
  for (const season of selected) {
    if (season.championFranchiseId) titles.set(season.championFranchiseId, (titles.get(season.championFranchiseId) || 0) + 1);
  }
  for (const season of selectedStats) {
    for (const team of season.participants) {
      if (team.regularSeasonWins !== undefined) wins.set(team.franchiseId, (wins.get(team.franchiseId) || 0) + team.regularSeasonWins);
    }
  }
  const rows = (totals: Map<string, number>) => [...totals].map(([franchiseId, count]) => ({ franchiseId, count }));
  return {
    championshipsComplete, championshipYears, winsComplete, winsYears,
    championships: championshipsComplete ? rows(titles) : [],
    wins: winsComplete ? rows(wins) : undefined,
  };
}
