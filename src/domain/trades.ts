import type { KeeperCycle } from "./keepers";
import { DomainValidationError, type DraftPick, type RuleIssue, type ValidationResult } from "./types";

export type TradeAsset = { kind: "player"; id: string } | { kind: "pick"; id: string };

export interface TradeTransfer {
  asset: TradeAsset;
  fromFranchiseId: string;
  toFranchiseId: string;
}

export interface TradeProposal {
  id: string;
  expectedRevision: number;
  transfers: readonly TradeTransfer[];
}

export interface TradePlayer {
  id: string;
  ownerFranchiseId: string;
  keeperCycle?: KeeperCycle;
  locked?: boolean;
}

export interface TradeState {
  revision: number;
  franchiseIds: readonly string[];
  players: readonly TradePlayer[];
  picks: readonly DraftPick[];
  appliedTradeIds: readonly string[];
}

export function validateTrade(proposal: TradeProposal, state: TradeState): ValidationResult {
  const issues: RuleIssue[] = [];
  if (!proposal.id) issues.push({ code: "missing_trade_id", message: "A trade requires an ID for replay protection." });
  if (!Number.isInteger(proposal.expectedRevision) || proposal.expectedRevision !== state.revision) issues.push({ code: "stale_trade", message: "The ownership ledger changed; refresh the trade before applying it." });
  if (state.appliedTradeIds.includes(proposal.id)) issues.push({ code: "trade_already_applied", message: "This trade has already been applied." });
  if (!proposal.transfers.length) issues.push({ code: "empty_trade", message: "A trade must transfer at least one asset." });
  if (new Set(state.players.map((player) => player.id)).size !== state.players.length || new Set(state.picks.map((pick) => pick.id)).size !== state.picks.length) {
    issues.push({ code: "duplicate_ledger_asset", message: "The ownership ledger contains duplicate asset identities." });
  }
  const spentAssets = new Set<string>();
  const franchiseIds = new Set(state.franchiseIds);
  for (const [transferIndex, transfer] of proposal.transfers.entries()) {
    const { asset, fromFranchiseId, toFranchiseId } = transfer;
    const addIssue = (code: string, message: string) => issues.push({ code, message, transferIndex });
    if (!franchiseIds.has(fromFranchiseId) || !franchiseIds.has(toFranchiseId)) addIssue("unknown_trade_franchise", "Both sides of an asset transfer must be league franchises.");
    if (fromFranchiseId === toFranchiseId) addIssue("noop_transfer", "An asset cannot be traded to its existing owner.");
    const key = `${asset.kind}:${asset.id}`;
    if (spentAssets.has(key)) addIssue("asset_double_spend", "An asset can appear only once in a trade, including multi-team trades.");
    spentAssets.add(key);
    if (asset.kind === "player") {
      const player = state.players.find((entry) => entry.id === asset.id);
      if (!player) addIssue("unknown_trade_player", "The traded player does not exist in the ownership ledger.");
      else {
        if (player.ownerFranchiseId !== fromFranchiseId) addIssue("asset_not_owned", "The sending franchise does not own the player.");
        if (player.locked) addIssue("player_locked", "The player is locked and cannot be transferred.");
      }
    } else if (asset.kind === "pick") {
      const pick = state.picks.find((entry) => entry.id === asset.id);
      if (!pick) addIssue("unknown_trade_pick", "The traded pick does not exist in the ownership ledger.");
      else {
        if (pick.ownerFranchiseId !== fromFranchiseId) addIssue("asset_not_owned", "The sending franchise does not own the pick.");
        if (pick.reservedForPlayerId || pick.consumedByPlayerId) addIssue("pick_committed", "A committed keeper or draft pick must be released through the approval workflow before it can be traded.");
      }
    } else {
      addIssue("unknown_asset_type", "Only players and draft picks can be transferred.");
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Applies every transfer or none, preserving original pick identity and keeper history. */
export function applyTrade(proposal: TradeProposal, state: TradeState): TradeState {
  const validation = validateTrade(proposal, state);
  if (!validation.valid) throw new DomainValidationError(validation.issues);
  const playerRecipients = new Map(proposal.transfers.filter((transfer) => transfer.asset.kind === "player").map((transfer) => [transfer.asset.id, transfer.toFranchiseId]));
  const pickRecipients = new Map(proposal.transfers.filter((transfer) => transfer.asset.kind === "pick").map((transfer) => [transfer.asset.id, transfer.toFranchiseId]));
  return {
    revision: state.revision + 1,
    franchiseIds: [...state.franchiseIds],
    players: state.players.map((player) => ({ ...player, ownerFranchiseId: playerRecipients.get(player.id) ?? player.ownerFranchiseId })),
    picks: state.picks.map((pick) => ({ ...pick, ownerFranchiseId: pickRecipients.get(pick.id) ?? pick.ownerFranchiseId })),
    appliedTradeIds: [...state.appliedTradeIds, proposal.id],
  };
}
