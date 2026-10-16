import type { DraftAdvisorCandidate } from './draft-advisor';
import type { DraftPlayerCatalog } from './draft-player-catalog';
import { draftProjectionDatasetSchema, type DraftProjectionDataset, type DraftProjectionSource } from './draft-projections';
import { draftProjectionRankSnapshotSchema, type DraftProjectionRankSnapshot } from './draft-projection-ranks';

export type DraftCandidateOrder = 'espn' | 'bbm' | 'yahoo' | 'bbm-value' | 'fit';
export type DraftCandidateDirection = 'ascending' | 'descending';
export const defaultDraftCandidateDirection = (order: DraftCandidateOrder): DraftCandidateDirection => order === 'bbm-value' || order === 'fit' ? 'descending' : 'ascending';
export type DraftCandidateRankLibrary = Partial<Record<DraftProjectionSource, DraftProjectionDataset>>;
export type DraftCandidateRankSnapshots = Partial<Record<'basketball-monster' | 'yahoo', DraftProjectionRankSnapshot>>;
export type DraftCandidateRank = {
  espnRank: number | null;
  bbmRank: number | null;
  yahooRank: number | null;
  /** ESPN rank minus supplied BBM rank; positive means BBM values the player earlier. */
  bbmValue: number | null;
};
export type DraftCandidateRanks = {
  byPlayerId: Map<number, DraftCandidateRank>;
  coverage: { selectable: number; espn: number; bbm: number; yahoo: number };
};

const validRank = (value: number | null): number | null => value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * Original provider ranks are preserved across the full selectable catalog,
 * including taken players. Draft picks change availability, never source ranks.
 * Private rank snapshots can fill gaps independently of projected stats.
 */
export function buildDraftCandidateRanks(
  catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>,
  library: DraftCandidateRankLibrary,
  rankSnapshots: DraftCandidateRankSnapshots = {},
): DraftCandidateRanks {
  const selectable = catalog.players.filter(player => player.selectable);
  const selectableIds = new Set(selectable.map(player => player.id));
  function sourceRanks(source: DraftProjectionSource) {
    const parsed = draftProjectionDatasetSchema.safeParse(library[source]);
    const pool = parsed.success && parsed.data.source === source && parsed.data.seasonId === catalog.espnSeasonId
      ? parsed.data.players.filter(player => selectableIds.has(player.id) && player.providerRank !== undefined) : [];
    const ranks = new Map(pool.map(player => [player.id, player.providerRank!]));
    if (source === 'espn') return ranks;
    const supplied = draftProjectionRankSnapshotSchema.safeParse(rankSnapshots[source]);
    if (!supplied.success || supplied.data.source !== source || supplied.data.seasonId !== catalog.espnSeasonId) return ranks;
    const matching = supplied.data.ranks.filter(player => selectableIds.has(player.id));
    // A different overlapping rank indicates another ranking snapshot. Keep the
    // imported ranks intact and do not mix the conflicting set into its gaps.
    if (matching.some(player => ranks.has(player.id) && ranks.get(player.id) !== player.providerRank)) return ranks;
    for (const player of matching) if (!ranks.has(player.id)) ranks.set(player.id, player.providerRank);
    return ranks;
  }
  const espn = sourceRanks('espn'), bbm = sourceRanks('basketball-monster'), yahoo = sourceRanks('yahoo');
  const byPlayerId = new Map<number, DraftCandidateRank>(selectable.map(player => {
    const espnRank = espn.get(player.id) ?? validRank(player.rank), bbmRank = bbm.get(player.id) ?? null;
    return [player.id, { espnRank, bbmRank, yahooRank: yahoo.get(player.id) ?? null, bbmValue: espnRank !== null && bbmRank !== null ? espnRank - bbmRank : null }];
  }));
  return { byPlayerId, coverage: { selectable: selectable.length, espn: [...byPlayerId.values()].filter(player => player.espnRank !== null).length, bbm: bbm.size, yahoo: yahoo.size } };
}

function compareNullable(a: number | null, b: number | null, descending = false) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/** Apply the inclusive ESPN cutoff before choosing the best rows for any ranking. */
export function filterDraftCandidatesByEspnRank(candidates: DraftAdvisorCandidate[], ranks: DraftCandidateRanks, maxRank: number | null): DraftAdvisorCandidate[] {
  if (maxRank === null) return [...candidates];
  if (!Number.isSafeInteger(maxRank) || maxRank < 1) return [];
  return candidates.filter(candidate => {
    const rank = ranks.byPlayerId.get(candidate.player.id)?.espnRank ?? validRank(candidate.player.rank);
    return rank !== null && rank <= maxRank;
  });
}

/** Sort the entire available pool before truncating; unavailable source ranks stay last. */
export function sortDraftCandidates(candidates: DraftAdvisorCandidate[], ranks: DraftCandidateRanks, order: DraftCandidateOrder, limit = 15, direction: DraftCandidateDirection = defaultDraftCandidateDirection(order)): DraftAdvisorCandidate[] {
  const available = order === 'fit' ? candidates.filter(candidate => !candidate.blocked && candidate.fitScore !== null && Number.isFinite(candidate.fitScore)) : [...candidates];
  const value = (candidate: DraftAdvisorCandidate): number | null => {
    const row = ranks.byPlayerId.get(candidate.player.id);
    switch (order) {
      case 'espn': return row?.espnRank ?? validRank(candidate.player.rank);
      case 'bbm': return row?.bbmRank ?? null;
      case 'yahoo': return row?.yahooRank ?? null;
      case 'bbm-value': return row?.bbmValue ?? null;
      case 'fit': return candidate.fitScore;
    }
  };
  return available.sort((a, b) => compareNullable(value(a), value(b), direction === 'descending')
    || compareNullable(ranks.byPlayerId.get(a.player.id)?.espnRank ?? validRank(a.player.rank), ranks.byPlayerId.get(b.player.id)?.espnRank ?? validRank(b.player.rank))
    || a.player.name.localeCompare(b.player.name) || a.player.id - b.player.id)
    .slice(0, Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 15);
}
