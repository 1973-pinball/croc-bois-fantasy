/** Official rule: the notebook's NumPy weighted draw without replacement. */
export interface WeightedLotteryConfiguration {
  franchiseIds: readonly string[];
  /** Positive integer weights remain unchanged until that franchise is selected. */
  weights: readonly number[];
}

export interface WeightedLotteryStep {
  priority: number;
  remainingTotal: number;
  ticket: number;
  selectedFranchiseId: string;
}

function validateWeightedConfiguration(configuration: WeightedLotteryConfiguration): void {
  const { franchiseIds, weights } = configuration;
  if (franchiseIds.length < 2 || franchiseIds.length > 16 || weights.length !== franchiseIds.length
    || new Set(franchiseIds).size !== franchiseIds.length || franchiseIds.some(id => !id)
    || weights.some(weight => !Number.isSafeInteger(weight) || weight <= 0)
    || weights.reduce((sum, weight) => sum + weight, 0) > 4294967296) {
    throw new Error('Weighted lotteries require 2–16 distinct franchises with positive integer weights totaling at most 2^32.');
  }
}

/** Exact unconditional priority probabilities, calculated over all subsets of selected teams. */
export function calculateWeightedLotteryMarginals(configuration: WeightedLotteryConfiguration): number[][] {
  validateWeightedConfiguration(configuration);
  const { weights } = configuration;
  const size = weights.length;
  const probabilities = Array<number>(1 << size).fill(0);
  const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0));
  probabilities[0] = 1;
  for (let mask = 0; mask < probabilities.length - 1; mask += 1) {
    let priority = 0;
    let remainingTotal = 0;
    for (let column = 0; column < size; column += 1) {
      if (mask & (1 << column)) priority += 1;
      else remainingTotal += weights[column];
    }
    for (let column = 0; column < size; column += 1) {
      if (mask & (1 << column)) continue;
      const probability = probabilities[mask] * weights[column] / remainingTotal;
      matrix[priority][column] += probability;
      probabilities[mask | (1 << column)] += probability;
    }
  }
  return matrix;
}

/** Reference replay of the database's unbiased integer tickets; this does not generate randomness. */
export function replayWeightedLottery(configuration: WeightedLotteryConfiguration, tickets: readonly number[]): {
  priorityOrder: string[]; steps: WeightedLotteryStep[];
} {
  validateWeightedConfiguration(configuration);
  if (tickets.length !== configuration.franchiseIds.length) throw new Error('A replay requires one ticket for every priority.');
  const remainingWeights = [...configuration.weights];
  const steps: WeightedLotteryStep[] = [];
  for (const [index, ticket] of tickets.entries()) {
    const remainingTotal = remainingWeights.reduce((sum, weight) => sum + weight, 0);
    if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= remainingTotal) throw new Error('A ticket must be an integer in [0, remainingTotal).');
    let cumulative = 0;
    const column = remainingWeights.findIndex(weight => { cumulative += weight; return ticket < cumulative; });
    steps.push({ priority: index + 1, remainingTotal, ticket, selectedFranchiseId: configuration.franchiseIds[column] });
    remainingWeights[column] = 0;
  }
  return { priorityOrder: steps.map(step => step.selectedFranchiseId), steps };
}

// Generic matrix/Birkhoff utilities below are retained for simulations and are not
// the official weighted-without-replacement lottery executed by the database.
export interface LotteryConfiguration {
  franchiseIds: readonly string[];
  /** Rows are selection priorities; columns correspond to franchiseIds. */
  marginalMatrix: readonly (readonly number[])[];
}

export interface LotteryComponent {
  weight: number;
  /** For each priority, the franchise column assigned to that priority. */
  permutation: number[];
}

export interface LotteryAudit {
  algorithm: "birkhoff-v1";
  franchiseIds: string[];
  marginalMatrix: number[][];
  components: LotteryComponent[];
  randomDraw: number;
  selectedComponent: number;
}

export interface LotteryResult {
  /** This is the order in which teams choose draft positions, not the draft positions themselves. */
  priorityOrder: string[];
  audit: LotteryAudit;
}

const EPSILON = 1e-12;

