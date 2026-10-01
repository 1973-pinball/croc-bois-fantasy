import { DomainValidationError, type DraftPick, type RuleIssue, type ValidationResult } from "./types";

export interface KeeperRules {
  draftRounds: number;
  tenureLimit: number;
  maximumKeeperCount: number;
  undraftedInitialKeeperRound: number;
}

export const DEFAULT_KEEPER_RULES: Readonly<KeeperRules> = Object.freeze({
  draftRounds: 13,
  tenureLimit: 5,
  maximumKeeperCount: 13,
  undraftedInitialKeeperRound: 13,
});

/** A cycle belongs to the player, not the current franchise. Null means unknown. */
export interface KeeperCycle {
  playerId: string;
  lastSeason: number;
  tenureYears: number | null;
  nextKeeperRound: number | null;
  source: "fresh-draft" | "keeper" | "undrafted";
  firstRoundDraftIneligible: boolean;
  lastKeeperBaseRound?: number;
  lastPaymentRound?: number;
}

export type KeeperSeasonEvent =
  | { kind: "drafted"; season: number; round: number }
  // The historical convention for undrafted tenure must be provided explicitly.
  | { kind: "undrafted"; season: number; tenureYears: number | null }
  | { kind: "kept"; season: number; paymentRound: number }
  | { kind: "traded" }
  | { kind: "waiver-claimed" };

function resolvedRules(overrides: Partial<KeeperRules> = {}): KeeperRules {
  const rules = { ...DEFAULT_KEEPER_RULES, ...overrides };
  if (Object.values(rules).some((value) => !Number.isInteger(value) || value < 1)
    || rules.undraftedInitialKeeperRound > rules.draftRounds
    || rules.maximumKeeperCount > rules.draftRounds) {
    throw new Error("Keeper rules require positive integers and costs/capacity within the draft rounds.");
  }
  return rules;
}

export function evaluateKeeperEligibility(
  cycle: KeeperCycle,
  overrides: Partial<KeeperRules> = {},
): ValidationResult {
  const rules = resolvedRules(overrides);
  const issues: RuleIssue[] = [];
  const issue = (code: string, message: string) => issues.push({ code, message, playerId: cycle.playerId });
  if (cycle.firstRoundDraftIneligible) issue("first_round_draft", "Players freshly drafted in round one cannot be kept.");
  if (cycle.tenureYears === null) issue("unknown_tenure", "Keeper tenure needs reconciliation before approval.");
  else if (!Number.isInteger(cycle.tenureYears) || cycle.tenureYears < 1) issue("invalid_tenure", "Tenure must include at least the initial season.");
  else if (cycle.tenureYears >= rules.tenureLimit) issue("tenure_limit", `The player has completed ${rules.tenureLimit} tenure seasons.`);
  if (cycle.nextKeeperRound === null) issue("unknown_cost", "The underlying keeper cost needs reconciliation before approval.");
  else if (!Number.isInteger(cycle.nextKeeperRound) || cycle.nextKeeperRound < 1 || cycle.nextKeeperRound > rules.draftRounds) {
    issue("invalid_keeper_cost", "No legal underlying keeper round remains.");
  }
  return { valid: issues.length === 0, issues };
}

/** Returns a new cycle. Draft reentry resets it; a trade or waiver claim never does. */
export function rolloverKeeperCycle(
  playerId: string,
  previous: KeeperCycle | null,
  event: KeeperSeasonEvent,
  overrides: Partial<KeeperRules> = {},
): KeeperCycle {
  const rules = resolvedRules(overrides);
  if (!playerId || (previous && previous.playerId !== playerId)) throw new Error("Player identity must match its keeper cycle.");
  if (event.kind === "traded" || event.kind === "waiver-claimed") {
    if (!previous) throw new Error("A trade or waiver claim requires an existing keeper cycle.");
    return { ...previous };
  }
  if (!Number.isInteger(event.season) || (previous && event.season <= previous.lastSeason)) {
    throw new Error("Season events must advance the keeper cycle.");
  }
  if (event.kind === "drafted") {
    if (!Number.isInteger(event.round) || event.round < 1 || event.round > rules.draftRounds) throw new Error("Draft round is outside the season rules.");
    return {
      playerId, lastSeason: event.season, tenureYears: 1, nextKeeperRound: event.round - 1,
      source: "fresh-draft", firstRoundDraftIneligible: event.round === 1,
    };
  }
  if (event.kind === "undrafted") {
    if (event.tenureYears !== null && (!Number.isInteger(event.tenureYears) || event.tenureYears < 1)) throw new Error("Undrafted tenure must be positive or explicitly unknown.");
    return {
      playerId, lastSeason: event.season, tenureYears: event.tenureYears,
      nextKeeperRound: rules.undraftedInitialKeeperRound, source: "undrafted", firstRoundDraftIneligible: false,
    };
  }
  if (!previous) throw new Error("Retention requires an existing keeper cycle.");
  if (event.season !== previous.lastSeason + 1) throw new Error("Missing seasons must be reconciled before rolling a keeper forward.");
  const eligibility = evaluateKeeperEligibility(previous, rules);
  if (!eligibility.valid) throw new DomainValidationError(eligibility.issues);
  const baseRound = previous.nextKeeperRound!;
  if (!Number.isInteger(event.paymentRound) || event.paymentRound < 1 || event.paymentRound > baseRound) {
    throw new Error("A keeper must be paid with its underlying round or an earlier round.");
  }
  return {
    playerId, lastSeason: event.season, tenureYears: previous.tenureYears! + 1,
    nextKeeperRound: baseRound - 1, source: "keeper", firstRoundDraftIneligible: false,
    lastKeeperBaseRound: baseRound, lastPaymentRound: event.paymentRound,
  };
}

