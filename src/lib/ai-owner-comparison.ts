import analyticsFile from '../../data/analytics.json';
import categoryFile from '../../data/category-preferences.json';
import type { AiLeagueRun, AiPeriodResult, AiStats } from './ai-league-types';
import type { CategoryPreferenceSeason, CategoryPreferences } from './category-preferences';
import type { LeagueData } from './types';
import type { AiOwnerSnapshot } from './ai-owner-types';

export type AiComparedDraftPlayer = {
  playerId: number | null; name: string; overallPick: number; keeper: boolean | null;
  aiPick: number | null; ownerPick: number | null;
};
export type AiComparedRecord = { wins: number; losses: number; ties: number };
export type AiCategoryDifference = { id: number; label: string; ai: AiComparedRecord; owner: AiComparedRecord; winsDelta: number };
export type AiOwnerComparisonTeam = {
  teamId: string; name: string; shortName: string; color: string; historicalOwner: string | null;
  draft: {
    available: boolean; complete: boolean; source: 'snapshot' | 'archive' | null;
    shared: AiComparedDraftPlayer[]; aiOnly: AiComparedDraftPlayer[]; ownerOnly: AiComparedDraftPlayer[];
    aiPicks: number; ownerPicks: number; sharedCount: number; departureCount: number | null;
  };
  categories: {
    periods: number[]; ai: AiComparedRecord; owner: AiComparedRecord; winsDelta: number;
    rows: AiCategoryDifference[]; biggestSwings: AiCategoryDifference[];
  } | null;
  acquisitions: { periods: number[]; ai: number; owner: number; delta: number } | null;
};
type DeltaHeadline = { teamId: string; teamName: string; delta: number };
export type AiOwnerComparison = {
  season: number; draftYear: number; periods: number[]; completedPeriods: number;
  draftAvailable: boolean; categoriesAvailable: boolean; acquisitionsAvailable: boolean;
  teams: AiOwnerComparisonTeam[];
  headline: {
    biggestGain: DeltaHeadline | null; biggestDecrease: DeltaHeadline | null;
    biggestDraftDeparture: { teamId: string; teamName: string; count: number } | null;
    biggestAcquisitionGap: DeltaHeadline | null;
  };
  limitations: string[];
};

type ArchivedSelection = { season: number; overallPick: number; historicalOwner: string; kept: boolean | null };
type ArchivedPreference = { franchiseId: string; player: string; selections?: ArchivedSelection[] };
type OwnerPick = { teamId: string; playerId: number | null; name: string; overallPick: number; keeper: boolean | null };
const archivedPreferences = (analyticsFile as unknown as { playerPreferences: { rows: ArchivedPreference[] } }).playerPreferences.rows;
const archivedCategories = (categoryFile as unknown as CategoryPreferences).seasons;
const CATEGORIES = [
  { id: 19, label: 'FG%' }, { id: 20, label: 'FT%' }, { id: 17, label: '3PM' },
  { id: 0, label: 'PTS' }, { id: 6, label: 'REB' }, { id: 3, label: 'AST' },
  { id: 2, label: 'STL' }, { id: 1, label: 'BLK' }, { id: 11, label: 'TO' },
];
const emptyRecord = (): AiComparedRecord => ({ wins: 0, losses: 0, ties: 0 });
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nameKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const suffixKey = (name: string) => nameKey(name.replace(/(?:\s|[,.])+\b(?:jr|sr|ii|iii|iv)\.?$/i, ''));
const byPick = (a: AiComparedDraftPlayer, b: AiComparedDraftPlayer) => a.overallPick - b.overallPick || a.name.localeCompare(b.name);

function historicalSelections(season: number) {
  return archivedPreferences.flatMap(row => (row.selections ?? []).filter(selection => selection.season === season - 1).map(selection => ({
    teamId: row.franchiseId, playerId: null, name: row.player, overallPick: selection.overallPick,
    keeper: selection.kept, historicalOwner: selection.historicalOwner,
  })));
}

