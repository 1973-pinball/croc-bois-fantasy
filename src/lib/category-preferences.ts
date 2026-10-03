import type { PreferenceSource } from './roster-position-history';

export const CATEGORY_LABELS: Record<number, string> = { 0: 'PTS', 1: 'BLK', 2: 'STL', 3: 'AST', 6: 'REB', 11: 'TO', 17: '3PM', 19: 'FG%', 20: 'FT%' };
type Category = { id: number; label: string; lowerIsBetter: boolean; wins: number; losses: number; ties: number };
export type CategoryPreferenceSeason = {
  season: number; draftYear: number; source: PreferenceSource; regularSeasonMatchupPeriods: number;
  completedMatchupPeriods: number[]; excludedUnscoredMatchups: number;
  teams: { franchiseId: string; espnTeamId: number; matchups: number; standingsMatch: boolean | null; categories: Category[] }[];
};
export type CategoryPreferences = {
  version: number; leagueId: number; coverage: { draftYears: number[]; limitations: string[] }; seasons: CategoryPreferenceSeason[];
};
type Result = 'WIN' | 'LOSS' | 'TIE';
type Stat = { score?: number; result?: string | null; ineligible?: boolean };
type Side = { teamId: number; cumulativeScore?: { scoreByStat?: Record<string, Stat> | null } };
type RawCategories = {
  id: number; seasonId: number; status?: { currentMatchupPeriod?: number };
  settings: { scoringSettings: { scoringType: string; scoringItems: { statId: number; points?: number; isReverseItem?: boolean }[] }; scheduleSettings: { matchupPeriodCount: number } };
  teams: { id: number; record?: { overall?: { wins: number; losses: number; ties: number } } }[];
  schedule: { id: number; matchupPeriodId: number; playoffTierType?: string; winner?: string; home?: Side; away?: Side }[];
};
const validResult = (value: unknown): value is Result => value === 'WIN' || value === 'LOSS' || value === 'TIE';

