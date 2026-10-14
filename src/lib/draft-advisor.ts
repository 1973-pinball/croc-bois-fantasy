import type { DraftBoard } from './draft-board';
import { compareDraftCatalogPlayers, type DraftCatalogPlayer, type DraftPlayerCatalog } from './draft-player-catalog';
import { buildDraftRosters, type DraftRosterPlayer, type DraftTeamRoster } from './draft-roster';
import type { DraftRosterEligibility, DraftRosterSettings } from './espn-roster-settings';
import type { DraftPlayerProjection, DraftProjectionDataset, DraftProjectionStats } from './draft-projections';
import { draftAdvisorScheduleSchema, type DraftAdvisorSchedule } from './draft-advisor-schedule';

export type DraftAdvisorCategory = {
  id: number; label: string; lowerIsBetter: boolean; projectedValue: number | null;
  winProbability: number | null; opponentsCompared: number;
};
export type DraftAdvisorTeam = {
  franchiseId: string; displayName: string; roster: DraftTeamRoster;
  coverage: { projected: number; total: number; missing: { id: number; name: string }[] };
  totals: DraftProjectionStats | null; categories: DraftAdvisorCategory[];
  scheduleTotals: DraftProjectionStats | null; scheduleCategories: DraftAdvisorCategory[];
  categoryWinRate: number | null; scheduleWinRate: number | null;
};
export type DraftAdvisorCandidate = {
  player: DraftCatalogPlayer; hasProjection: boolean;
  categoryWinRate: number | null; categoryGain: number | null;
  scheduleWinRate: number | null; scheduleGain: number | null;
  fitScore: number | null; fitAdjustment: number;
  scheduledGames: number | null; usableGames: number | null;
  reasons: string[]; blocked: boolean;
};
export type DraftAdvisorMatchup = {
  franchiseId: string; displayName: string;
  categories: { id: number; label: string; winProbability: number | null }[];
  categoryWinRate: number | null;
};
export type DraftAdvisorReport = {
  available: boolean; unavailableReason: string | null; franchiseId: string; revision: number;
  teams: DraftAdvisorTeam[]; selectedTeam: DraftAdvisorTeam | null; matchups: DraftAdvisorMatchup[]; scheduleMatchups: DraftAdvisorMatchup[];
  /** Every available selectable player, including rows without the selected source's projection. */
  candidates: DraftAdvisorCandidate[];
  topAvailable: DraftAdvisorCandidate[]; fitRanking: DraftAdvisorCandidate[];
  categoryRecommendation: DraftAdvisorCandidate | null; scheduleRecommendation: DraftAdvisorCandidate | null; fitRecommendation: DraftAdvisorCandidate | null;
  warnings: string[]; methodology: string[]; scheduleMode: 'actual' | 'equal_games'; evaluatedCandidates: number;
};
export type DraftAdvisorInput = {
  board: DraftBoard; catalog: DraftPlayerCatalog; settings: DraftRosterSettings; eligibility: DraftRosterEligibility;
  projections: DraftProjectionDataset | null; franchiseId: string; schedule?: DraftAdvisorSchedule | null;
};

const KEYS: (keyof DraftProjectionStats)[] = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'three', 'fgm', 'fga', 'ftm', 'fta'];
const COUNTING: Record<number, keyof DraftProjectionStats> = { 0: 'pts', 1: 'blk', 2: 'stl', 3: 'ast', 6: 'reb', 11: 'tov', 17: 'three' };
const CATEGORIES = [0, 1, 2, 3, 6, 11, 17, 19, 20];
const zero = (): DraftProjectionStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const validStats = (stats: DraftProjectionStats) => stats && KEYS.every(key => typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0)
  && stats.fgm <= stats.fga && stats.ftm <= stats.fta;
const add = (target: DraftProjectionStats, stats: DraftProjectionStats, games: number) => { for (const key of KEYS) target[key] += stats[key] * games; };
const availability = (projection: DraftPlayerProjection) => projection.games === null ? 1 : clamp(projection.games / 82, 0, 1);
const normalizeTeam = (team: string) => ({ NY: 'NYK', GS: 'GSW', NO: 'NOP', SA: 'SAS', PHO: 'PHX', BRK: 'BKN' }[team.toUpperCase()] ?? team.toUpperCase());

