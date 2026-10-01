import assert from "node:assert/strict";
import test from "node:test";
import { buildSnakeDraftBoard, createEightTeamLottery, createSeededRng, decomposeBirkhoff, generateDraftPicks, sampleLottery } from "../../src/domain";

const nonPlayoff = ["n1", "n2", "n3", "n4"];
const playoff = ["p1", "p2", "p3", "p4"];

test("snake boards support eight or ten teams and attach traded picks to originating slots", () => {
  for (const size of [8, 10]) {
    const franchises = Array.from({ length: size }, (_, index) => String(index));
    const picks = generateDraftPicks({ season: 2026, franchiseIds: franchises, rounds: 13 });
    const traded = { ...picks[0], ownerFranchiseId: franchises[1] };
    const board = buildSnakeDraftBoard([traded, ...picks.slice(1)], franchises);
    assert.equal(board.length, size * 13);
    assert.equal(board[0].id, traded.id);
    assert.equal(board[0].ownerFranchiseId, franchises[1]);
    assert.equal(board[0].originalFranchiseId, franchises[0]);
    assert.deepEqual(board.slice(size, size * 2).map((pick) => pick.originalFranchiseId), [...franchises].reverse());
    const reversed = buildSnakeDraftBoard(picks, [...franchises].reverse());
    assert.equal(reversed.find((pick) => pick.id === traded.id)?.overallPick, size);
  }
});

test("an incomplete draft ledger fails instead of silently shifting pick identities", () => {
  const picks = generateDraftPicks({ season: 2026, franchiseIds: ["a", "b"], rounds: 2 });
  assert.throws(() => buildSnakeDraftBoard(picks.slice(1), ["a", "b"]), /incomplete/);
});

test("Birkhoff mixture reconstructs every one of the sixty-four confirmed marginals", () => {
  const config = createEightTeamLottery({ nonPlayoffFranchiseIds: nonPlayoff, playoffFranchiseIds: playoff });
  const components = decomposeBirkhoff(config.marginalMatrix);
  const reconstructed = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  for (const component of components) {
    assert.equal(new Set(component.permutation).size, 8);
    component.permutation.forEach((column, row) => { reconstructed[row][column] += component.weight; });
  }
  assert.ok(Math.abs(components.reduce((sum, component) => sum + component.weight, 0) - 1) < 1e-10);
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
    assert.ok(Math.abs(reconstructed[row][column] - config.marginalMatrix[row][column]) < 1e-10, `marginal ${row}/${column}`);
  }
  assert.equal(reconstructed[0][0].toFixed(2), "0.24");
  assert.equal(reconstructed[7][4].toFixed(2), "0.24");
});

test("lottery audit replays the complete choice priority from its recorded random draw", () => {
  const config = createEightTeamLottery({ nonPlayoffFranchiseIds: nonPlayoff, playoffFranchiseIds: playoff });
  const result = sampleLottery(config, createSeededRng("season-2026-audit"));
  assert.deepEqual(sampleLottery(config, () => result.audit.randomDraw), result);
  assert.equal(new Set(result.priorityOrder).size, 8);
  assert.deepEqual(sampleLottery(config, createSeededRng("season-2026-audit")), result);
  assert.equal(new Set(sampleLottery(config, () => 0).priorityOrder).size, 8);
  assert.equal(new Set(sampleLottery(config, () => 0.999999999).priorityOrder).size, 8);
});

test("expansion requires explicit odds instead of invented ten-team defaults", () => {
  assert.throws(() => createEightTeamLottery({ nonPlayoffFranchiseIds: [...nonPlayoff, "n5"], playoffFranchiseIds: [...playoff, "p5"] }), /explicit matrix/);
  const explicit = { franchiseIds: Array.from({ length: 10 }, (_, index) => String(index)), marginalMatrix: Array.from({ length: 10 }, () => Array<number>(10).fill(0.1)) };
  assert.equal(sampleLottery(explicit, () => 0.5).priorityOrder.length, 10);
});

test("invalid matrices and random draws fail before producing a lottery result", () => {
  assert.throws(() => decomposeBirkhoff([[0.5, 0.5], [0.2, 0.8]]), /sum to one/);
  const config = createEightTeamLottery({ nonPlayoffFranchiseIds: nonPlayoff, playoffFranchiseIds: playoff });
  assert.throws(() => sampleLottery(config, () => 1), /random source/);
  assert.throws(() => sampleLottery(config, () => Number.NaN), /random source/);
});
