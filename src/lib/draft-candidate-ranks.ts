import type { DraftAdvisorCandidate } from './draft-advisor';
import type { DraftPlayerCatalog } from './draft-player-catalog';
import { draftProjectionDatasetSchema, type DraftProjectionDataset, type DraftProjectionSource } from './draft-projections';

export type DraftCandidateOrder = 'espn' | 'bbm' | 'yahoo' | 'bbm-value' | 'fit';
export type DraftCandidateRankLibrary = Partial<Record<DraftProjectionSource, DraftProjectionDataset>>;
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
 * Legacy datasets without providerRank remain unranked until refreshed/imported.
 */
export function buildDraftCandidateRanks(
  catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>,
  library: DraftCandidateRankLibrary,
): DraftCandidateRanks {
  const selectable = catalog.players.filter(player => player.selectable);
  const selectableIds = new Set(selectable.map(player => player.id));
  function sourceRanks(source: 'basketball-monster' | 'yahoo') {
    const parsed = draftProjectionDatasetSchema.safeParse(library[source]);
    if (!parsed.success || parsed.data.source !== source || parsed.data.seasonId !== catalog.espnSeasonId) return new Map<number, number>();
    const pool = parsed.data.players.filter(player => selectableIds.has(player.id) && player.providerRank !== undefined);
    return new Map(pool.map(player => [player.id, player.providerRank!]));
  }
  const bbm = sourceRanks('basketball-monster'), yahoo = sourceRanks('yahoo');
  const byPlayerId = new Map<number, DraftCandidateRank>(selectable.map(player => {
    const espnRank = validRank(player.rank), bbmRank = bbm.get(player.id) ?? null;
    return [player.id, { espnRank, bbmRank, yahooRank: yahoo.get(player.id) ?? null, bbmValue: espnRank !== null && bbmRank !== null ? espnRank - bbmRank : null }];
  }));
  return { byPlayerId, coverage: { selectable: selectable.length, espn: selectable.filter(player => validRank(player.rank) !== null).length, bbm: bbm.size, yahoo: yahoo.size } };
}

function compareNullable(a: number | null, b: number | null, descending = false) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/** Sort the entire available pool before truncating; unavailable source ranks stay last. */
export function sortDraftCandidates(candidates: DraftAdvisorCandidate[], ranks: DraftCandidateRanks, order: DraftCandidateOrder, limit = 15): DraftAdvisorCandidate[] {
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
  return available.sort((a, b) => compareNullable(value(a), value(b), order === 'bbm-value' || order === 'fit')
    || compareNullable(validRank(a.player.rank), validRank(b.player.rank))
    || a.player.name.localeCompare(b.player.name) || a.player.id - b.player.id)
    .slice(0, Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 15);
}