function validDraft(picks: OwnerPick[] | null | undefined, teamIds: Set<string>): picks is OwnerPick[] {
  if (!picks?.length || picks.some(pick => !teamIds.has(pick.teamId) || !pick.name?.trim() || !Number.isSafeInteger(pick.overallPick) || pick.overallPick < 1 ||
    (pick.playerId !== null && (!Number.isSafeInteger(pick.playerId) || pick.playerId < 1)))) return false;
  const ids = picks.flatMap(pick => pick.playerId === null ? [] : [pick.playerId]);
  return new Set(ids).size === ids.length && new Set(picks.map(pick => pick.overallPick)).size === picks.length;
}

/** Name-only workbook rows match uniquely; suffix removal never merges ambiguous player identities. */
function resolveOwnerIds(picks: OwnerPick[], run: AiLeagueRun): OwnerPick[] {
  const universe = [...new Map([...run.players, ...(run.initialPlayers ?? [])].map(player => [player.id, player])).values()];
  const exact = new Map<string, number[]>(), suffix = new Map<string, number[]>();
  for (const player of universe) {
    exact.set(nameKey(player.name), [...(exact.get(nameKey(player.name)) ?? []), player.id]);
    suffix.set(suffixKey(player.name), [...(suffix.get(suffixKey(player.name)) ?? []), player.id]);
  }
  const exactOwners = new Map<string, number>(), suffixOwners = new Map<string, number>();
  for (const pick of picks) {
    exactOwners.set(nameKey(pick.name), (exactOwners.get(nameKey(pick.name)) ?? 0) + 1);
    suffixOwners.set(suffixKey(pick.name), (suffixOwners.get(suffixKey(pick.name)) ?? 0) + 1);
  }
  const resolved = picks.map(pick => {
    if (pick.playerId !== null) return { ...pick };
    const exactIds = exact.get(nameKey(pick.name)) ?? [];
    if (exactIds.length === 1 && exactOwners.get(nameKey(pick.name)) === 1) return { ...pick, playerId: exactIds[0] };
    if (exactIds.length > 1) return { ...pick };
    const suffixIds = suffix.get(suffixKey(pick.name)) ?? [];
    return suffixIds.length === 1 && suffixOwners.get(suffixKey(pick.name)) === 1 ? { ...pick, playerId: suffixIds[0] } : { ...pick };
  });
  const counts = new Map<number, number>();
  for (const pick of resolved) if (pick.playerId !== null) counts.set(pick.playerId, (counts.get(pick.playerId) ?? 0) + 1);
  return resolved.map((pick, index) => pick.playerId !== null && counts.get(pick.playerId)! > 1 && picks[index].playerId === null ? { ...pick, playerId: null } : pick);
}

/** Require a complete league-wide period, not merely one finished matchup from that week. */
function completedPeriods(run: AiLeagueRun): number[] {
  const teamIds = new Set(run.teams.map(team => team.id));
  const regular = run.matchups.filter(matchup => !matchup.playoff);
  return [...new Set(regular.map(matchup => matchup.period))].sort((a, b) => a - b).filter(period => {
    const matches = regular.filter(matchup => matchup.period === period);
    const sides = matches.flatMap(matchup => [matchup.home, matchup.away]);
    return sides.length === teamIds.size && new Set(sides).size === teamIds.size && sides.every(id => teamIds.has(id)) && matches.every(matchup => {
      const results = run.results.filter(result => result.matchupId === matchup.id && result.period === period && !result.playoff);
      return results.length === 1 && results[0].complete && results[0].home === matchup.home && results[0].away === matchup.away;
    });
  });
}

