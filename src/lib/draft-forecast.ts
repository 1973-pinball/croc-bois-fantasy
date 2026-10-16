import { buildDraftAdvisor, createDraftRosterEvaluator, type DraftAdvisorInput, type DraftAdvisorReport, type DraftAdvisorCandidate, type DraftAdvisorCategory, type ScheduledTotals } from './draft-advisor';
import { prepareDraftCompletion, completeDraftScenario } from './draft-completion';
import { draftProjectionDatasetSchema, type DraftProjectionStats } from './draft-projections';

export type DraftForecastInput = DraftAdvisorInput & { espnRanks?: { id: number; rank: number }[]; scenarios?: number };
export type DraftForecastCandidateRange = {
  playerId: number; min: number | null; max: number | null; availableScenarios: number; scenarioCount: number;
  conditionalWinRate: number | null; conditionalGain: number | null;
};
export type DraftForecastReport = DraftAdvisorReport & { forecast: {
  status: 'ready' | 'unavailable'; scenarioCount: number; rosterSize: number;
  targetPick: { id: string; overallPick: number | null; round: number } | null;
  teamRanges: { franchiseId: string; min: number; max: number }[];
  candidateRanges: DraftForecastCandidateRange[];
  assumptions: string[]; completionAdjustments: { franchiseId: string; added: number; cut: number }[];
} };
export type DraftForecastProgress = { completed: number; total: number };

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const meanNullable = (values: (number | null)[]) => values.length && values.every((value): value is number => value !== null && Number.isFinite(value)) ? mean(values) : null;
const statsMean = (values: DraftProjectionStats[]): DraftProjectionStats => Object.fromEntries(
  (Object.keys(values[0]) as (keyof DraftProjectionStats)[]).map(key => [key, mean(values.map(value => value[key]))]),
) as DraftProjectionStats;
function categoryMean(values: DraftAdvisorCategory[][]): DraftAdvisorCategory[] {
  return values[0].map((category, index) => ({ ...category,
    projectedValue: meanNullable(values.map(row => row[index].projectedValue)),
    winProbability: meanNullable(values.map(row => row[index].winProbability)),
    opponentsCompared: Math.min(...values.map(row => row[index].opponentsCompared)),
  }));
}

/** Conditional gains use exactly the same surviving scenarios; plans fall back when the player is gone. */
export function summarizeDraftCandidateScenarios(baselines: number[], outcomes: (number | null)[]) {
  if (!baselines.length || baselines.length !== outcomes.length || baselines.some(value => !Number.isFinite(value))
    || outcomes.some(value => value !== null && !Number.isFinite(value))) throw new Error('Scenario baselines must match finite outcomes.');
  const available = outcomes.flatMap((value, index) => value !== null && Number.isFinite(value) ? [{ value, baseline: baselines[index] }] : []);
  const plans = outcomes.map((value, index) => value === null ? baselines[index] : value);
  return { winRate: mean(plans), gain: mean(plans.map((value, index) => value - baselines[index])),
    min: Math.min(...plans), max: Math.max(...plans), availableScenarios: available.length,
    conditionalWinRate: available.length ? mean(available.map(row => row.value)) : null,
    conditionalGain: available.length ? mean(available.map(row => row.value - row.baseline)) : null };
}

