import { draftOverallPick, type DraftBoard, type DraftBoardPick } from './draft-board';
import type { DraftCatalogPlayer, DraftPlayerCatalog } from './draft-player-catalog';
import { draftProjectionDatasetSchema, type DraftProjectionDataset } from './draft-projections';
import type { DraftRosterEligibility, DraftRosterSettings } from './espn-roster-settings';

export type DraftCompletionInput = {
  board: DraftBoard; catalog: DraftPlayerCatalog; settings: DraftRosterSettings; eligibility: DraftRosterEligibility;
  projections: DraftProjectionDataset | null; franchiseId: string; espnRanks?: ReadonlyMap<number, number>;
  scheduledTeams?: ReadonlySet<string>; scenarioCount?: number; seed?: number; rankJitter?: number;
};
export type DraftCompletionContext = {
  available: boolean; unavailableReason: string | null; warnings: string[]; scenarioCount: number;
  targetPick: DraftBoardPick | null; candidateIds: number[]; franchiseIds: string[]; normalCapacity: number;
};
export type DraftCompletionSelection = { pickId: string; overallPick: number; franchiseId: string; playerId: number };
export type DraftCompletionAddition = { franchiseId: string; playerId: number; reason: 'roster_shortfall' };
export type DraftCompletionCut = { franchiseId: string; playerId: number; wasFixed: boolean; reason: 'roster_capacity' | 'position_limit' | 'slot_eligibility' };
export type DraftCompletionScenario = {
  valid: boolean; available: boolean; reason: string | null; scenarioIndex: number; targetPick: DraftBoardPick | null;
  teams: Map<string, number[]>; picks: DraftCompletionSelection[]; additions: DraftCompletionAddition[]; cuts: DraftCompletionCut[];
  forcedCandidateRetained: boolean | null;
};