export function createEightTeamLottery(input: {
  nonPlayoffFranchiseIds: readonly string[];
  playoffFranchiseIds: readonly string[];
}): LotteryConfiguration {
  if (input.nonPlayoffFranchiseIds.length !== 4 || input.playoffFranchiseIds.length !== 4) {
    throw new Error("This legacy matrix example applies to four non-playoff and four playoff teams; other formats require an explicit matrix.");
  }
  const franchiseIds = [...input.nonPlayoffFranchiseIds, ...input.playoffFranchiseIds];
  if (new Set(franchiseIds).size !== 8 || franchiseIds.some((id) => !id)) throw new Error("Lottery franchises must be distinct.");
  const nonPlayoffOdds = [24, 23, 22, 21, 4, 3, 2, 1];
  const playoffOdds = [1, 2, 3, 4, 21, 22, 23, 24];
  return {
    franchiseIds,
    marginalMatrix: nonPlayoffOdds.map((odds, priority) => [
      ...Array<number>(4).fill(odds / 100), ...Array<number>(4).fill(playoffOdds[priority] / 100),
    ]),
  };
}

function validateMatrix(matrix: readonly (readonly number[])[]): void {
  const size = matrix.length;
  if (size < 2 || matrix.some((row) => row.length !== size)) throw new Error("A lottery requires a square marginal matrix with at least two teams.");
  if (matrix.some((row) => row.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error("Lottery probabilities must lie between zero and one.");
  for (let index = 0; index < size; index += 1) {
    const rowSum = matrix[index].reduce((sum, value) => sum + value, 0);
    const columnSum = matrix.reduce((sum, row) => sum + row[index], 0);
    if (Math.abs(rowSum - 1) > EPSILON || Math.abs(columnSum - 1) > EPSILON) {
      throw new Error("Each lottery row and column must sum to one.");
    }
  }
}

/** Exact marginal preservation via a mixture of complete permutations, not sequential weighted draws. */
export function decomposeBirkhoff(matrix: readonly (readonly number[])[]): LotteryComponent[] {
  validateMatrix(matrix);
  const residual = matrix.map((row) => [...row]);
  const size = residual.length;
  const components: LotteryComponent[] = [];
  let remaining = 1;
  while (remaining > EPSILON) {
    const columnToRow = Array<number>(size).fill(-1);
    const matchRow = (row: number, seenColumns: boolean[]): boolean => {
      for (let column = 0; column < size; column += 1) {
        if (residual[row][column] <= EPSILON || seenColumns[column]) continue;
        seenColumns[column] = true;
        if (columnToRow[column] === -1 || matchRow(columnToRow[column], seenColumns)) {
          columnToRow[column] = row;
          return true;
        }
      }
      return false;
    };
    for (let row = 0; row < size; row += 1) {
      if (!matchRow(row, Array<boolean>(size).fill(false))) throw new Error("The marginal matrix cannot be decomposed at the supported precision.");
    }
    const permutation = Array<number>(size).fill(-1);
    columnToRow.forEach((row, column) => { permutation[row] = column; });
    const weight = Math.min(...permutation.map((column, row) => residual[row][column]));
    if (!(weight > EPSILON)) throw new Error("Lottery decomposition did not make progress.");
    components.push({ weight, permutation });
    permutation.forEach((column, row) => { residual[row][column] = Math.max(0, residual[row][column] - weight); });
    remaining -= weight;
    if (components.length > size * size) throw new Error("Lottery decomposition exceeded its finite support bound.");
  }
  if (residual.some((row) => row.some((value) => value > EPSILON * size))) throw new Error("Lottery decomposition left unexplained probability.");
  return components;
}

export function sampleLottery(configuration: LotteryConfiguration, rng: () => number): LotteryResult {
  const { franchiseIds, marginalMatrix } = configuration;
  if (franchiseIds.length !== marginalMatrix.length || new Set(franchiseIds).size !== franchiseIds.length || franchiseIds.some((id) => !id)) {
    throw new Error("Lottery matrix columns must correspond to distinct franchises.");
  }
  const components = decomposeBirkhoff(marginalMatrix);
  const randomDraw = rng();
  if (!Number.isFinite(randomDraw) || randomDraw < 0 || randomDraw >= 1) throw new Error("The random source must return a finite number in [0, 1).");
  let cumulative = 0;
  let selectedComponent = components.length - 1;
  for (const [index, component] of components.entries()) {
    cumulative += component.weight;
    if (randomDraw < cumulative) { selectedComponent = index; break; }
  }
  return {
    priorityOrder: components[selectedComponent].permutation.map((column) => franchiseIds[column]),
    audit: {
      algorithm: "birkhoff-v1", franchiseIds: [...franchiseIds],
      marginalMatrix: marginalMatrix.map((row) => [...row]), components, randomDraw, selectedComponent,
    },
  };
}

/** Deterministic PRNG for simulations/replay. The caller controls production seed selection. */
export function createSeededRng(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