/** Normal CDF approximation; a deterministic uncertainty model, not fitted historical odds. */
function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2), t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return clamp(0.5 * (1 + sign * erf), 0.001, 0.999);
}

function categoryValue(stats: DraftProjectionStats | null, id: number): number | null {
  if (!stats) return null;
  if (id === 19) return stats.fga > 0 ? stats.fgm / stats.fga : null;
  if (id === 20) return stats.fta > 0 ? stats.ftm / stats.fta : null;
  return COUNTING[id] ? stats[COUNTING[id]] : null;
}

function probability(a: DraftProjectionStats | null, b: DraftProjectionStats | null, id: number): number | null {
  const left = categoryValue(a, id), right = categoryValue(b, id);
  if (left === null || right === null || !a || !b) return null;
  let variance: number;
  if (id === 19 || id === 20) {
    const attemptsA = id === 19 ? a.fga : a.fta, attemptsB = id === 19 ? b.fga : b.fta;
    // Binomial shooting variation plus a 1.5 percentage point team uncertainty floor.
    variance = left * (1 - left) / attemptsA + right * (1 - right) / attemptsB + 2 * 0.015 ** 2;
  } else {
    // Overdispersed counts plus a 12% team projection uncertainty floor.
    variance = 1.5 * (left + right) + (0.12 * left) ** 2 + (0.12 * right) ** 2;
  }
  if (Math.abs(left - right) < 1e-10) return 0.5;
  const advantage = (left - right) * (id === 11 ? -1 : 1);
  return normalCdf(advantage / Math.sqrt(Math.max(variance, 1e-8)));
}

function compareTeams(a: DraftProjectionStats | null, opponents: (DraftProjectionStats | null)[], categories: DraftPlayerCatalog['categories']) {
  const values = categories.map(category => {
    const probabilities = opponents.map(opponent => probability(a, opponent, category.id)).filter((value): value is number => value !== null);
    return { ...category, lowerIsBetter: category.id === 11, projectedValue: categoryValue(a, category.id), winProbability: average(probabilities), opponentsCompared: probabilities.length };
  });
  // Do not report a nine-category rate based on a subset of the categories.
  return { categories: values, winRate: values.every(value => value.winProbability !== null) ? average(values.map(value => value.winProbability!)) : null };
}

/** Positive nine-category values supply the daily assignment objective. */
function lineupValues(projections: Map<number, DraftPlayerProjection>) {
  const rows = [...projections.values()];
  const total = zero(); rows.forEach(row => add(total, row.stats, 1));
  const fg = total.fga > 0 ? total.fgm / total.fga : 0.46, ft = total.fta > 0 ? total.ftm / total.fta : 0.78;
  const vectors = rows.map(({ stats: s }) => [s.pts, s.reb, s.ast, s.stl, s.blk, s.three, -s.tov, s.fgm - fg * s.fga, s.ftm - ft * s.fta]);
  const means = CATEGORIES.map((_, index) => average(vectors.map(vector => vector[index])) ?? 0);
  const deviations = means.map((mean, index) => Math.sqrt(average(vectors.map(vector => (vector[index] - mean) ** 2)) ?? 0) || 1);
  return new Map(rows.map((row, index) => [row.id, Math.max(0.01, 12 + vectors[index].reduce((sum, value, category) => sum + (value - means[category]) / deviations[category], 0)) * availability(row)]));
}

/** Weighted transversal-matroid greedy: augmenting paths retain previously accepted players. */
function activePlayers(players: DraftRosterPlayer[], slotIds: number[], weights: Map<number, number>): number[] {
  const occupants = new Map<number, DraftRosterPlayer>();
  function place(player: DraftRosterPlayer, visited: Set<number>): boolean {
    for (let index = 0; index < slotIds.length; index++) {
      if (visited.has(index) || !player.eligibleSlots?.includes(slotIds[index])) continue;
      visited.add(index);
      const occupant = occupants.get(index);
      if (!occupant || place(occupant, visited)) { occupants.set(index, player); return true; }
    }
    return false;
  }
  const ranked = [...players].sort((a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0) || a.id - b.id);
  for (const player of ranked) place(player, new Set());
  return [...occupants.values()].map(player => player.id);
}