/** Private, deterministic scenario analysis. This function never records a pick, drop or free-agent add. */
export function buildDraftForecast(input: DraftForecastInput, onProgress?: (value: DraftForecastProgress) => void): DraftForecastReport {
  const base = buildDraftAdvisor({ ...input, evaluateCandidates: false });
  const report: DraftForecastReport = { ...base, forecast: {
    status: 'unavailable', scenarioCount: 0, rosterSize: input.settings.normalCapacity, targetPick: null,
    teamRanges: [], candidateRanges: [], assumptions: [], completionAdjustments: [],
  } };
  const occupied = new Set(input.board.picks.filter(pick => pick.status === 'selected' || (pick.status === 'keeper' && input.board.keepersRevealedAt)).map(pick => pick.playerId));
  const projections = new Map(input.projections?.players.map(player => [player.id, player]) ?? []);
  report.candidates = input.catalog.players.filter(player => player.selectable && !occupied.has(player.id)).map(player => ({
    player, hasProjection: projections.has(player.id), categoryWinRate: null, categoryGain: null, scheduleWinRate: null, scheduleGain: null,
    fitScore: null, fitAdjustment: 0, scheduledGames: null, usableGames: null, reasons: [], blocked: false,
  }));
  report.topAvailable = report.candidates.slice(0, 15);
  const unavailable = (reason: string) => {
    report.available = false; report.unavailableReason = reason;
    report.categoryRecommendation = null; report.scheduleRecommendation = null; report.fitRecommendation = null; report.fitRanking = [];
    report.matchups = []; report.scheduleMatchups = [];
    for (const team of report.teams) {
      team.categoryWinRate = null; team.scheduleWinRate = null; team.totals = null; team.scheduleTotals = null;
      team.categories = team.categories.map(category => ({ ...category, projectedValue: null, winProbability: null, opponentsCompared: 0 }));
      team.scheduleCategories = team.categories;
    }
    for (const candidate of report.candidates) { candidate.categoryWinRate = null; candidate.scheduleWinRate = null; candidate.categoryGain = null; candidate.scheduleGain = null; candidate.fitScore = null; }
    report.warnings = [...new Set([reason, ...report.warnings.filter(warning => !warning.startsWith('Draft in progress:'))])];
    return report;
  };
  if (!base.available) return unavailable(base.unavailableReason ?? 'The current draft board is unavailable.');
  if (!draftProjectionDatasetSchema.safeParse(input.projections).success) return unavailable('Import a complete, compatible projection source to forecast completed rosters.');
  if (input.schedule?.scope !== 'season') return unavailable('Load the full-season schedule to forecast completed rosters.');
  const evaluator = createDraftRosterEvaluator(input);
  if (!evaluator) return unavailable('A valid full-season schedule is required for the completed-roster forecast.');
  const completion = prepareDraftCompletion({ ...input, espnRanks: new Map(input.espnRanks?.map(row => [row.id, row.rank])),
    scheduledTeams: evaluator.scheduledTeams, scenarioCount: input.scenarios ?? 12 });
  if (!completion.available) return unavailable(completion.unavailableReason ?? 'The remaining draft cannot be simulated from this board.');
  const count = completion.scenarioCount;
  report.forecast.scenarioCount = count; report.forecast.targetPick = completion.targetPick;
  report.forecast.assumptions = [
    `${count} repeatable draft scenarios: one follows ESPN order; the others cover neighboring-pick swaps and up to 22% variation in market ranks. These are sensitivity scenarios, not calibrated drafting probabilities.`,
    'Each scenario honors recorded picks, revealed keepers, traded pick ownership and the remaining draft order. Recommendations act at your next owned open pick, after intervening teams select.',
    `After the draft, every team is completed to ${input.settings.normalCapacity} normal roster spots. Teams cut their lowest ESPN-market-ranked players in that scenario and fill shortfalls with the highest remaining eligible free agents; fill priority rotates between scenarios. Cut players stay unavailable. IR adds no ordinary roster capacity. These moves are hypothetical.`,
    'The model uses only the selected projection source for statistics. Players without usable projections, schedule teams or slot eligibility cannot be assumed as future additions; missing fixed-player coverage blocks the forecast.',
    'If a target is gone at your pick, that scenario uses its ordinary ESPN-based selection instead. Displayed candidate rates and gains include this fallback; conditional rates and gains use only scenarios where that candidate could be selected.',
    'Scenario ranges show sensitivity to the simulated draft, not confidence intervals. Category win rate is expected categories won divided by nine, not weekly matchup-win or championship probability.',
    'Within each scenario, daily lineup assignments respect active slots and projected availability. Weekly category probabilities are calculated before averaging across weeks, opponents and scenarios. No extra center penalty or position bonus is added.',
  ];
  report.methodology = [...report.forecast.assumptions, ...base.methodology.filter(line => line.startsWith('Weekly probability approximation:') || line.startsWith('Daily starting assignments'))];
  report.warnings = [...input.projections!.warnings, ...completion.warnings];
  type Comparison = ReturnType<typeof evaluator.compare>;
  const baselines: { totals: Map<string, ScheduledTotals>; comparisons: Map<string, Comparison>; matchups: Map<string, Comparison> }[] = [];
  const adjustments = new Map(report.teams.map(team => [team.franchiseId, { added: 0, cut: 0 }]));
  for (let scenario = 0; scenario < count; scenario++) {
    const completed = completeDraftScenario(completion, scenario);
    if (!completed.valid) return unavailable(completed.reason ?? 'A scenario could not complete all rosters legally.');
    const totals = new Map([...completed.teams].map(([id, players]) => [id, evaluator.evaluate(players)]));
    if ([...totals.values()].some(value => !value.totals || value.weekly.some(week => !week))) return unavailable('Every simulated team needs complete projections, NBA schedule coverage and lineup eligibility.');
    const comparisons = new Map(report.teams.map(team => [team.franchiseId, evaluator.compare(totals.get(team.franchiseId)!, [...totals].filter(([id]) => id !== team.franchiseId).map(([, value]) => value))]));
    if ([...comparisons.values()].some(value => value.winRate === null)) return unavailable('The completed rosters cannot be compared across all nine categories.');
    const matchups = new Map(report.teams.filter(team => team.franchiseId !== input.franchiseId).map(team => [team.franchiseId, evaluator.compare(totals.get(input.franchiseId)!, [totals.get(team.franchiseId)!])]));
    baselines.push({ totals, comparisons, matchups });
    for (const row of completed.additions) adjustments.get(row.franchiseId)!.added++;
    for (const row of completed.cuts) adjustments.get(row.franchiseId)!.cut++;
  }
  for (const team of report.teams) {
    const values = baselines.map(value => value.comparisons.get(team.franchiseId)!);
    team.categories = categoryMean(values.map(value => value.categories)); team.scheduleCategories = team.categories;
    team.categoryWinRate = mean(values.map(value => value.winRate!)); team.scheduleWinRate = team.categoryWinRate;
    team.totals = statsMean(baselines.map(value => value.totals.get(team.franchiseId)!.totals!)); team.scheduleTotals = team.totals;
    report.forecast.teamRanges.push({ franchiseId: team.franchiseId, min: Math.min(...values.map(value => value.winRate!)), max: Math.max(...values.map(value => value.winRate!)) });
    const adjustment = adjustments.get(team.franchiseId)!;
    if (adjustment.added || adjustment.cut) report.forecast.completionAdjustments.push({ franchiseId: team.franchiseId, added: adjustment.added / count, cut: adjustment.cut / count });
  }
  report.selectedTeam = report.teams.find(team => team.franchiseId === input.franchiseId)!;
  report.scheduleMatchups = report.teams.filter(team => team.franchiseId !== input.franchiseId).map(team => {
    const values = baselines.map(value => value.matchups.get(team.franchiseId)!);
    return { franchiseId: team.franchiseId, displayName: team.displayName, categoryWinRate: meanNullable(values.map(value => value.winRate)),
      categories: categoryMean(values.map(value => value.categories)).map(({ id, label, winProbability }) => ({ id, label, winProbability })) };
  });
  report.matchups = report.scheduleMatchups;
  report.available = true; report.unavailableReason = null; report.forecast.status = 'ready'; report.scheduleMode = 'actual';
  if (!completion.targetPick) {
    report.warnings.push('Your team has no remaining owned draft pick; completed-roster forecasts include any necessary free-agent fill, but no draft pick is recommended.');
    return report;
  }
  const candidateIds = new Set(completion.candidateIds);
  const candidates = report.candidates.filter(candidate => candidateIds.has(candidate.player.id));
  const outcomes = new Map(candidates.map(candidate => [candidate.player.id, { rates: [] as (number | null)[], games: [] as number[], usable: [] as number[] }]));
  const total = candidates.length * count;
  onProgress?.({ completed: 0, total });
  let progress = 0;
  for (let scenario = 0; scenario < count; scenario++) {
    for (const candidate of candidates) {
      const result = completeDraftScenario(completion, scenario, candidate.player.id), outcome = outcomes.get(candidate.player.id)!;
      let rate: number | null = null;
      if (result.valid && result.available && result.forcedCandidateRetained) {
        const own = evaluator.evaluate(result.teams.get(input.franchiseId)!);
        const opponents = [...result.teams].filter(([id]) => id !== input.franchiseId).map(([, players]) => evaluator.evaluate(players));
        if (own.totals && opponents.every(value => value.totals)) rate = evaluator.compare(own, opponents).winRate;
        if (rate !== null) { outcome.games.push(own.games.get(candidate.player.id) ?? 0); outcome.usable.push(own.usable.get(candidate.player.id) ?? 0); }
      }
      outcome.rates.push(rate);
      if (++progress % 16 === 0 || progress === total) onProgress?.({ completed: progress, total });
    }
  }
  const selectedBaselines = baselines.map(value => value.comparisons.get(input.franchiseId)!.winRate!);
  for (const candidate of report.candidates) {
    const outcome = outcomes.get(candidate.player.id);
    if (!outcome) { candidate.blocked = true; candidate.reasons.push('No usable projection, schedule eligibility, or future draft opportunity in this model.'); continue; }
    const summary = summarizeDraftCandidateScenarios(selectedBaselines, outcome.rates);
    report.forecast.candidateRanges.push({ playerId: candidate.player.id, min: summary.availableScenarios ? summary.min : null, max: summary.availableScenarios ? summary.max : null,
      availableScenarios: summary.availableScenarios, scenarioCount: count, conditionalWinRate: summary.conditionalWinRate, conditionalGain: summary.conditionalGain });
    if (!summary.availableScenarios) { candidate.blocked = true; candidate.reasons.push('Not available and retained at your next pick in any modeled scenario.'); continue; }
    candidate.categoryWinRate = summary.winRate; candidate.scheduleWinRate = summary.winRate;
    candidate.categoryGain = summary.gain; candidate.scheduleGain = summary.gain; candidate.fitScore = summary.winRate;
    candidate.scheduledGames = Math.round(mean(outcome.games)); candidate.usableGames = Math.round(mean(outcome.usable));
    candidate.reasons.push(`Available and retained at your next pick in ${summary.availableScenarios}/${count} scenarios; rates include the ordinary-pick fallback when unavailable.`, 'Games usable in the completed roster, averaged over scenarios where selected. No extra fit bonus or center penalty.');
  }
  const ranked = report.candidates.filter(candidate => !candidate.blocked && candidate.scheduleWinRate !== null)
    .sort((a, b) => b.scheduleWinRate! - a.scheduleWinRate! || (b.scheduleGain ?? 0) - (a.scheduleGain ?? 0) || (a.player.rank ?? Infinity) - (b.player.rank ?? Infinity) || a.player.id - b.player.id);
  report.scheduleRecommendation = ranked[0] ?? null; report.categoryRecommendation = ranked[0] ?? null; report.fitRecommendation = ranked[0] ?? null;
  report.fitRanking = ranked.slice(0, 15); report.evaluatedCandidates = candidates.length;
  return report;
}