type EligiblePlayer = DraftRosterEligibility['players'][number];
type ScenarioPrefix = { order: number[]; orderIndex: Map<number, number>; taken: Set<number>; teams: Map<string, number[]>; picks: DraftCompletionSelection[] };
type Prepared = {
  franchiseId: string; players: Map<number, DraftCatalogPlayer>; eligible: Map<number, EligiblePlayer>;
  ranks: Map<number, number | null>; pool: number[]; poolSet: Set<number>; fixed: Map<string, number[]>;
  remaining: DraftBoardPick[]; targetIndex: number; slots: number[]; primaryLimits: Map<number, number>;
  benchUnlimited: boolean;
  seed: number; jitter: number; prefixes: Map<number, ScenarioPrefix>; baselines: Map<number, DraftCompletionScenario>;
};
// Caches belong to one immutable board/projection preparation, never to global player state.
const preparedContexts = new WeakMap<DraftCompletionContext, Prepared>();
const cloneTeams = (teams: ReadonlyMap<string, readonly number[]>) => new Map([...teams].map(([id, players]) => [id, [...players]]));
const normalizeTeam = (value: string) => ({ NY: 'NYK', GS: 'GSW', NO: 'NOP', SA: 'SAS', PHO: 'PHX', BRK: 'BKN' }[value.toUpperCase()] ?? value.toUpperCase());
function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}
function noise(seed: number, scenario: number, player: number) {
  let value = hash(`${seed}:${scenario}:${player}`);
  value = Math.imul(value ^ value >>> 16, 0x7feb352d);
  value = Math.imul(value ^ value >>> 15, 0x846ca68b);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
function fitReason(ids: readonly number[], prepared: Pick<Prepared, 'eligible' | 'slots' | 'primaryLimits' | 'benchUnlimited'>): DraftCompletionCut['reason'] | null {
  if (ids.length > prepared.slots.length) return 'roster_capacity';
  const primaryCounts = new Map<number, number>();
  for (const id of ids) {
    const primary = prepared.eligible.get(id)?.primaryPositionId;
    if (primary !== null && primary !== undefined) primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
  }
  if ([...primaryCounts].some(([primary, count]) => count > (prepared.primaryLimits.get(primary) ?? Infinity))) return 'position_limit';
  // Unlimited bench permits positional congestion. Daily lineup evaluation decides
  // which games score; an empty starting position does not make the roster illegal.
  if (prepared.benchUnlimited) return null;
  const occupants = new Map<number, number>();
  function place(id: number, visited: Set<number>): boolean {
    for (let slot = 0; slot < prepared.slots.length; slot++) {
      if (visited.has(slot) || !prepared.eligible.get(id)?.eligibleSlots.includes(prepared.slots[slot])) continue;
      visited.add(slot);
      const previous = occupants.get(slot);
      if (previous === undefined || place(previous, visited)) { occupants.set(slot, id); return true; }
    }
    return false;
  }
  return ids.every(id => place(id, new Set())) ? null : 'slot_eligibility';
}

/** Prepare a pure, deterministic forecast. Missing fixed-player facts invalidate every scenario. */
export function prepareDraftCompletion(input: DraftCompletionInput): DraftCompletionContext {
  const { board, catalog, settings, eligibility } = input;
  const context: DraftCompletionContext = { available: false, unavailableReason: null, warnings: [], scenarioCount: input.scenarioCount ?? 12,
    targetPick: null, candidateIds: [], franchiseIds: [], normalCapacity: settings.normalCapacity };
  const fail = (message: string) => { context.unavailableReason = message; return context; };
  const jitter = input.rankJitter ?? 0.22;
  if (!Number.isInteger(context.scenarioCount) || context.scenarioCount < 1 || context.scenarioCount > 16
    || !Number.isFinite(jitter) || jitter < 0 || jitter > 0.5 || (input.seed !== undefined && !Number.isSafeInteger(input.seed))) return fail('Invalid draft forecast scenario settings.');
  if (!board.keepersRevealedAt) return fail('Reveal all keepers before forecasting completed rosters.');
  if (!board.orderComplete) return fail('Publish a complete draft order before forecasting remaining picks.');
  if (catalog.leagueId !== settings.leagueId || eligibility.leagueId !== settings.leagueId || catalog.espnSeasonId !== board.draftYear + 1
    || settings.espnSeasonId !== catalog.espnSeasonId || eligibility.espnSeasonId !== catalog.espnSeasonId) return fail('The draft forecast needs matching player, roster and draft seasons.');
  const projections = draftProjectionDatasetSchema.safeParse(input.projections);
  if (!projections.success || projections.data.seasonId !== catalog.espnSeasonId) return fail('Import complete projections for this draft season before forecasting.');
  const teams = [...board.teams].sort((a, b) => (a.draftPosition ?? Infinity) - (b.draftPosition ?? Infinity) || a.franchiseId.localeCompare(b.franchiseId));
  context.franchiseIds = teams.map(team => team.franchiseId);
  if (teams.length < 2 || new Set(context.franchiseIds).size !== teams.length || !context.franchiseIds.includes(input.franchiseId)
    || teams.some((team, index) => team.draftPosition !== index + 1)) return fail('The draft forecast needs unique teams and a complete draft order.');
  const normal = settings.slots.filter(slot => slot.kind === 'normal');
  if (new Set(settings.slots.map(slot => slot.slotId)).size !== settings.slots.length
    || settings.slots.some(slot => !Number.isSafeInteger(slot.count) || slot.count < 1)
    || normal.some(slot => !settings.slotDefinitions.some(definition => definition.slotId === slot.slotId && definition.lineupSlotEligible && !definition.reserve))
    || normal.reduce((sum, slot) => sum + slot.count, 0) !== settings.normalCapacity || settings.normalCapacity < 1 || settings.normalCapacity > 100) return fail('The configured normal roster capacity could not be verified.');
  const slots = normal.flatMap(slot => Array.from({ length: slot.count }, () => slot.slotId));
  const primaryLimits = new Map<number, number>();
  if (new Set(settings.primaryPositionLimits.map(limit => limit.positionId)).size !== settings.primaryPositionLimits.length
    || settings.primaryPositionLimits.some(limit => !Number.isInteger(limit.positionId) || limit.positionId < 1 || limit.positionId > 5)) return fail('The configured primary-position limits could not be verified.');
  for (const limit of settings.primaryPositionLimits) {
    if (limit.maximum !== null) {
      if (!Number.isSafeInteger(limit.maximum) || limit.maximum < 0 || primaryLimits.has(limit.positionId)) return fail('The configured primary-position limits could not be verified.');
      primaryLimits.set(limit.positionId, limit.maximum);
    }
  }
  const players = new Map(catalog.players.map(player => [player.id, { ...player }]));
  const eligible = new Map(eligibility.players.map(player => [player.id, { ...player, eligibleSlots: [...player.eligibleSlots] }]));
  if (players.size !== catalog.players.length || eligible.size !== eligibility.players.length) return fail('The player catalog or eligibility contains duplicate identities.');
  const projected = new Map(projections.data.players.map(player => [player.id, player]));
  const scheduledTeams = input.scheduledTeams ? new Set([...input.scheduledTeams].map(normalizeTeam)) : null;
  const hasFacts = (id: number) => {
    const player = players.get(id), position = eligible.get(id);
    return Boolean(player && projected.has(id) && position?.eligibleSlots.length && slots.some(slot => position.eligibleSlots.includes(slot))
      && Number.isInteger(position.primaryPositionId) && position.primaryPositionId! >= 1 && position.primaryPositionId! <= 5
      && ['FA', 'UNKNOWN', ''].every(value => normalizeTeam(player.nbaTeam) !== value)
      && (!scheduledTeams || scheduledTeams.has(normalizeTeam(player.nbaTeam))));
  };
  const ranks = new Map<number, number | null>();
  for (const player of catalog.players) {
    const supplied = input.espnRanks?.get(player.id), rank = supplied ?? player.rank;
    if (rank !== null && (!Number.isSafeInteger(rank) || rank < 1)) return fail('The ESPN market ranks contain an invalid value.');
    ranks.set(player.id, rank);
  }
  const picks = [...board.picks].sort((a, b) => (a.overallPick ?? Infinity) - (b.overallPick ?? Infinity));
  const teamById = new Map(teams.map(team => [team.franchiseId, team]));
  if (!Number.isSafeInteger(board.roundCount) || board.roundCount < 1 || picks.length !== teams.length * board.roundCount || new Set(picks.map(pick => pick.id)).size !== picks.length
    || picks.some((pick, index) => pick.overallPick !== index + 1 || !pick.originalFranchiseId || !teamById.has(pick.originalFranchiseId)
      || !Number.isSafeInteger(pick.round) || pick.round < 1 || pick.round > board.roundCount
      || draftOverallPick(pick.round, teamById.get(pick.originalFranchiseId)!.draftPosition!, teams.length, board.draftFormat) !== pick.overallPick)) return fail('The complete draft pick inventory and its published order are required.');
  const fixed = new Map(teams.map(team => [team.franchiseId, [] as number[]]));
  const taken = new Set<number>();
  for (const pick of picks) {
    if (pick.status === 'available') {
      if (pick.playerId !== null || !pick.currentOwnerId || !teamById.has(pick.currentOwnerId)) return fail('An available draft pick has an invalid player or owner.');
      continue;
    }
    const owner = pick.rosterOwnerId ?? pick.currentOwnerId;
    if (pick.playerId === null || !owner || !fixed.has(owner) || taken.has(pick.playerId)) return fail('A fixed keeper or drafted player has missing or conflicting ownership.');
    if (!hasFacts(pick.playerId)) return fail(`${pick.playerName || players.get(pick.playerId)?.name || 'A fixed player'} needs a complete projection, NBA team and normal-slot eligibility before forecasting.`);
    fixed.get(owner)!.push(pick.playerId); taken.add(pick.playerId);
  }
  const remaining = picks.filter(pick => pick.status === 'available').map(pick => ({ ...pick }));
  if (board.nextPickId && remaining[0]?.id !== board.nextPickId) return fail('The next draft pick does not match the remaining published order.');
  const targetIndex = remaining.findIndex(pick => pick.currentOwnerId === input.franchiseId);
  context.targetPick = targetIndex >= 0 ? { ...remaining[targetIndex] } : null;
  const pool = catalog.players.filter(player => player.selectable && !taken.has(player.id) && hasFacts(player.id)
    && typeof projected.get(player.id)!.games === 'number' && projected.get(player.id)!.games! > 0).map(player => player.id);
  const prepared: Prepared = { franchiseId: input.franchiseId, players, eligible, ranks, pool, poolSet: new Set(pool), fixed, remaining, targetIndex,
    slots, primaryLimits, benchUnlimited: settings.isBenchUnlimited, seed: (input.seed ?? hash(board.seasonId)) >>> 0, jitter, prefixes: new Map(), baselines: new Map() };
  if (pool.length < remaining.length) return fail('There are not enough covered, eligible players to simulate every remaining pick.');
  const excluded = catalog.players.filter(player => player.selectable && !taken.has(player.id) && !prepared.poolSet.has(player.id)).length;
  if (excluded) context.warnings.push(`${excluded} available players lack a usable projection, projected games, NBA team or normal-slot eligibility and are excluded from simulated picks.`);
  context.warnings.push('Future picks use exact ESPN order, two alternating sets of neighboring available-player swaps, then seeded rank jitter. Fixed keepers and selections are excluded from the swaps. Scenario availability is sensitivity coverage, not calibrated draft odds.');
  context.warnings.push('After all owned picks, rosters are hypothetically trimmed to normal capacity and position limits by keeping the best ESPN market ranks, including a hypothetical cut of an existing keeper or selection when necessary. All cuts are reported; the real board is unchanged.');
  context.warnings.push('Short rosters receive hypothetical undrafted free agents in rotating round-robin order. Cut players remain unavailable rather than assuming immediate waiver access. IR adds no draft capacity; unlimited bench does not require every starting position to be filled.');
  context.candidateIds = context.targetPick ? [...pool] : [];
  context.available = true;
  preparedContexts.set(context, prepared);
  return context;
}

function prefixFor(context: DraftCompletionContext, prepared: Prepared, scenario: number): ScenarioPrefix {
  const cached = prepared.prefixes.get(scenario);
  if (cached) return cached;
  const score = (id: number) => prepared.ranks.get(id)! === null ? Infinity
    : prepared.ranks.get(id)! * (scenario <= 2 ? 1 : 1 + prepared.jitter * (2 * noise(prepared.seed, scenario, id) - 1));
  const allMarket = [...prepared.pool, ...[...prepared.fixed.values()].flat()];
  const scores = new Map(allMarket.map(id => [id, score(id)]));
  allMarket.sort((a, b) => (scores.get(a)! - scores.get(b)!) || ((prepared.ranks.get(a) ?? Infinity) - (prepared.ranks.get(b) ?? Infinity))
    || prepared.players.get(a)!.name.localeCompare(prepared.players.get(b)!.name) || a - b);
  if (scenario === 1 || scenario === 2) {
    // Cover both adjacent-pick boundaries systematically, rather than selecting a
    // seed that happens to reorder a particular player. Each available player moves
    // at most one available place; fixed players never consume a pairing boundary.
    const availablePositions = allMarket.flatMap((id, index) => prepared.poolSet.has(id) ? [index] : []);
    for (let index = scenario - 1; index + 1 < availablePositions.length; index += 2) {
      const left = availablePositions[index], right = availablePositions[index + 1];
      // Keep the ranked/unranked boundary intact: an unranked player is not an
      // adjacent ranked draft preference just because the covered pool ends here.
      if (prepared.ranks.get(allMarket[left]) === null || prepared.ranks.get(allMarket[right]) === null) continue;
      [allMarket[left], allMarket[right]] = [allMarket[right], allMarket[left]];
    }
  }
  const order = allMarket.filter(id => prepared.poolSet.has(id));
  const teams = cloneTeams(prepared.fixed), taken = new Set([...teams.values()].flat()), picks: DraftCompletionSelection[] = [];
  const before = prepared.targetIndex < 0 ? prepared.remaining.length : prepared.targetIndex;
  for (let index = 0; index < before; index++) {
    const pick = prepared.remaining[index], playerId = order[index];
    teams.get(pick.currentOwnerId!)!.push(playerId); taken.add(playerId);
    picks.push({ pickId: pick.id, overallPick: pick.overallPick!, franchiseId: pick.currentOwnerId!, playerId });
  }
  const prefix = { order, orderIndex: new Map(allMarket.map((id, index) => [id, index])), teams, taken, picks };
  prepared.prefixes.set(scenario, prefix);
  return prefix;
}
function cloneScenario(value: DraftCompletionScenario): DraftCompletionScenario {
  return { ...value, targetPick: value.targetPick ? { ...value.targetPick } : null, teams: cloneTeams(value.teams), picks: value.picks.map(pick => ({ ...pick })),
    additions: value.additions.map(addition => ({ ...addition })), cuts: value.cuts.map(cut => ({ ...cut })) };
}

/** Branch at the selected team's next owned pick, after the same earlier opposing picks. */
export function completeDraftScenario(context: DraftCompletionContext, scenarioIndex: number, forcedCandidateId?: number): DraftCompletionScenario {
  const result: DraftCompletionScenario = { valid: false, available: false, reason: null, scenarioIndex, targetPick: context.targetPick ? { ...context.targetPick } : null,
    teams: new Map(), picks: [], additions: [], cuts: [], forcedCandidateRetained: forcedCandidateId === undefined ? null : false };
  const fail = (message: string) => { result.reason = message; return result; };
  const prepared = preparedContexts.get(context);
  if (!context.available || !prepared) return fail(context.unavailableReason ?? 'The draft forecast is unavailable.');
  if (!Number.isInteger(scenarioIndex) || scenarioIndex < 0 || scenarioIndex >= context.scenarioCount) return fail('The draft forecast scenario is outside its prepared range.');
  if (forcedCandidateId === undefined && prepared.baselines.has(scenarioIndex)) return cloneScenario(prepared.baselines.get(scenarioIndex)!);
  if (forcedCandidateId !== undefined && (!context.targetPick || !prepared.poolSet.has(forcedCandidateId))) return fail('This player cannot be selected at the next owned pick in the forecast.');
  const prefix = prefixFor(context, prepared, scenarioIndex);
  if (forcedCandidateId !== undefined && prefix.taken.has(forcedCandidateId)) return fail('This player is selected before your next owned pick in this scenario.');
  result.available = true;
  result.teams = cloneTeams(prefix.teams); result.picks = prefix.picks.map(pick => ({ ...pick }));
  const taken = new Set(prefix.taken);
  let cursor = 0;
  for (let index = prepared.targetIndex < 0 ? prepared.remaining.length : prepared.targetIndex; index < prepared.remaining.length; index++) {
    const pick = prepared.remaining[index];
    while (cursor < prefix.order.length && taken.has(prefix.order[cursor])) cursor++;
    const playerId = index === prepared.targetIndex && forcedCandidateId !== undefined ? forcedCandidateId : prefix.order[cursor];
    if (playerId === undefined) return fail('The covered player pool could not complete the remaining draft.');
    result.teams.get(pick.currentOwnerId!)!.push(playerId); taken.add(playerId);
    result.picks.push({ pickId: pick.id, overallPick: pick.overallPick!, franchiseId: pick.currentOwnerId!, playerId });
  }
  // These are hypothetical post-draft cuts, never changes to any recorded selection.
  // Use the same market policy before and after a projected pick becomes a real pick.
  for (const owner of context.franchiseIds) {
    const fixedIds = new Set(prepared.fixed.get(owner)!), retained: number[] = [];
    const ranked = [...result.teams.get(owner)!].sort((a, b) => prefix.orderIndex.get(a)! - prefix.orderIndex.get(b)!);
    for (const playerId of ranked) {
      const reason = fitReason([...retained, playerId], prepared);
      if (reason) result.cuts.push({ franchiseId: owner, playerId, wasFixed: fixedIds.has(playerId), reason });
      else retained.push(playerId);
    }
    result.teams.set(owner, retained);
  }
  const offset = scenarioIndex % context.franchiseIds.length;
  const fillOrder = [...context.franchiseIds.slice(offset), ...context.franchiseIds.slice(0, offset)];
  while ([...result.teams.values()].some(ids => ids.length < context.normalCapacity)) {
    let added = false;
    for (const owner of fillOrder) {
      const ids = result.teams.get(owner)!;
      if (ids.length === context.normalCapacity) continue;
      const playerId = prefix.order.find(id => !taken.has(id) && !fitReason([...ids, id], prepared));
      if (playerId === undefined) continue;
      ids.push(playerId); taken.add(playerId); added = true;
      result.additions.push({ franchiseId: owner, playerId, reason: 'roster_shortfall' });
    }
    if (!added) return fail('The covered free-agent pool cannot fill every normal roster within the configured capacity and position limits.');
  }
  result.valid = true;
  if (forcedCandidateId !== undefined) result.forcedCandidateRetained = result.teams.get(prepared.franchiseId)!.includes(forcedCandidateId);
  if (forcedCandidateId === undefined) prepared.baselines.set(scenarioIndex, cloneScenario(result));
  return result;
}
