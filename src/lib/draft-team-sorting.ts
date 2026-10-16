import type { DraftAdvisorTeam } from './draft-advisor';
import type { DraftTeamValue } from './draft-team-values';

export type DraftTeamSortDirection = 'ascending' | 'descending';
export type DraftTeamProjectionColumn = 'team' | 'overall' | `win:${number}` | `production:${number}`;
export type DraftTeamValueColumn = 'team' | 'value' | `category:${number}`;
export type DraftTeamSort<Column extends string> = { column: Column; direction: DraftTeamSortDirection };

export function defaultDraftTeamSortDirection(column: DraftTeamProjectionColumn | DraftTeamValueColumn): DraftTeamSortDirection {
  return column === 'team' || column === 'production:11' ? 'ascending' : 'descending';
}

const finiteValue = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function sortRows<T extends { franchiseId: string }>(rows: readonly T[], value: (row: T) => string | number | null, name: (row: T) => string, direction: DraftTeamSortDirection): T[] {
  return [...rows].sort((a, b) => {
    const left = value(a), right = value(b);
    // Missing projections stay at the bottom, including when the direction reverses.
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    const compared = left === null || right === null ? 0 : typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right) : Number(left) - Number(right);
    return (direction === 'descending' ? -compared : compared)
      || name(a).localeCompare(name(b)) || a.franchiseId.localeCompare(b.franchiseId);
  });
}

type ProjectionTeam = Pick<DraftAdvisorTeam, 'franchiseId' | 'displayName' | 'categoryWinRate' | 'categories'>;

export function sortDraftTeamProjections<T extends ProjectionTeam>(teams: readonly T[], sort: DraftTeamSort<DraftTeamProjectionColumn>): T[] {
  return sortRows(teams, team => {
    if (sort.column === 'team') return team.displayName.trim() || null;
    if (sort.column === 'overall') return finiteValue(team.categoryWinRate);
    const [metric, id] = sort.column.split(':');
    const category = team.categories.find(value => value.id === Number(id));
    return finiteValue(metric === 'production' ? category?.projectedValue : category?.winProbability);
  }, team => team.displayName, sort.direction);
}

export function sortDraftTeamValues<T extends DraftTeamValue>(teams: readonly T[], names: ReadonlyMap<string, string>, sort: DraftTeamSort<DraftTeamValueColumn>): T[] {
  const name = (team: T) => names.get(team.franchiseId) ?? team.franchiseId;
  return sortRows(teams, team => {
    if (sort.column === 'team') return name(team).trim() || null;
    if (sort.column === 'value') return finiteValue(team.value);
    return finiteValue(team.categories.find(value => value.id === Number(sort.column.split(':')[1]))?.zValue);
  }, name, sort.direction);
}