type ScheduleContext = {
  days: { teams: Set<string>; week: number }[]; weeklyScale: number; weeks: number; season: boolean; allTeams: Set<string>;
  activeSlots: number[]; weights: Map<number, number>; lineupCache: Map<string, number[]>;
};
type ScheduledTotals = { totals: DraftProjectionStats | null; weekly: (DraftProjectionStats | null)[]; games: Map<number, number>; usable: Map<number, number> };
function scheduledTotals(players: DraftRosterPlayer[], projections: Map<number, DraftPlayerProjection>, catalog: Map<number, DraftCatalogPlayer>, context: ScheduleContext): ScheduledTotals {
  const result: ScheduledTotals = { totals: null, weekly: Array.from({ length: context.weeks }, () => null), games: new Map(), usable: new Map() };
  const playerTeams = new Map(players.map(player => [player.id, normalizeTeam(catalog.get(player.id)?.nbaTeam ?? '')]));
  if (!players.length || players.some(player => !projections.has(player.id) || !player.eligibleSlots?.length || !playerTeams.get(player.id)
    || ['FA', 'UNKNOWN'].includes(playerTeams.get(player.id)!) || (context.season && !context.allTeams.has(playerTeams.get(player.id)!)))) return result;
  result.totals = zero();
  result.weekly = Array.from({ length: context.weeks }, zero);
  for (const day of context.days) {
    const playing = players.filter(player => day.teams.has(playerTeams.get(player.id)!));
    for (const player of playing) result.games.set(player.id, (result.games.get(player.id) ?? 0) + 1);
    // Repeated daily combinations, including days when a hypothetical pick is
    // idle, share one slot assignment across the entire candidate pool.
    const key = playing.map(player => player.id).join(',');
    let active = context.lineupCache.get(key);
    if (!active) { active = activePlayers(playing, context.activeSlots, context.weights); context.lineupCache.set(key, active); }
    for (const id of active) {
      result.usable.set(id, (result.usable.get(id) ?? 0) + 1);
      const projection = projections.get(id)!;
      add(result.weekly[day.week]!, projection.stats, availability(projection) * context.weeklyScale);
    }
  }
  for (const weekly of result.weekly) add(result.totals, weekly!, 1 / context.weeks);
  return result;
}

/** Average weekly probabilities, never a probability computed from pooled season totals. */
function compareScheduled(a: ScheduledTotals, opponents: ScheduledTotals[], categories: DraftPlayerCatalog['categories']) {
  const weeks = a.weekly.map((total, index) => compareTeams(total, opponents.map(opponent => opponent.weekly[index] ?? null), categories));
  const complete = weeks.filter(week => week.winRate !== null);
  return {
    winRate: average(complete.map(week => week.winRate!)),
    categories: categories.map((category, index) => ({ ...category, lowerIsBetter: category.id === 11,
      projectedValue: categoryValue(a.totals, category.id),
      winProbability: average(complete.map(week => week.categories[index].winProbability!)),
      opponentsCompared: complete.length ? Math.min(...complete.map(week => week.categories[index].opponentsCompared)) : 0,
    })),
  };
}

