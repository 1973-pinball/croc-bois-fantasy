import assert from "node:assert/strict";
import test from "node:test";
import { franchiseId, parseOwnerAnnotation, pearsonCorrelation, positionCounts } from "../../scripts/build-analytics";

test("correlation excludes missing/nonfinite observations instead of inventing zeros", () => {
  assert.deepEqual(pearsonCorrelation([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: null, y: 9 }, { x: 5, y: Number.NaN }]), { r: 1, n: 2 });
  assert.deepEqual(pearsonCorrelation([{ x: 1, y: 2 }]), { r: null, n: 1 });
  assert.deepEqual(pearsonCorrelation([{ x: 1, y: 2 }, { x: 1, y: 3 }]), { r: null, n: 2 });
});

test("Graph's eight aggregate observations reproduce its recorded Pearson value", () => {
  const values = [[40,647],[5,574],[3,527],[29,607],[35,587],[11,597],[22,595],[28,516]];
  const result = pearsonCorrelation(values.map(([x,y]) => ({ x,y })));
  assert.equal(result.n, 8);
  assert.ok(result.r !== null && Math.abs(result.r - 0.4899202247) < 1e-9);
});

test("historical owner annotations distinguish pick recipient from original slot", () => {
  const first2018 = parseOwnerAnnotation("James (via Cars)");
  assert.equal(first2018.franchiseId, "7");
  assert.equal(first2018.inferredOriginalFranchiseId, "8");
  assert.equal(first2018.historicalOwner, "James");
  assert.equal(parseOwnerAnnotation("Cars (via James via Wyn)").inferredOriginalFranchiseId, "3");
  assert.equal(parseOwnerAnnotation("James (Edwin (Jon))").inferredOriginalFranchiseId, "1");
  const traded2023 = parseOwnerAnnotation("WYNDHAM TRADE");
  assert.equal(traded2023.franchiseId, "3");
  assert.equal(traded2023.historicalOwner, "WYNDHAM TRADE");
});

test("franchise continuity preserves historical manager labels without creating expansion teams", () => {
  assert.equal(franchiseId("Edwin"), franchiseId("Julian"));
  assert.equal(franchiseId("Julian"), franchiseId("Sebastian Rodriguez"));
  assert.equal(parseOwnerAnnotation("Edwin").historicalOwner, "Edwin");
  assert.equal(franchiseId("Amber"), franchiseId("Justin"));
  assert.equal(franchiseId("Cars"), franchiseId("Alex"));
});

test("position counts retain seasons and tied owners without confusing repeated trade recipients", () => {
  const result = positionCounts([{ season: 2022, franchiseId: "3", position: 1 }, { season: 2023, franchiseId: "3", position: 1 }, { season: 2024, franchiseId: "8", position: 1 }]);
  assert.deepEqual(result, [{ franchiseId: "3", position: 1, count: 2, seasons: [2022,2023] }, { franchiseId: "8", position: 1, count: 1, seasons: [2024] }]);
});
