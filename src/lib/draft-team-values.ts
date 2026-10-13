import type { DraftAdvisorTeam } from './draft-advisor';
import type { DraftProjectionStats } from './draft-projections';

export type DraftTeamCategoryValue = {
  id: number;
  label: string;
  valueLabel: string;
  zValue: number | null;
};

export type DraftTeamValue = {
  franchiseId: string;
  value: number | null;
  categories: DraftTeamCategoryValue[];
};

export type DraftTeamValuesReport = {
  teams: DraftTeamValue[];
  methodology: string[];
};

type Category = {
  id: number; label: string; valueLabel: string;
} & ({ stat: keyof DraftProjectionStats; lowerIsBetter?: boolean } | {
  makes: 'fgm' | 'ftm'; attempts: 'fga' | 'fta';
});

const CATEGORIES: Category[] = [
  { id: 0, label: 'PTS', valueLabel: 'pV', stat: 'pts' },
  { id: 17, label: '3PM', valueLabel: '3V', stat: 'three' },
  { id: 6, label: 'REB', valueLabel: 'rV', stat: 'reb' },
  { id: 3, label: 'AST', valueLabel: 'aV', stat: 'ast' },
  { id: 2, label: 'STL', valueLabel: 'sV', stat: 'stl' },
  { id: 1, label: 'BLK', valueLabel: 'bV', stat: 'blk' },
  { id: 19, label: 'FG%', valueLabel: 'fg%V', makes: 'fgm', attempts: 'fga' },
  { id: 20, label: 'FT%', valueLabel: 'ft%V', makes: 'ftm', attempts: 'fta' },
  { id: 11, label: 'TO', valueLabel: 'toV', stat: 'tov', lowerIsBetter: true },
];
const STAT_KEYS: (keyof DraftProjectionStats)[] = ['pts', 'three', 'reb', 'ast', 'stl', 'blk', 'tov', 'fgm', 'fga', 'ftm', 'fta'];

function completeTotals(team: DraftAdvisorTeam): DraftProjectionStats | null {
  const stats = team.totals;
  if (!stats || team.coverage.total <= 0 || team.coverage.projected !== team.coverage.total || team.coverage.missing.length) return null;
  if (!STAT_KEYS.every(key => Number.isFinite(stats[key]) && stats[key] >= 0) || stats.fgm > stats.fga || stats.ftm > stats.fta) return null;
  return stats;
}

/** Population z-scores preserve null coverage and assign zero when there is no spread. */
function standardize(values: (number | null)[]): (number | null)[] {
  const available = values.filter((value): value is number => value !== null);
  if (available.length < 2) return values.map(() => null);
  const mean = available.reduce((sum, value) => sum + value, 0) / available.length;
  const deviation = Math.sqrt(available.reduce((sum, value) => sum + (value - mean) ** 2, 0) / available.length);
  const tolerance = Number.EPSILON * Math.max(...available.map(Math.abs), Math.abs(mean)) * 16;
  return values.map(value => value === null ? null : deviation <= tolerance ? 0 : (value - mean) / deviation);
}

function categoryValues(totals: (DraftProjectionStats | null)[], category: Category): (number | null)[] {
  if ('stat' in category) {
    return standardize(totals.map(stats => stats ? stats[category.stat] * (category.lowerIsBetter ? -1 : 1) : null));
  }
  const available = totals.filter((stats): stats is DraftProjectionStats => stats !== null && stats[category.attempts] > 0);
  if (available.length < 2) return totals.map(() => null);
  const makes = available.reduce((sum, stats) => sum + stats[category.makes], 0);
  const attempts = available.reduce((sum, stats) => sum + stats[category.attempts], 0);
  const pooledPercentage = makes / attempts;
  return standardize(totals.map(stats => {
    if (!stats || stats[category.attempts] <= 0) return null;
    const expectedMakes = pooledPercentage * stats[category.attempts];
    const impact = stats[category.makes] - expectedMakes;
    // Equal shooting rates can leave tiny cancellation errors after weighting.
    const tolerance = Number.EPSILON * Math.max(stats[category.makes], expectedMakes) * 16;
    return Math.abs(impact) <= tolerance ? 0 : impact;
  }));
}

/** Relative values for the current drafted teams, independent of the selected team. */
export function buildDraftTeamValues(teams: DraftAdvisorTeam[]): DraftTeamValuesReport {
  const totals = teams.map(completeTotals);
  const values = CATEGORIES.map(category => categoryValues(totals, category));
  return {
    teams: teams.map((team, teamIndex) => {
      const categories = CATEGORIES.map(({ id, label, valueLabel }, categoryIndex) => ({
        id, label, valueLabel, zValue: values[categoryIndex][teamIndex],
      }));
      return {
        franchiseId: team.franchiseId,
        value: categories.every(category => category.zValue !== null) ? categories.reduce((sum, category) => sum + category.zValue!, 0) : null,
        categories,
      };
    }),
    methodology: [
      'Category values are population z-scores relative to the current drafted teams with complete player projection coverage. Positive is better, zero is average, and +1 is one standard deviation above the comparison group. At least two comparable teams are required; equal values receive zero.',
      'PTS, 3PM, REB, AST, STL and BLK use projected weekly totals. Turnovers reverse the sign so fewer turnovers have a higher toV. FG% and FT% standardize attempt-weighted impact: projected makes minus the comparison group’s pooled shooting percentage times projected attempts. Teams with no attempts have no value in that percentage category.',
      'Overall Value is the equal-weight sum of all nine category z-scores and is unavailable if any category is unavailable. It is a relative strength score, not a win probability or Basketball Monster’s proprietary value formula.',
      'Values use the same source projections and equal-games weekly totals as the category analysis. They compare partial rosters during the draft; unfilled slots are not projected, and unequal pick counts can dominate the scores. They do not include schedule or lineup-fit adjustments.',
    ],
  };
}