function validCategories(source: CategoryPreferenceSeason | null | undefined, run: AiLeagueRun): source is CategoryPreferenceSeason {
  if (!source || source.season !== run.season || source.draftYear !== run.season - 1) return false;
  const periods = source.completedMatchupPeriods;
  if (!periods.length || new Set(periods).size !== periods.length || periods.some(period => !Number.isSafeInteger(period) || period < 1 || period > source.regularSeasonMatchupPeriods)) return false;
  return new Set(source.teams.map(team => team.franchiseId)).size === source.teams.length && run.teams.every(team => {
    const actual = source.teams.find(row => row.franchiseId === team.id);
    return actual?.matchups === periods.length && actual.standingsMatch !== false && actual.categories.length === 9 && new Set(actual.categories.map(category => category.id)).size === 9 && CATEGORIES.every(category => {
      const row = actual.categories.find(item => item.id === category.id);
      return row && [row.wins, row.losses, row.ties].every(nonnegativeInteger) && row.wins + row.losses + row.ties === periods.length;
    });
  });
}

function categoryDifference(id: number, home: AiStats, away: AiStats): number {
  if (id === 19) return home.fga > 0 && away.fga > 0 ? home.fgm * away.fga - away.fgm * home.fga : 0;
  if (id === 20) return home.fta > 0 && away.fta > 0 ? home.ftm * away.fta - away.ftm * home.fta : 0;
  if (id === 11) return away.tov - home.tov;
  const fields: Record<number, keyof AiStats> = { 0: 'pts', 1: 'blk', 2: 'stl', 3: 'ast', 6: 'reb', 17: 'three' };
  return home[fields[id]] - away[fields[id]];
}

function simulatedCategories(results: AiPeriodResult[], teamId: string): Map<number, AiComparedRecord> {
  const rows = new Map(CATEGORIES.map(category => [category.id, emptyRecord()]));
  for (const result of results.filter(item => item.home === teamId || item.away === teamId)) {
    for (const category of CATEGORIES) {
      const record = rows.get(category.id)!;
      const difference = categoryDifference(category.id, result.homeStats, result.awayStats) * (result.home === teamId ? 1 : -1);
      if (difference > 1e-9) record.wins++;
      else if (difference < -1e-9) record.losses++;
      else record.ties++;
    }
  }
  return rows;
}

function totalRecords(records: AiComparedRecord[]): AiComparedRecord {
  return records.reduce((sum, record) => ({ wins: sum.wins + record.wins, losses: sum.losses + record.losses, ties: sum.ties + record.ties }), emptyRecord());
}

function acquisitionPeriods(actual: AiOwnerSnapshot | undefined, completed: number[], teamIds: string[]): number[] {
  if (!actual?.acquisitions || new Set(actual.acquisitions.map(row => row.teamId)).size !== actual.acquisitions.length) return [];
  return completed.filter(period => teamIds.every(teamId => {
    const values = actual.acquisitions!.find(row => row.teamId === teamId)?.byPeriod;
    return values && Object.prototype.hasOwnProperty.call(values, String(period)) && nonnegativeInteger(values[String(period)]);
  }));
}