const methodology = [
  'Winrate is expected categories won divided by nine, averaged equally against the other current drafted rosters. It is not the probability of winning a matchup, a playoff forecast, or calibrated betting odds.',
  'Each estimate uses the players selected so far. Undrafted roster slots are left unfilled. Teams with missing player projections are excluded from comparisons; percentage categories require positive shot attempts.',
  'The category-only recommendation tests every available projected player using 3.5 games per week. Source projected games, when supplied, scale expected availability by projected games / 82. FG% and FT% use total makes / total attempts; lower turnovers are better.',
  'Weekly probability approximation: normal count differences with variance 1.5 × expected counts plus a 12% team projection uncertainty floor; shooting uses binomial variance plus a 1.5 percentage point floor per team. Ties in expected totals receive 50%. These assumptions are heuristic and are not fitted to player histories.',
  'With a full-season schedule, each Monday–Sunday week is evaluated separately against the other current rosters, including partial opening and closing weeks. Schedule winrate averages those weekly nine-category probabilities; it does not pool season totals into one matchup. Weeks without published NBA games are omitted; weekly comparisons needing unavailable shooting probabilities are excluded. Displayed production is average weekly production.',
  'Daily starting assignments maximize summed per-game nine-category value using the league’s configured active slots. Bench and IR games do not score. Scheduled and usable game counts cover the entire loaded schedule, before availability scaling. This is a daily lineup heuristic, not an exact optimization of season-long wins. Legacy seven-day imports evaluate just their loaded week.',
  'The separate fit score adds an explicit roster-balance adjustment to the schedule category winrate. A fourth C-eligible player is penalized 1.5 percentage points; a fifth or later is penalized 3 points or more (half for multi-position centers). Covering an uncovered specific starting position adds 0.6 points, up to 1.2. Fit score is a ranking score, not a probability.',
  'Snapshot injury labels are shown by the draft roster but are not used to assume a player misses the full schedule horizon. Injury risk enters only through source projected games. The model does not simulate future picks, streaming, trades, games-played caps, or weekly lineup locks.',
];

