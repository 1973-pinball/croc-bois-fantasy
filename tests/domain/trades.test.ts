import assert from "node:assert/strict";
import test from "node:test";
import { applyTrade, generateDraftPicks, rolloverKeeperCycle, validateTrade, type TradeProposal, type TradeState } from "../../src/domain";

function state(): TradeState {
  return {
    revision: 7, franchiseIds: ["a", "b", "c"], appliedTradeIds: [],
    players: [
      { id: "player-a", ownerFranchiseId: "a", keeperCycle: rolloverKeeperCycle("player-a", null, { kind: "drafted", season: 2025, round: 6 }) },
      { id: "player-c", ownerFranchiseId: "c" },
    ],
    picks: generateDraftPicks({ season: 2027, franchiseIds: ["a", "b", "c"], rounds: 13 }),
  };
}

test("three-team trade transfers all assets while preserving origins and keeper terms", () => {
  const before = state();
  const original = structuredClone(before);
  const pick = before.picks.find((entry) => entry.originalFranchiseId === "b" && entry.round === 4)!;
  const proposal: TradeProposal = {
    id: "three-way", expectedRevision: 7, transfers: [
      { asset: { kind: "player", id: "player-a" }, fromFranchiseId: "a", toFranchiseId: "b" },
      { asset: { kind: "pick", id: pick.id }, fromFranchiseId: "b", toFranchiseId: "c" },
      { asset: { kind: "player", id: "player-c" }, fromFranchiseId: "c", toFranchiseId: "a" },
    ],
  };
  const after = applyTrade(proposal, before);
  assert.deepEqual(before, original);
  assert.equal(after.revision, 8);
  assert.equal(after.players[0].ownerFranchiseId, "b");
  assert.deepEqual(after.players[0].keeperCycle, original.players[0].keeperCycle);
  assert.equal(after.picks.find((entry) => entry.id === pick.id)?.ownerFranchiseId, "c");
  assert.equal(after.picks.find((entry) => entry.id === pick.id)?.originalFranchiseId, "b");
  assert.ok(validateTrade({ ...proposal, expectedRevision: 8 }, after).issues.some((issue) => issue.code === "trade_already_applied"));
});

test("one invalid leg prevents every leg from applying", () => {
  const before = state();
  const original = structuredClone(before);
  const proposal: TradeProposal = { id: "bad", expectedRevision: 7, transfers: [
    { asset: { kind: "player", id: "player-a" }, fromFranchiseId: "a", toFranchiseId: "b" },
    { asset: { kind: "player", id: "player-c" }, fromFranchiseId: "b", toFranchiseId: "c" },
  ] };
  assert.throws(() => applyTrade(proposal, before), /does not own/);
  assert.deepEqual(before, original);
});

test("same asset cannot be routed twice, stale proposals fail, and self-transfers are rejected", () => {
  const proposal: TradeProposal = { id: "bad", expectedRevision: 6, transfers: [
    { asset: { kind: "player", id: "player-a" }, fromFranchiseId: "a", toFranchiseId: "a" },
    { asset: { kind: "player", id: "player-a" }, fromFranchiseId: "a", toFranchiseId: "c" },
  ] };
  const issues = validateTrade(proposal, state()).issues;
  for (const code of ["asset_double_spend", "stale_trade", "noop_transfer"]) assert.ok(issues.some((issue) => issue.code === code));
});

test("committed keeper picks require release before a trade can consume them", () => {
  const before = state();
  const pick = before.picks[0];
  const reserved: TradeState = { ...before, picks: [{ ...pick, reservedForPlayerId: "player-a" }, ...before.picks.slice(1)] };
  const proposal: TradeProposal = { id: "reserved", expectedRevision: 7, transfers: [{ asset: { kind: "pick", id: pick.id }, fromFranchiseId: "a", toFranchiseId: "b" }] };
  assert.equal(validateTrade(proposal, reserved).issues[0].code, "pick_committed");
});
