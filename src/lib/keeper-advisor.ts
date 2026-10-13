import { DEFAULT_KEEPER_RULES, evaluateKeeperEligibility, type KeeperCycle } from '../domain/keepers';
import { keeperPaymentOptions, type PaymentAssignment } from './keeper-payment-options';
import { validatePlanner } from './planner';
import type { DraftPlayerCatalog } from './draft-player-catalog';
import { draftProjectionDatasetSchema, type DraftPlayerProjection, type DraftProjectionDataset, type DraftProjectionSource } from './draft-projections';
import type { LeagueData, LeaguePlayer } from './types';

export type KeeperAdvisorRow = {
  player: LeaguePlayer;
  keep: boolean | null;
  projectedRank: number | null;
  projectedRound: number | null;
  baseCost: number | null;
  /** The joint recommendation's payment when kept; otherwise the best individual legal payment. */
  paymentRound: number | null;
  pickId: string | null;
  /** Positive means projected earlier-round value for a later-round payment. */
  roundSavings: number | null;
  reasons: string[];
};
export type KeeperAdvisorReport = {
  teamId: number;
  source: DraftProjectionSource | null;
  rows: KeeperAdvisorRow[];
  assignments: PaymentAssignment[];
  warnings: string[];
  methodology: string[];
};
export type KeeperAdvisorInput = {
  teamId: number;
  leagueData: LeagueData;
  catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>;
  projections: DraftProjectionDataset | null;
  usedPickIds?: string[];
  /** Confirmed revealed keeper payments only; never picks consumed by actual draft selections. */
  reusablePickIds?: string[];
};

function cycle(player: LeaguePlayer, season: number): KeeperCycle {
  return {
    playerId: String(player.id), lastSeason: season - 1, tenureYears: player.tenure, nextKeeperRound: player.baseCost,
    source: player.wasKept ? 'keeper' : player.previousRound === null ? 'undrafted' : 'fresh-draft',
    firstRoundDraftIneligible: !player.wasKept && player.previousRound === 1,
  };
}