/** Pure, recomputed from the current board so corrected, undone and traded picks propagate immediately. */
export function buildDraftAdvisor(input: DraftAdvisorInput): DraftAdvisorReport {
  const { board, catalog, settings, eligibility, projections: dataset, franchiseId } = input;
  const report: DraftAdvisorReport = {
    available: false, unavailableReason: null, franchiseId, revision: board.revision, teams: [], selectedTeam: null, matchups: [], scheduleMatchups: [],
    candidates: [], topAvailable: [], fitRanking: [], categoryRecommendation: null, scheduleRecommendation: null, fitRecommendation: null,
    warnings: [], methodology: [...methodology], scheduleMode: 'equal_games', evaluatedCandidates: 0,
  };
  const unavailable = (reason: string) => { report.unavailableReason = reason; return report; };
  if (catalog.leagueId !== settings.leagueId || catalog.espnSeasonId !== board.draftYear + 1) return unavailable('The ESPN player catalog does not match this draft season.');
  if (catalog.categories.length !== 9 || new Set(catalog.categories.map(category => category.id)).size !== 9 || catalog.categories.some(category => !CATEGORIES.includes(category.id))) return unavailable('The advisor requires the nine supported basketball categories: PTS, REB, AST, STL, BLK, 3PM, TO, FG% and FT%.');
  const rosterSummary = buildDraftRosters(board, settings, eligibility);
  if (!rosterSummary.available) return unavailable(rosterSummary.unavailableReason!);
  if (!rosterSummary.teams.some(team => team.franchiseId === franchiseId)) return unavailable('Choose a team from this draft board.');
  if (dataset && dataset.seasonId !== board.draftYear + 1) return unavailable('The imported projection season does not match this draft.');

  const projections = new Map<number, DraftPlayerProjection>();
  const duplicateIds = new Set<number>();
  for (const row of dataset?.players ?? []) {
    if (projections.has(row.id)) duplicateIds.add(row.id);
    if (validStats(row.stats) && (row.games === null || (Number.isFinite(row.games) && row.games >= 0 && row.games <= 82))) projections.set(row.id, row);
    else report.warnings.push(`Invalid projection for ${row.name} was excluded.`);
  }
  for (const id of duplicateIds) { projections.delete(id); report.warnings.push(`Conflicting duplicate projection for ESPN player ${id} was excluded.`); }
  report.warnings.push(...rosterSummary.issues, ...(dataset?.warnings ?? []));
  if (!dataset) report.warnings.push('Import projections to calculate category winrates and recommendations.');
  if (!board.keepersRevealedAt) report.warnings.push('Unrevealed keepers are not available to this model; recommendations are provisional until keeper reveal.');
  const catalogById = new Map(catalog.players.map(player => [player.id, player]));
  const eligibilityById = new Map(eligibility.players.map(player => [player.id, player]));
  const totalFor = (players: DraftRosterPlayer[]): DraftProjectionStats | null => {
    if (!players.length || players.some(player => !projections.has(player.id))) return null;
    const total = zero();
    for (const player of players) { const projection = projections.get(player.id)!; add(total, projection.stats, 3.5 * availability(projection)); }
    return total;
  };

  let scheduleContext: ScheduleContext | null = null;
  const schedule = input.schedule;
  if (schedule) {
    const start = Date.parse(`${schedule.startDate}T00:00:00Z`), end = Date.parse(`${schedule.endDate}T00:00:00Z`);
    const days = Math.round((end - start) / 86_400_000) + 1;
    if (schedule.seasonId !== board.draftYear + 1 || !draftAdvisorScheduleSchema.safeParse(schedule).success) {
      report.warnings.push('The schedule is empty, has an invalid season/window, or is for another season; using equal games.');
    } else {
      const dates = new Map<string, Set<string>>();
      for (const game of schedule.games) {
        if (game.date < schedule.startDate || game.date > schedule.endDate) continue;
        const teams = dates.get(game.date) ?? new Set<string>(); teams.add(normalizeTeam(game.team)); dates.set(game.date, teams);
      }
      if (dates.size) {
        const activeSlots = settings.slots.filter(slot => slot.kind === 'normal' && !settings.slotDefinitions.find(definition => definition.slotId === slot.slotId)?.bench && slot.slotId !== 12)
          .flatMap(slot => Array.from({ length: slot.count }, () => slot.slotId));
        const season = schedule.scope === 'season';
        const weeks = new Map<string, number>();
        const scheduleDays = [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, teams]) => {
          const timestamp = Date.parse(`${date}T12:00:00Z`), weekday = new Date(timestamp).getUTCDay();
          const monday = new Date(timestamp - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
          const weekKey = season ? monday : schedule.startDate;
          if (!weeks.has(weekKey)) weeks.set(weekKey, weeks.size);
          return { teams, week: weeks.get(weekKey)! };
        });
        scheduleContext = { days: scheduleDays, weeklyScale: season ? 1 : 7 / days, weeks: weeks.size, season,
          allTeams: new Set(schedule.games.map(game => normalizeTeam(game.team))), activeSlots, weights: lineupValues(projections), lineupCache: new Map() };
        report.scheduleMode = 'actual';
        report.warnings.push(...schedule.warnings);
      }
    }
  }
  if (!scheduleContext) report.warnings.push('No usable NBA schedule loaded: the fit ranking uses equal 3.5 games/week plus roster balance; it cannot identify light-day or schedule advantages.');

  const scheduledByTeam = new Map<string, ScheduledTotals>();
  for (const roster of rosterSummary.teams) {
    const missing = roster.players.filter(player => !projections.has(player.id)).map(({ id, name }) => ({ id, name }));
    const totals = totalFor(roster.players);
    if (scheduleContext) scheduledByTeam.set(roster.franchiseId, scheduledTotals(roster.players, projections, catalogById, scheduleContext));
    else scheduledByTeam.set(roster.franchiseId, { totals, weekly: [totals], games: new Map(), usable: new Map() });
    report.teams.push({ franchiseId: roster.franchiseId, displayName: roster.displayName, roster,
      coverage: { projected: roster.totalPlayers - missing.length, total: roster.totalPlayers, missing }, totals, categories: [],
      scheduleTotals: scheduledByTeam.get(roster.franchiseId)!.totals, scheduleCategories: [], categoryWinRate: null, scheduleWinRate: null });
    report.warnings.push(...roster.issues);
    if (roster.players.some(player => !player.eligibleSlots?.length)) report.warnings.push(`${roster.displayName}: ESPN position eligibility is missing for a drafted player; roster-fit recommendations for this team are unavailable.`);
    if (missing.length) report.warnings.push(`${roster.displayName}: ${missing.length} of ${roster.totalPlayers} drafted players lack projections; this team's winrates are unavailable and it is excluded from opponent averages.`);
    if (scheduleContext && totals && !scheduledByTeam.get(roster.franchiseId)!.totals) report.warnings.push(`${roster.displayName}: schedule estimates are unavailable because an NBA team or active-slot eligibility is missing.`);
  }
  if (report.teams.some(team => team.roster.remainingCapacity > 0)) report.warnings.push('Draft in progress: estimates compare current partial rosters. Unequal pick counts can dominate the odds; these are not completed-team forecasts.');
  for (const team of report.teams) {
    const opponents = report.teams.filter(other => other.franchiseId !== team.franchiseId);
    const comparison = compareTeams(team.totals, opponents.map(opponent => opponent.totals), catalog.categories);
    team.categories = comparison.categories; team.categoryWinRate = comparison.winRate;
    const scheduled = compareScheduled(scheduledByTeam.get(team.franchiseId)!, opponents.map(opponent => scheduledByTeam.get(opponent.franchiseId)!), catalog.categories);
    team.scheduleWinRate = scheduled.winRate; team.scheduleCategories = scheduled.categories;
  }
  const selected = report.teams.find(team => team.franchiseId === franchiseId)!;
  const selectedEligibilityComplete = selected.roster.players.every(player => player.eligibleSlots?.length);
  report.selectedTeam = selected;
  const opponents = report.teams.filter(team => team.franchiseId !== franchiseId);
  report.matchups = opponents.map(opponent => {
    const result = compareTeams(selected.totals, [opponent.totals], catalog.categories);
    return { franchiseId: opponent.franchiseId, displayName: opponent.displayName, categories: result.categories.map(({ id, label, winProbability }) => ({ id, label, winProbability })), categoryWinRate: result.winRate };
  });
  report.scheduleMatchups = opponents.map(opponent => {
    const result = compareScheduled(scheduledByTeam.get(franchiseId)!, [scheduledByTeam.get(opponent.franchiseId)!], catalog.categories);
    return { franchiseId: opponent.franchiseId, displayName: opponent.displayName, categories: result.categories.map(({ id, label, winProbability }) => ({ id, label, winProbability })), categoryWinRate: result.winRate };
  });
  const selectedOpponents = opponents.map(opponent => opponent.totals);
  const scheduledOpponents = opponents.map(opponent => scheduledByTeam.get(opponent.franchiseId)!);
  const taken = new Set(board.picks.filter(pick => pick.status === 'selected' || (pick.status === 'keeper' && board.keepersRevealedAt)).flatMap(pick => pick.playerId === null ? [] : [pick.playerId]));
  const available = catalog.players.filter(player => player.selectable && !taken.has(player.id)).sort(compareDraftCatalogPlayers);
  const centers = selected.roster.players.filter(player => player.eligibleSlots?.includes(4)).length;
  const allCandidates = available.map((player): DraftAdvisorCandidate => {
    const row: DraftAdvisorCandidate = { player, hasProjection: projections.has(player.id), categoryWinRate: null, categoryGain: null, scheduleWinRate: null, scheduleGain: null, fitScore: null, fitAdjustment: 0, scheduledGames: null, usableGames: null, reasons: [], blocked: false };
    const eligible = eligibilityById.get(player.id);
    if (selected.roster.remainingCapacity === 0) { row.blocked = true; row.reasons.push('The configured normal roster is full; IR does not add draft capacity.'); }
    if (eligible?.primaryPositionId) {
      const limit = settings.primaryPositionLimits.find(item => item.positionId === eligible.primaryPositionId)?.maximum;
      const count = selected.roster.players.filter(item => item.primaryPositionId === eligible.primaryPositionId).length;
      if (limit !== null && limit !== undefined && count >= limit) { row.blocked = true; row.reasons.push(`The configured primary-position maximum (${limit}) is already filled.`); }
    }
    if (!row.hasProjection) { row.reasons.push('No complete projection was imported for this player.'); return row; }
    if (projections.get(player.id)!.games === 0) {
      row.blocked = true;
      row.reasons.push('The source projects no games this season; this player is excluded from recommendations.');
    }
    report.evaluatedCandidates++;
    const added: DraftRosterPlayer = { id: player.id, name: player.name, status: 'selected', pickId: 'advisor-hypothetical', overallPick: null,
      eligibleSlots: eligible?.eligibleSlots ?? null, eligibleLabels: [], primaryPositionId: eligible?.primaryPositionId ?? null, injuryStatus: eligible?.injuryStatus ?? null };
    const players = [...selected.roster.players, added];
    const total = totalFor(players);
    row.categoryWinRate = compareTeams(total, selectedOpponents, catalog.categories).winRate;
    row.categoryGain = row.categoryWinRate !== null && selected.categoryWinRate !== null ? row.categoryWinRate - selected.categoryWinRate : null;
    if (scheduleContext) {
      const scheduled = scheduledTotals(players, projections, catalogById, scheduleContext);
      row.scheduleWinRate = compareScheduled(scheduled, scheduledOpponents, catalog.categories).winRate;
      if (scheduled.totals) { row.scheduledGames = scheduled.games.get(player.id) ?? 0; row.usableGames = scheduled.usable.get(player.id) ?? 0; }
      row.reasons.push(row.usableGames !== null ? `${row.usableGames} of ${row.scheduledGames} scheduled games fit the daily active lineup in this horizon.` : 'NBA team or lineup eligibility is missing, so schedule fit cannot be estimated.');
    } else row.scheduleWinRate = row.categoryWinRate;
    row.scheduleGain = row.scheduleWinRate !== null && selected.scheduleWinRate !== null ? row.scheduleWinRate - selected.scheduleWinRate : null;
    if (!eligible?.eligibleSlots.length) row.reasons.push('ESPN slot eligibility is missing; the roster-fit score is unavailable.');
    else if (!selectedEligibilityComplete) row.reasons.push('A current roster player is missing ESPN eligibility; the roster-fit score is unavailable.');
    else {
      if (eligible.eligibleSlots.includes(4) && centers >= 3) {
        const flexible = eligible.eligibleSlots.some(slot => slot >= 0 && slot <= 3);
        const penalty = (centers === 3 ? 0.015 : 0.03 + Math.max(0, centers - 4) * 0.01) * (flexible ? 0.5 : 1);
        row.fitAdjustment -= penalty;
        row.reasons.push(`${centers} C-eligible players already rostered: −${(penalty * 100).toFixed(2)} fit points${flexible ? ' (reduced for other position eligibility)' : ''}.`);
      }
      const uncovered = settings.slots.filter(slot => slot.kind === 'normal' && slot.slotId <= 4 && eligible.eligibleSlots.includes(slot.slotId)
        && !selected.roster.players.some(current => current.eligibleSlots?.includes(slot.slotId)));
      if (uncovered.length) {
        const bonus = Math.min(0.012, uncovered.length * 0.006); row.fitAdjustment += bonus;
        row.reasons.push(`Adds coverage at ${uncovered.map(slot => slot.label).join('/')}: +${(bonus * 100).toFixed(2)} fit points.`);
      }
      if (row.scheduleWinRate !== null) row.fitScore = row.scheduleWinRate + row.fitAdjustment;
    }
    if (!row.reasons.length) row.reasons.push('No additional roster-balance adjustment.');
    return row;
  });
  const pure = allCandidates.filter(row => !row.blocked && row.categoryWinRate !== null).sort((a, b) => b.categoryWinRate! - a.categoryWinRate! || compareDraftCatalogPlayers(a.player, b.player));
  const fit = allCandidates.filter(row => !row.blocked && row.fitScore !== null).sort((a, b) => b.fitScore! - a.fitScore! || compareDraftCatalogPlayers(a.player, b.player));
  report.candidates = allCandidates;
  report.topAvailable = allCandidates.slice(0, 15); report.fitRanking = fit.slice(0, 15);
  report.categoryRecommendation = pure[0] ?? null; report.fitRecommendation = fit[0] ?? null;
  report.scheduleRecommendation = allCandidates.filter(row => !row.blocked && row.scheduleWinRate !== null)
    .sort((a, b) => b.scheduleWinRate! - a.scheduleWinRate! || compareDraftCatalogPlayers(a.player, b.player))[0] ?? null;
  if (!selectedOpponents.some(opponent => opponent !== null)) report.warnings.push('At least one non-empty opponent roster with complete projections is needed for winrate recommendations.');
  if (selected.roster.remainingCapacity === 0) report.warnings.push('The selected team has no normal roster capacity remaining; no further pick is recommended.');
  report.warnings = [...new Set(report.warnings)];
  report.available = true;
  return report;
}