export interface KeeperCandidate {
  playerId: string;
  franchiseId: string;
  cycle: KeeperCycle;
}

export interface KeeperAssignment {
  playerId: string;
  pickId: string;
}

export interface KeeperAssignmentInput {
  season: number;
  franchiseId: string;
  candidates: readonly KeeperCandidate[];
  assignments: readonly KeeperAssignment[];
  picks: readonly DraftPick[];
  rules?: Partial<KeeperRules>;
}

/** Validate the complete chosen set, so competing keepers can legally use earlier picks. */
export function validateKeeperAssignments(input: KeeperAssignmentInput): ValidationResult {
  const rules = resolvedRules(input.rules);
  const issues: RuleIssue[] = [];
  if (input.assignments.length > rules.maximumKeeperCount) issues.push({ code: "keeper_capacity", message: `No more than ${rules.maximumKeeperCount} keepers fit the season roster.` });
  const candidates = new Map(input.candidates.map((candidate) => [candidate.playerId, candidate]));
  const picks = new Map(input.picks.map((pick) => [pick.id, pick]));
  if (candidates.size !== input.candidates.length) issues.push({ code: "duplicate_candidate", message: "The candidate pool contains duplicate player IDs." });
  if (picks.size !== input.picks.length) issues.push({ code: "duplicate_pick_identity", message: "The pick ledger contains duplicate pick IDs." });
  const playersUsed = new Set<string>();
  const picksUsed = new Set<string>();
  for (const assignment of input.assignments) {
    const { playerId, pickId } = assignment;
    const addIssue = (code: string, message: string) => issues.push({ code, message, playerId, pickId });
    if (playersUsed.has(playerId)) addIssue("duplicate_keeper", "A player cannot be submitted twice.");
    if (picksUsed.has(pickId)) addIssue("duplicate_payment_pick", "A pick cannot pay for two keepers.");
    playersUsed.add(playerId);
    picksUsed.add(pickId);
    const candidate = candidates.get(playerId);
    const pick = picks.get(pickId);
    if (!candidate) addIssue("unknown_candidate", "The player is not in the eligible roster pool.");
    else {
      if (candidate.franchiseId !== input.franchiseId) addIssue("player_not_owned", "The player belongs to another franchise.");
      if (candidate.cycle.playerId !== playerId) addIssue("cycle_identity_mismatch", "The keeper history belongs to another player.");
      if (candidate.cycle.lastSeason !== input.season - 1) addIssue("stale_keeper_history", "Keeper history must cover the season immediately before this draft.");
      issues.push(...evaluateKeeperEligibility(candidate.cycle, rules).issues);
    }
    if (!pick) { addIssue("unknown_pick", "The payment pick does not exist."); continue; }
    if (pick.ownerFranchiseId !== input.franchiseId) addIssue("pick_not_owned", "The payment pick belongs to another franchise.");
    if (pick.season !== input.season) addIssue("wrong_pick_season", "A keeper must use a pick in the upcoming draft.");
    if (!Number.isInteger(pick.round) || pick.round < 1 || pick.round > rules.draftRounds) addIssue("invalid_pick_round", "The payment pick is outside this draft's rounds.");
    if (pick.consumedByPlayerId) addIssue("pick_already_consumed", "The payment pick has already been consumed.");
    if (pick.reservedForPlayerId && pick.reservedForPlayerId !== playerId) addIssue("pick_reserved", "The payment pick is reserved for another player.");
    if (candidate?.cycle.nextKeeperRound !== null && candidate?.cycle.nextKeeperRound !== undefined && pick.round > candidate.cycle.nextKeeperRound) {
      addIssue("payment_too_late", "A later round cannot pay an earlier underlying keeper cost.");
    }
  }
  // Invalid assignments cannot reserve picks to justify another keeper's overpayment.
  if (issues.length > 0) return { valid: false, issues };
  for (const assignment of input.assignments) {
    const candidate = candidates.get(assignment.playerId)!;
    const payment = picks.get(assignment.pickId)!;
    const availableBetterPayment = input.picks.find((pick) =>
      pick.ownerFranchiseId === input.franchiseId && pick.season === input.season
      && pick.round > payment.round && pick.round <= candidate.cycle.nextKeeperRound!
      && !pick.consumedByPlayerId && !picksUsed.has(pick.id)
      && (!pick.reservedForPlayerId || pick.reservedForPlayerId === assignment.playerId));
    if (availableBetterPayment) issues.push({
      code: "voluntary_overpayment", playerId: assignment.playerId, pickId: assignment.pickId,
      message: `An available round-${availableBetterPayment.round} pick must be used before paying round ${payment.round}.`,
    });
  }
  return { valid: issues.length === 0, issues };
}