/** Descriptive differences between two whole-league scenarios; none is attributed causally to a single draft pick. */
export function compareAiOwners(run: AiLeagueRun, league: LeagueData): AiOwnerComparison {
  const limitations = [
    'These are differences between the recorded owner season and a simulation in which every team changed. They do not isolate the effect of an individual decision.',
    'Owners used the real keeper rules and traded draft slots; AI used a fresh snake redraft. Draft differences include those different starting conditions.',
    'Category records include the exact same completed regular-season periods on both sides. Playoffs and unfinished periods are excluded.',
  ];
  const teamIds = new Set(run.teams.map(team => team.id));
  const archive = historicalSelections(run.season);
  const actual = run.actual?.season === run.season ? run.actual : undefined;
  if (actual) limitations.push(...actual.limitations);
  let ownerPicks: OwnerPick[] = [], draftSource: 'snapshot' | 'archive' | null = null, draftComplete = false;
  if (actual && validDraft(actual.draft, teamIds)) {
    ownerPicks = actual.draft;
    draftSource = 'snapshot';
    draftComplete = actual.draftComplete;
  } else if (validDraft(archive, teamIds)) {
    ownerPicks = archive;
    draftSource = 'archive';
    draftComplete = archive.length === 104 && archive.every(pick => pick.overallPick <= 104);
  }
  if (!draftSource) limitations.push('A verified owner draft is not available for this season yet. Draft differences remain pending.');
  else if (!draftComplete) limitations.push('The owner draft is incomplete. AI-only differences and the largest draft departure remain pending.');
  ownerPicks = resolveOwnerIds(ownerPicks, run);
  const playerNames = new Map([...run.players, ...(run.initialPlayers ?? [])].map(player => [player.id, player.name]));
  const aiPicks = run.decisions.filter(decision => decision.kind === 'draft').flatMap(decision => decision.playerIds.map(playerId => ({ teamId: decision.teamId, playerId })))
    .map((pick, index) => ({ ...pick, name: playerNames.get(pick.playerId) ?? `Player ${pick.playerId}`, overallPick: index + 1 }));
  const aiCompleted = completedPeriods(run);
  const fallbackCategories = archivedCategories.find(source => source.season === run.season);
  const snapshotCategories = actual?.categories;
  const ownerCategories = validCategories(snapshotCategories, run) ? snapshotCategories : validCategories(fallbackCategories, run) ? fallbackCategories : null;
  const periods = ownerCategories && ownerCategories.completedMatchupPeriods.every(period => aiCompleted.includes(period)) ? [...ownerCategories.completedMatchupPeriods].sort((a, b) => a - b) : [];
  if (!periods.length) limitations.push(ownerCategories ? 'Owner category totals cover periods that the simulation has not fully completed. No partial-season versus full-season comparison is shown.' : 'Verified owner category results are not available for matching completed periods yet.');
  const categoryResults = run.results.filter(result => result.complete && !result.playoff && periods.includes(result.period));
  const ownerCompleted = new Set(ownerCategories?.completedMatchupPeriods ?? []);
  const activityPeriods = acquisitionPeriods(actual, aiCompleted.filter(period => ownerCompleted.has(period)), [...teamIds]);
  if (!activityPeriods.length) limitations.push('Verified owner acquisition counts are unavailable for matching completed periods. Missing activity is not treated as zero.');
  const teams: AiOwnerComparisonTeam[] = run.teams.map(team => {
    const current = league.teams.find(item => String(item.id) === team.id);
    const ownerLabels = [...new Set(archive.filter(pick => pick.teamId === team.id).sort((a, b) => a.overallPick - b.overallPick).map(pick => pick.historicalOwner).filter(Boolean))];
    const ai = aiPicks.filter(pick => pick.teamId === team.id);
    const owner = ownerPicks.filter(pick => pick.teamId === team.id);
    const unresolved = owner.filter(pick => pick.playerId === null);
    const complete = draftComplete && unresolved.length === 0;
    if (unresolved.length) limitations.push(`${current?.name ?? team.name}: ${unresolved.length} owner draft identity could not be uniquely matched. AI-only absence claims and the departure count remain pending for this team.`);
    const shared: AiComparedDraftPlayer[] = [], aiOnly: AiComparedDraftPlayer[] = [];
    const used = new Set<number>();
    for (const pick of ai) {
      const matches = owner.map((other, index) => ({ other, index })).filter(({ other }) => other.playerId !== null && other.playerId === pick.playerId);
      const match = matches.length === 1 ? matches[0] : null;
      if (match) {
        used.add(match.index);
        shared.push({ playerId: pick.playerId, name: pick.name, overallPick: pick.overallPick, keeper: match.other.keeper, aiPick: pick.overallPick, ownerPick: match.other.overallPick });
      } else if (complete) aiOnly.push({ playerId: pick.playerId, name: pick.name, overallPick: pick.overallPick, keeper: false, aiPick: pick.overallPick, ownerPick: null });
    }
    const ownerOnly = owner.filter((pick, index) => pick.playerId !== null && !used.has(index)).map(pick => ({ playerId: pick.playerId, name: pick.name, overallPick: pick.overallPick, keeper: pick.keeper, aiPick: null, ownerPick: pick.overallPick }));
    let categories: AiOwnerComparisonTeam['categories'] = null;
    if (periods.length && ownerCategories) {
      const aiCategories = simulatedCategories(categoryResults, team.id);
      const actualTeam = ownerCategories.teams.find(item => item.franchiseId === team.id)!;
      const rows = CATEGORIES.map(category => {
        const source = actualTeam.categories.find(item => item.id === category.id)!;
        const owner = { wins: source.wins, losses: source.losses, ties: source.ties };
        const ai = aiCategories.get(category.id)!;
        return { ...category, ai, owner, winsDelta: ai.wins - owner.wins };
      });
      const ai = totalRecords(rows.map(row => row.ai)), owner = totalRecords(rows.map(row => row.owner));
      categories = { periods: [...periods], ai, owner, winsDelta: ai.wins - owner.wins, rows, biggestSwings: [...rows].sort((a, b) => Math.abs(b.winsDelta) - Math.abs(a.winsDelta) || a.id - b.id).slice(0, 3) };
    }
    let acquisitions: AiOwnerComparisonTeam['acquisitions'] = null;
    if (activityPeriods.length && actual?.acquisitions) {
      const actualTeam = actual.acquisitions.find(item => item.teamId === team.id)!;
      const owner = activityPeriods.reduce((sum, period) => sum + actualTeam.byPeriod[String(period)], 0);
      const ai = run.decisions.filter(decision => decision.teamId === team.id && decision.kind === 'add_drop' && run.matchups.some(matchup => !matchup.playoff && activityPeriods.includes(matchup.period) && (matchup.home === team.id || matchup.away === team.id) && matchup.start <= decision.date && matchup.end >= decision.date)).length;
      acquisitions = { periods: [...activityPeriods], ai, owner, delta: ai - owner };
    }
    return {
      teamId: team.id, name: current?.name ?? team.name, shortName: current?.shortName ?? team.shortName, color: current?.color ?? team.color,
      historicalOwner: ownerLabels.length ? ownerLabels.join(' / ') : null,
      draft: { available: draftSource !== null, complete, source: draftSource, shared: shared.sort(byPick), aiOnly: aiOnly.sort(byPick), ownerOnly: ownerOnly.sort(byPick), aiPicks: ai.length, ownerPicks: owner.length, sharedCount: shared.length, departureCount: complete ? aiOnly.length : null },
      categories, acquisitions,
    };
  });
  const biggestGain = [...teams].filter(team => team.categories && team.categories.winsDelta > 0).sort((a, b) => b.categories!.winsDelta - a.categories!.winsDelta)[0];
  const biggestDecrease = [...teams].filter(team => team.categories && team.categories.winsDelta < 0).sort((a, b) => a.categories!.winsDelta - b.categories!.winsDelta)[0];
  const biggestDraft = [...teams].filter(team => (team.draft.departureCount ?? 0) > 0).sort((a, b) => b.draft.departureCount! - a.draft.departureCount!)[0];
  const biggestActivity = [...teams].filter(team => team.acquisitions && team.acquisitions.delta !== 0).sort((a, b) => Math.abs(b.acquisitions!.delta) - Math.abs(a.acquisitions!.delta))[0];
  return {
    season: run.season, draftYear: run.season - 1, periods, completedPeriods: periods.length,
    draftAvailable: draftSource !== null, categoriesAvailable: periods.length > 0, acquisitionsAvailable: activityPeriods.length > 0, teams,
    headline: {
      biggestGain: biggestGain ? { teamId: biggestGain.teamId, teamName: biggestGain.name, delta: biggestGain.categories!.winsDelta } : null,
      biggestDecrease: biggestDecrease ? { teamId: biggestDecrease.teamId, teamName: biggestDecrease.name, delta: biggestDecrease.categories!.winsDelta } : null,
      biggestDraftDeparture: biggestDraft ? { teamId: biggestDraft.teamId, teamName: biggestDraft.name, count: biggestDraft.draft.departureCount! } : null,
      biggestAcquisitionGap: biggestActivity ? { teamId: biggestActivity.teamId, teamName: biggestActivity.name, delta: biggestActivity.acquisitions!.delta } : null,
    }, limitations: [...new Set(limitations)],
  };
}
