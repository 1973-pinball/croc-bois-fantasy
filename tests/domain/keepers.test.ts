import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateKeeperEligibility, rolloverKeeperCycle, validateKeeperAssignments,
  type DraftPick, type KeeperCandidate, type KeeperCycle,
} from "../../src/domain";

function cycle(playerId = "player", overrides: Partial<KeeperCycle> = {}): KeeperCycle {
  return { playerId, lastSeason: 2025, tenureYears: 2, nextKeeperRound: 4, source: "keeper", firstRoundDraftIneligible: false, ...overrides };
}
function candidate(playerId: string, overrides: Partial<KeeperCycle> = {}): KeeperCandidate {
  return { playerId, franchiseId: "a", cycle: cycle(playerId, overrides) };
}
function pick(id: string, round: number, overrides: Partial<DraftPick> = {}): DraftPick {
  return { id, round, season: 2026, originalFranchiseId: id, ownerFranchiseId: "a", ...overrides };
}

test("Scottie's earlier payment does not accelerate cost, and his fifth tenure year exhausts eligibility", () => {
  const previous = cycle("scottie", { lastSeason: 2024, tenureYears: 4, nextKeeperRound: 10 });
  const next = rolloverKeeperCycle("scottie", previous, { kind: "kept", season: 2025, paymentRound: 9 });
  assert.equal(next.lastKeeperBaseRound, 10);
  assert.equal(next.lastPaymentRound, 9);
  assert.equal(next.nextKeeperRound, 9);
  assert.equal(next.tenureYears, 5);
  assert.ok(evaluateKeeperEligibility(next).issues.some((issue) => issue.code === "tenure_limit"));
  assert.throws(() => rolloverKeeperCycle("scottie", next, { kind: "kept", season: 2026, paymentRound: 9 }));
});

test("Mobley's fresh round-three draft resets both cost and tenure", () => {
  const previous = cycle("mobley", { lastSeason: 2024, tenureYears: 4, nextKeeperRound: 8 });
  const next = rolloverKeeperCycle("mobley", previous, { kind: "drafted", season: 2025, round: 3 });
  assert.equal(next.nextKeeperRound, 2);
  assert.equal(next.tenureYears, 1);
  assert.equal(evaluateKeeperEligibility(next).valid, true);
});

test("fresh round one is ineligible; fresh round two can consume round one once", () => {
  const first = rolloverKeeperCycle("first", null, { kind: "drafted", season: 2025, round: 1 });
  assert.equal(evaluateKeeperEligibility(first).valid, false);
  const second = rolloverKeeperCycle("second", null, { kind: "drafted", season: 2025, round: 2 });
  assert.equal(evaluateKeeperEligibility(second).valid, true);
  const kept = rolloverKeeperCycle("second", second, { kind: "kept", season: 2026, paymentRound: 1 });
  assert.equal(kept.nextKeeperRound, 0);
  assert.equal(evaluateKeeperEligibility(kept).valid, false);
});

test("waivers and trades preserve the cycle; draft reentry undrafted resets cost to thirteen", () => {
  const original = cycle("player", { nextKeeperRound: 5, tenureYears: 3 });
  assert.deepEqual(rolloverKeeperCycle("player", original, { kind: "traded" }), original);
  assert.deepEqual(rolloverKeeperCycle("player", original, { kind: "waiver-claimed" }), original);
  const undrafted = rolloverKeeperCycle("player", original, { kind: "undrafted", season: 2026, tenureYears: 1 });
  assert.equal(undrafted.nextKeeperRound, 13);
  assert.equal(undrafted.tenureYears, 1);
});

test("unknown tenure is retained as unknown and cannot be approved", () => {
  const unknown = rolloverKeeperCycle("player", null, { kind: "undrafted", season: 2025, tenureYears: null });
  assert.equal(unknown.tenureYears, null);
  assert.ok(evaluateKeeperEligibility(unknown).issues.some((issue) => issue.code === "unknown_tenure"));
});

test("two fourth-round keepers may use fourth and third in either owner-chosen assignment", () => {
  const input = { season: 2026, franchiseId: "a", candidates: [candidate("one"), candidate("two")], picks: [pick("four", 4), pick("three", 3)] };
  const assignments = [{ playerId: "one", pickId: "three" }, { playerId: "two", pickId: "four" }];
  assert.equal(validateKeeperAssignments({ ...input, assignments }).valid, true);
  assert.equal(validateKeeperAssignments({ ...input, assignments: [...assignments].reverse() }).valid, true);
  assert.equal(validateKeeperAssignments({ ...input, assignments: [{ playerId: "one", pickId: "four" }, { playerId: "two", pickId: "three" }] }).valid, true);
});

test("a spare exact-round pick prevents voluntary overpayment even when another keeper uses one", () => {
  const result = validateKeeperAssignments({
    season: 2026, franchiseId: "a", candidates: [candidate("one"), candidate("two")],
    picks: [pick("four-a", 4), pick("four-b", 4), pick("three", 3)],
    assignments: [{ playerId: "one", pickId: "four-a" }, { playerId: "two", pickId: "three" }],
  });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "voluntary_overpayment");
});

test("escalation cannot skip an available intermediate round", () => {
  const result = validateKeeperAssignments({
    season: 2026, franchiseId: "a", candidates: [candidate("one")], picks: [pick("two", 2), pick("three", 3)],
    assignments: [{ playerId: "one", pickId: "two" }],
  });
  assert.equal(result.issues[0].code, "voluntary_overpayment");
});

test("owners retain their choice between multiple picks in the same round", () => {
  const result = validateKeeperAssignments({
    season: 2026, franchiseId: "a", candidates: [candidate("one")], picks: [pick("four-a", 4), pick("four-b", 4)],
    assignments: [{ playerId: "one", pickId: "four-b" }],
  });
  assert.equal(result.valid, true);
});

test("duplicate spending, wrong owner, future season and ineligible candidates all fail", () => {
  const result = validateKeeperAssignments({
    season: 2026, franchiseId: "a", candidates: [candidate("one"), candidate("two", { tenureYears: 5 })],
    picks: [pick("bad", 4, { season: 2027, ownerFranchiseId: "b" })],
    assignments: [{ playerId: "one", pickId: "bad" }, { playerId: "two", pickId: "bad" }],
  });
  for (const code of ["duplicate_payment_pick", "pick_not_owned", "wrong_pick_season", "tenure_limit"]) {
    assert.ok(result.issues.some((issue) => issue.code === code), code);
  }
});

test("a committed exact-round pick permits escalation but cannot be spent again", () => {
  const input = {
    season: 2026, franchiseId: "a", candidates: [candidate("one")],
    picks: [pick("four", 4, { reservedForPlayerId: "already-approved" }), pick("three", 3)],
  };
  assert.equal(validateKeeperAssignments({ ...input, assignments: [{ playerId: "one", pickId: "three" }] }).valid, true);
  assert.ok(validateKeeperAssignments({ ...input, assignments: [{ playerId: "one", pickId: "four" }] }).issues.some((issue) => issue.code === "pick_reserved"));
});