/** Uses ESPN's official category outcomes, which already account for reversed categories such as turnovers. */
export function extractCategoryPreferences(payload: RawCategories, source: PreferenceSource): CategoryPreferenceSeason {
  if (payload.id !== 139935 || !Number.isSafeInteger(payload.seasonId) || payload.settings.scoringSettings.scoringType !== 'H2H_CATEGORY') throw new Error('Expected this league\'s category scoring source.');
  const items = payload.settings.scoringSettings.scoringItems.filter(item => item.points !== 0);
  if (!items.length || new Set(items.map(item => item.statId)).size !== items.length) throw new Error('Missing or duplicated scoring categories.');
  const teams = payload.teams.map(team => ({ franchiseId: String(team.id), espnTeamId: team.id, matchups: 0, standingsMatch: null as boolean | null,
    categories: items.map(item => ({ id: item.statId, label: CATEGORY_LABELS[item.statId] ?? `Stat ${item.statId}`, lowerIsBetter: item.isReverseItem === true, wins: 0, losses: 0, ties: 0 })) }));
  if (teams.some(team => team.espnTeamId < 1 || team.espnTeamId > 8) || new Set(teams.map(team => team.espnTeamId)).size !== teams.length) throw new Error('Unmapped or duplicate ESPN franchise.');
  const periods = new Set<number>();
  const seen = new Set<number>();
  let excludedUnscoredMatchups = 0;
  for (const matchup of payload.schedule) {
    if (matchup.playoffTierType !== 'NONE' || matchup.matchupPeriodId > payload.settings.scheduleSettings.matchupPeriodCount) continue;
    if (seen.has(matchup.id)) throw new Error('Duplicate ESPN matchup.');
    seen.add(matchup.id);
    const { home, away } = matchup;
    const stats = [home, away].flatMap(side => items.map(item => side?.cumulativeScore?.scoreByStat?.[item.statId]));
    // Future/current periods and empty cancelled weeks are unknown, even if ESPN emits zero-score ties.
    if (!home || !away || matchup.winner === 'UNDECIDED' || matchup.matchupPeriodId >= (payload.status?.currentMatchupPeriod ?? 0)
      || !stats.some(stat => typeof stat?.score === 'number' && Number.isFinite(stat.score) && stat.score !== 0)) { excludedUnscoredMatchups += 1; continue; }
    const homeTeam = teams.find(team => team.espnTeamId === home.teamId), awayTeam = teams.find(team => team.espnTeamId === away.teamId);
    if (!homeTeam || !awayTeam || home.teamId === away.teamId) throw new Error('Unmapped matchup participant.');
    const outcomes = items.flatMap(item => {
      const homeStat = home.cumulativeScore?.scoreByStat?.[item.statId], awayStat = away.cumulativeScore?.scoreByStat?.[item.statId];
      if (!validResult(homeStat?.result) || !validResult(awayStat?.result) || homeStat?.ineligible || awayStat?.ineligible
        || typeof homeStat.score !== 'number' || !Number.isFinite(homeStat.score) || typeof awayStat.score !== 'number' || !Number.isFinite(awayStat.score)) return [];
      if (!((homeStat.result === 'WIN' && awayStat.result === 'LOSS') || (homeStat.result === 'LOSS' && awayStat.result === 'WIN') || (homeStat.result === 'TIE' && awayStat.result === 'TIE'))) throw new Error('Inconsistent ESPN category outcomes.');
      return [{ id: item.statId, home: homeStat.result, away: awayStat.result }];
    });
    if (!outcomes.length) { excludedUnscoredMatchups += 1; continue; }
    periods.add(matchup.matchupPeriodId); homeTeam.matchups += 1; awayTeam.matchups += 1;
    for (const outcome of outcomes) for (const [team, result] of [[homeTeam, outcome.home], [awayTeam, outcome.away]] as const) {
      const category = team.categories.find(category => category.id === outcome.id)!;
      if (result === 'WIN') category.wins += 1;
      else if (result === 'LOSS') category.losses += 1;
      else category.ties += 1;
    }
  }
  for (const team of teams) {
    const record = payload.teams.find(sourceTeam => sourceTeam.id === team.espnTeamId)?.record?.overall;
    if (record && team.matchups > 0) team.standingsMatch = ['wins', 'losses', 'ties'].every(key => team.categories.reduce((sum, category) => sum + category[key as 'wins' | 'losses' | 'ties'], 0) === record[key as 'wins' | 'losses' | 'ties']);
  }
  return { season: payload.seasonId, draftYear: payload.seasonId - 1, source, regularSeasonMatchupPeriods: payload.settings.scheduleSettings.matchupPeriodCount,
    completedMatchupPeriods: [...periods].sort((a, b) => a - b), excludedUnscoredMatchups, teams };
}

export function aggregateCategoryPreferences(history: CategoryPreferences, draftYears: readonly number[] = history.coverage.draftYears) {
  const requested = [...new Set(draftYears)].sort((a, b) => a - b);
  if (new Set(history.seasons.map(season => season.draftYear)).size !== history.seasons.length) throw new Error('Duplicate category season.');
  const ids = [...new Set(history.seasons.flatMap(season => season.teams.map(team => team.franchiseId)))].sort((a, b) => Number(a) - Number(b));
  return ids.map(franchiseId => {
    const observations = requested.flatMap(year => {
      const team = history.seasons.find(season => season.draftYear === year)?.teams.find(team => team.franchiseId === franchiseId);
      return team && team.matchups > 0 ? [{ year, team }] : [];
    });
    const recordedSeasons = observations.map(row => row.year);
    const categoryIds = [...new Set(history.seasons.flatMap(season => season.teams.flatMap(team => team.categories.map(category => category.id))))];
    return { franchiseId, recordedSeasons, missingSeasons: requested.filter(year => !recordedSeasons.includes(year)), matchups: observations.reduce((sum, row) => sum + row.team.matchups, 0),
      categories: categoryIds.map(id => {
        const rows = observations.flatMap(row => row.team.categories.filter(category => category.id === id));
        const wins = rows.reduce((sum, row) => sum + row.wins, 0), losses = rows.reduce((sum, row) => sum + row.losses, 0), ties = rows.reduce((sum, row) => sum + row.ties, 0);
        const decisions = wins + losses + ties;
        return { id, label: rows[0]?.label ?? CATEGORY_LABELS[id] ?? `Stat ${id}`, wins, losses, ties, decisions, coverageMatchups: decisions, winRate: decisions ? (wins + ties * 0.5) / decisions : null };
      }) };
  });
}