/** Source statistics determine the rank; a provider's rank and ESPN's draft rank are not substituted. */
export function rankKeeperProjections(players: DraftPlayerProjection[]): { id: number; rank: number; score: number }[] {
  if (!players.length) return [];
  const fga = players.reduce((sum, player) => sum + player.stats.fga, 0);
  const fta = players.reduce((sum, player) => sum + player.stats.fta, 0);
  const fg = fga ? players.reduce((sum, player) => sum + player.stats.fgm, 0) / fga : 0;
  const ft = fta ? players.reduce((sum, player) => sum + player.stats.ftm, 0) / fta : 0;
  const values = players.map(player => {
    const s = player.stats;
    return [s.pts, s.reb, s.ast, s.stl, s.blk, s.three, -s.tov, s.fgm - fg * s.fga, s.ftm - ft * s.fta];
  });
  const means = values[0].map((_, index) => values.reduce((sum, row) => sum + row[index], 0) / players.length);
  const deviations = means.map((mean, index) => Math.sqrt(values.reduce((sum, row) => sum + (row[index] - mean) ** 2, 0) / players.length));
  const ranked = players.map((player, index) => ({ id: player.id, name: player.name, score: values[index].reduce((sum, value, column) => sum + (deviations[column] > 1e-9 ? (value - means[column]) / deviations[column] : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id - b.id);
  let rank = 1;
  return ranked.map((player, index) => {
    if (index > 0 && Math.abs(player.score - ranked[index - 1].score) > 1e-9) rank = index + 1;
    return { id: player.id, score: player.score, rank };
  });
}

export function buildKeeperAdvisor(input: KeeperAdvisorInput): KeeperAdvisorReport {
  const { leagueData: data, teamId, catalog, projections } = input;
  const roster = data.players.filter(player => player.teamId === teamId).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const rows: KeeperAdvisorRow[] = roster.map(player => ({ player, keep: null, projectedRank: null, projectedRound: null, baseCost: player.baseCost, paymentRound: null, pickId: null, roundSavings: null, reasons: [] }));
  for (const row of rows) {
    const eligibility = evaluateKeeperEligibility(cycle(row.player, data.season));
    const knownViolations = eligibility.issues.filter(issue => !['unknown_tenure', 'unknown_cost'].includes(issue.code));
    if (row.player.status === 'ineligible' || (row.player.status !== 'review' && knownViolations.length > 0)) {
      row.keep = false;
      row.reasons.push(row.player.reason || 'This player is ineligible under the keeper rules.', ...knownViolations.map(issue => issue.message));
    }
  }
  const report: KeeperAdvisorReport = {
    teamId, source: projections?.source ?? null, rows, assignments: [], warnings: [],
    methodology: [
      'Projection ranks sum equally weighted per-game z-scores across nine categories. FG% and FT% use makes minus league-average makes at the player’s attempt volume; fewer turnovers is better.',
      'Projected round is the player’s rank divided by the number of league teams, rounded up. These are model-derived rounds within the imported player pool, not provider ranks or a prediction of draft position.',
      'Round savings = actual payment round minus projected round. The recommendation maximizes total positive round savings across a jointly legal keeper set using currently owned picks and the existing keeper rules. Confirmed keeper payment reservations can be reconsidered here; picks spent on actual draft selections remain unavailable.',
      'A Don’t keep row shows its best individual legal payment; that pick may instead be assigned to another recommended keeper. Equal-round value is not recommended. Per-game value does not include injuries, games missed, category punts or future seasons.',
    ],
  };
  const unavailable = (reason: string) => { report.warnings.push(reason); for (const row of rows) row.reasons.push(reason); return report; };
  if (!data.teams.some(team => team.id === teamId) || data.teams.length < 2 || new Set(data.teams.map(team => team.id)).size !== data.teams.length) return unavailable('Verified league participants are required to convert projected rank into a round.');
  if (new Set(data.players.map(player => player.id)).size !== data.players.length || new Set(data.picks.map(pick => pick.id)).size !== data.picks.length) return unavailable('Duplicate player or pick identities must be reconciled before recommending keepers.');
  if (!projections) return unavailable('Import this source’s projections to evaluate keeper value.');
  if (!draftProjectionDatasetSchema.safeParse(projections).success) return unavailable('This projection dataset could not be verified. Import it again.');
  if (projections.seasonId !== data.season + 1 || catalog.espnSeasonId !== projections.seasonId) return unavailable('Keeper recommendations need projections and an ESPN catalog for this upcoming NBA season.');
  const selectable = new Set(catalog.players.filter(player => player.selectable).map(player => player.id));
  const pool = projections.players.filter(player => selectable.has(player.id));
  const requiredPool = data.teams.length * DEFAULT_KEEPER_RULES.draftRounds;
  if (pool.length < requiredPool) return unavailable(`This source has ${pool.length} matched draftable projections; at least ${requiredPool} are needed to estimate rounds across this league’s ${DEFAULT_KEEPER_RULES.draftRounds}-round draft.`);
  const ranking = new Map(rankKeeperProjections(pool).map(player => [player.id, player]));
  report.warnings.push(`Ranks are calculated within ${pool.length} matched draftable players from this source. Incomplete imports can overstate value; compare coverage across all sources.`);
  if (pool.some(player => player.games === 0)) report.warnings.push('Some projections have zero expected games. Their per-game ranks are shown, but they are not recommended as keepers.');
  const sourcePlayers = new Map(pool.map(player => [player.id, player]));
  const used = new Set(input.usedPickIds);
  const reusable = new Set(input.reusablePickIds);
  // Confirmed keeper reservations may participate in a hypothetical keeper set;
  // actual draft selections remain consumed. Neither path changes the ledger.
  const availableData = { ...data, picks: data.picks.filter(pick => !used.has(pick.id) || (reusable.has(pick.id) && pick.ownerTeamId === teamId)) };
  const owned = availableData.picks.filter(pick => pick.ownerTeamId === teamId && pick.season === data.season);
  const pickById = new Map(owned.map(pick => [pick.id, pick]));
  if (!owned.length) report.warnings.push('This team has no unused payment picks in the upcoming draft.');
  const eligible: KeeperAdvisorRow[] = [];
  for (const row of rows) {
    const rank = ranking.get(row.player.id);
    if (!rank) { row.reasons.push('No complete draftable projection matched this player in this source.'); continue; }
    row.projectedRank = rank.rank;
    row.projectedRound = Math.ceil(rank.rank / data.teams.length);
    if (row.keep === false) continue;
    const validity = evaluateKeeperEligibility(cycle(row.player, data.season));
    if (row.player.status === 'review' || validity.issues.some(issue => ['unknown_tenure', 'unknown_cost'].includes(issue.code))) {
      row.reasons.push(row.player.reason || 'Keeper history needs commissioner verification.', ...validity.issues.map(issue => issue.message)); continue;
    }
    if (row.player.status === 'ineligible' || !validity.valid) {
      row.keep = false; row.reasons.push(row.player.reason || 'This player is ineligible under the keeper rules.', ...validity.issues.map(issue => issue.message)); continue;
    }
    const allocation = keeperPaymentOptions({ season: data.season, teamId, picks: availableData.picks, includeOptions: false, keepers: [{ playerId: row.player.id, pickId: '', baseRound: row.baseCost }] }).assignments;
    if (!allocation || validatePlanner(teamId, allocation, availableData).length) {
      row.keep = false; row.reasons.push('There is no legal unused pick owned by this team that can pay this keeper cost.'); continue;
    }
    row.pickId = allocation[0].pickId;
    row.paymentRound = pickById.get(row.pickId)!.round;
    row.roundSavings = row.paymentRound - row.projectedRound;
    row.keep = false;
    if (sourcePlayers.get(row.player.id)?.games === 0) row.reasons.push('This source projects zero games; per-game value alone cannot justify keeping the player.');
    else if (row.roundSavings <= 0) row.reasons.push(`Projected round ${row.projectedRound} does not beat the best legal round-${row.paymentRound} payment.`);
    else eligible.push(row);
  }

  // Explore valuable subsets, allocating each through the existing payment helper.
  // Individual savings form an upper bound: pick competition can only make payments earlier.
  const candidates = eligible.sort((a, b) => b.roundSavings! - a.roundSavings! || a.projectedRank! - b.projectedRank! || a.player.id - b.player.id);
  const suffix = new Array<number>(candidates.length + 1).fill(0);
  for (let index = candidates.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + candidates[index].roundSavings!;
  const largestPayments = owned.map(pick => pick.round).sort((a, b) => b - a);
  const paymentSums = [0];
  for (const round of largestPayments) paymentSums.push(paymentSums.at(-1)! + round);
  let bestScore = 0, bestAssignments: PaymentAssignment[] = [];
  const optimize = (index: number, selected: KeeperAdvisorRow[], bound: number) => {
    if (bound + suffix[index] < bestScore) return;
    // A second upper bound respects distinct picks while ignoring keeper-cost limits.
    // Ignoring a constraint can only improve this bound; the canonical helper still
    // makes every actual allocation and validates the final candidate set below.
    const remainingRounds = candidates.slice(index).map(row => row.projectedRound!).sort((a, b) => a - b);
    const selectedRounds = selected.reduce((sum, row) => sum + row.projectedRound!, 0);
    const capacity = Math.min(remainingRounds.length, DEFAULT_KEEPER_RULES.maximumKeeperCount - selected.length, owned.length - selected.length);
    if (capacity < 0) return;
    let optimisticScore = Number.NEGATIVE_INFINITY, optimisticCount = 0, extraRounds = 0;
    for (let extra = 0; extra <= capacity; extra += 1) {
      if (extra) extraRounds += remainingRounds[extra - 1];
      const score = paymentSums[selected.length + extra] - selectedRounds - extraRounds;
      if (score > optimisticScore) { optimisticScore = score; optimisticCount = selected.length + extra; }
    }
    if (optimisticScore < bestScore || (optimisticScore === bestScore && optimisticCount >= bestAssignments.length)) return;
    if (index === candidates.length || selected.length === DEFAULT_KEEPER_RULES.maximumKeeperCount) {
      if (!selected.length) return;
      const allocation = keeperPaymentOptions({ season: data.season, teamId, picks: availableData.picks, includeOptions: false, keepers: selected.map(row => ({ playerId: row.player.id, pickId: row.pickId!, baseRound: row.baseCost })) }).assignments;
      if (!allocation || validatePlanner(teamId, allocation, availableData).length) return;
      const score = allocation.reduce((sum, assignment) => sum + pickById.get(assignment.pickId)!.round - selected.find(row => row.player.id === assignment.playerId)!.projectedRound!, 0);
      if (score > bestScore || (score === bestScore && allocation.length < bestAssignments.length)) { bestScore = score; bestAssignments = allocation; }
      return;
    }
    optimize(index + 1, [...selected, candidates[index]], bound + candidates[index].roundSavings!);
    optimize(index + 1, selected, bound);
  };
  optimize(0, [], 0);
  report.assignments = bestAssignments;
  const assignments = new Map(bestAssignments.map(assignment => [assignment.playerId, assignment.pickId]));
  for (const row of eligible) {
    const pickId = assignments.get(row.player.id);
    if (pickId) {
      row.keep = true; row.pickId = pickId; row.paymentRound = pickById.get(pickId)!.round;
      row.roundSavings = row.paymentRound - row.projectedRound!;
      row.reasons.push(`Projected round ${row.projectedRound} value for a legal round-${row.paymentRound} payment saves ${row.roundSavings} round${row.roundSavings === 1 ? '' : 's'}.`);
      if (row.paymentRound < row.baseCost!) row.reasons.push('The payment is earlier than the underlying keeper cost because of the available pick inventory and competing keepers.');
    } else {
      row.reasons.push('Other keepers produce at least as much total round savings with this team’s available picks. This individual payment is not reserved for this player.');
      const assignedElsewhere = bestAssignments.find(assignment => assignment.pickId === row.pickId);
      if (assignedElsewhere) row.reasons.push(`The best individual payment is allocated to ${roster.find(player => player.id === assignedElsewhere.playerId)?.name ?? 'another recommended keeper'}.`);
    }
  }
  return report;
}
