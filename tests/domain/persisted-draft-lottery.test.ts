import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { calculateWeightedLotteryMarginals, replayWeightedLottery, type WeightedLotteryConfiguration } from '../../src/domain/lottery';
import { draftLotteryActionSchema } from '../../src/lib/draft-lottery';

test('persisted odds match all 40,320 sequential weighted permutations and the notebook first-row weights', async () => {
  const migration = await readFile(new URL('../../supabase/migrations/20261003000012_draft_lottery.sql', import.meta.url), 'utf8');
  const definition = JSON.parse(migration.split('$lottery_definition$')[1]) as {
    configuration: WeightedLotteryConfiguration & { marginalMatrix: number[][] }; typeScriptSource: string; algorithmSourceSha256: string;
    pythonSource: string; pythonSourceSha256: string;
    standings: { franchiseId: string; managerLabel: string; regularSeasonPlace: number; playoffQualified: boolean }[];
  };
  const ordered = [...definition.standings].sort((a, b) => b.regularSeasonPlace - a.regularSeasonPlace);
  const configuration = { franchiseIds: ordered.map(t => t.franchiseId), weights: ordered.map(t => t.playoffQualified ? 1 : 24) };
  assert.deepEqual(ordered.map(t => t.managerLabel), ['Wyndham', 'Sebastian', 'Shane', 'Alex', 'Jon', 'Arod', 'Amber', 'James']);
  assert.deepEqual(configuration.weights, [24, 24, 24, 24, 1, 1, 1, 1]);
  const matrix = calculateWeightedLotteryMarginals(configuration);
  assert.deepEqual(definition.configuration, { ...configuration, marginalMatrix: matrix });
  // Independent brute-force permutation tree, rather than repeating the subset DP.
  const enumerated = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  let permutations = 0, atLeastOnePlayoffTopFour = 0;
  const visit = (chosen: number[], remaining: number[], probability: number) => {
    if (remaining.length === 0) {
      permutations += 1;
      chosen.forEach((column, priority) => { enumerated[priority][column] += probability; });
      if (chosen.slice(0, 4).some(column => column >= 4)) atLeastOnePlayoffTopFour += probability;
      return;
    }
    const total = remaining.reduce((sum, column) => sum + configuration.weights[column], 0);
    for (const column of remaining) visit([...chosen, column], remaining.filter(other => other !== column), probability * configuration.weights[column] / total);
  };
  visit([], [0, 1, 2, 3, 4, 5, 6, 7], 1);
  assert.equal(permutations, 40320);
  const expectedNonPlayoffPercentages = [24, 23.70653907496012, 23.161079521981787, 21.76954028164829, 6.256365655147396, 1.0060358874183184, .09603807345819734, .004401505385850244];
  for (let row = 0; row < 8; row++) {
    assert.ok(Math.abs(matrix[row].reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    for (let column = 0; column < 8; column++) {
      assert.ok(Math.abs(matrix[row][column] - enumerated[row][column]) < 1e-12, `${row}/${column}`);
      assert.ok(Math.abs(matrix[row][column] * 100 - (column < 4 ? expectedNonPlayoffPercentages[row] : 25 - expectedNonPlayoffPercentages[row])) < 1e-10);
    }
    assert.ok(Math.abs(matrix.reduce((sum, values) => sum + values[row], 0) - 1) < 1e-12);
  }
  assert.ok(Math.abs(matrix.slice(0, 4).reduce((sum, row) => sum + row[0], 0) * 100 - 92.6371588785902) < 1e-10);
  assert.ok(Math.abs(atLeastOnePlayoffTopFour * 100 - 28.04164256795836) < 1e-10);
  assert.equal(definition.typeScriptSource, (await readFile(new URL('../../src/domain/lottery.ts', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'));
  assert.equal(definition.algorithmSourceSha256, createHash('sha256').update(definition.typeScriptSource).digest('hex'));
  assert.equal(definition.pythonSourceSha256, createHash('sha256').update(definition.pythonSource).digest('hex'));
  assert.equal(definition.pythonSourceSha256, 'ca7657930bff31d9c1ba8abc069fbd8e659224fe5478f719291be18bf679a84c');
  assert.match(definition.pythonSource, /np\.random\.choice\(managers, len\(managers\),p = probabilities, replace = False\)/);
  assert.match(definition.pythonSource, /probabilities = \[\.24, \.24, \.24, \.24, \.01, \.01, \.01, \.01\]/);
});

test('integer replay respects remaining weight boundaries, removes selected teams, and rejects malformed tickets', () => {
  const configuration = { franchiseIds: ['a', 'b', 'c'], weights: [24, 1, 1] };
  assert.deepEqual(replayWeightedLottery(configuration, [24, 24, 0]), {
    priorityOrder: ['b', 'c', 'a'], steps: [
      { priority: 1, remainingTotal: 26, ticket: 24, selectedFranchiseId: 'b' },
      { priority: 2, remainingTotal: 25, ticket: 24, selectedFranchiseId: 'c' },
      { priority: 3, remainingTotal: 24, ticket: 0, selectedFranchiseId: 'a' },
    ],
  });
  assert.deepEqual(replayWeightedLottery(configuration, [23, 1, 0]).priorityOrder, ['a', 'c', 'b']);
  for (const tickets of [[26, 0, 0], [-1, 0, 0], [0.5, 0, 0], [0, 2, 0], [0, 0]]) assert.throws(() => replayWeightedLottery(configuration, tickets), /ticket/);
  assert.throws(() => calculateWeightedLotteryMarginals({ franchiseIds: ['a', 'a'], weights: [1, 1] }), /distinct franchises/);
  assert.throws(() => calculateWeightedLotteryMarginals({ franchiseIds: ['a', 'b'], weights: [0, 1] }), /positive integer/);
});

test('official lottery requests cannot supply seeds, random values, permutations, or configuration', () => {
  const request = { action: 'generate', seasonId: '73000000-0000-4000-8000-000000000001' };
  assert.equal(draftLotteryActionSchema.safeParse(request).success, true);
  for (const key of ['seed', 'randomDraw', 'randomTicket', 'tickets', 'weights', 'priorityOrder', 'configuration']) assert.equal(draftLotteryActionSchema.safeParse({ ...request, [key]: 0 }).success, false);
});
