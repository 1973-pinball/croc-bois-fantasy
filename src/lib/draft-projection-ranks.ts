import { z } from 'zod';
import { draftProjectionDatasetSchema, ESPN_PROJECTION_PARSER_VERSION, type DraftProjectionDataset } from './draft-projections';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Rank-only data must come from the account's private import, never inferred from stats or row order. */
export const draftProjectionRankSnapshotSchema = z.object({
  source: z.enum(['basketball-monster', 'yahoo']),
  seasonId: z.number().int().min(2000).max(2100),
  importedAt: z.string().datetime(),
  ranks: z.array(z.object({ id: positiveInteger, providerRank: positiveInteger }).strict()).min(1).max(2000),
}).strict().superRefine((value, context) => {
  if (new Set(value.ranks.map(row => row.id)).size !== value.ranks.length) context.addIssue({ code: 'custom', path: ['ranks'], message: 'Duplicate ESPN player identities in the supplied ranks.' });
});
export type DraftProjectionRankSnapshot = z.infer<typeof draftProjectionRankSnapshotSchema>;

/** Legacy direct imports still have useful stats, but need one refresh to obtain supplied provider ranks. */
export function needsDirectRankRefresh(provider: 'espn' | 'yahoo', value: unknown, seasonId: number): boolean {
  const parsed = draftProjectionDatasetSchema.safeParse(value);
  return parsed.success && parsed.data.source === provider && parsed.data.seasonId === seasonId
    && !parsed.data.players.some(player => player.providerRank !== undefined);
}

export function needsYahooRankRefresh(value: unknown, seasonId: number): boolean {
  return needsDirectRankRefresh('yahoo', value, seasonId);
}

/** A newly published ESPN catalog supersedes older ESPN imports, without changing other providers. */
export function needsEspnCatalogRefresh(value: unknown, seasonId: number, catalogFetchedAt: string): boolean {
  const parsed = draftProjectionDatasetSchema.safeParse(value);
  return parsed.success && parsed.data.source === 'espn' && parsed.data.seasonId === seasonId
    && Date.parse(parsed.data.importedAt) < Date.parse(catalogFetchedAt);
}

/** Retry saved ESPN forecasts once when an updated extractor can restore excluded projections. */
export function needsEspnParserRefresh(value: unknown, seasonId: number): boolean {
  const parsed = draftProjectionDatasetSchema.safeParse(value);
  return parsed.success && parsed.data.source === 'espn' && parsed.data.seasonId === seasonId
    && (parsed.data.espnParserVersion ?? 0) < ESPN_PROJECTION_PARSER_VERSION;
}

/**
 * Fill missing original ranks without changing the forecast or replacing a supplied rank.
 * Callers enforce account authorization before providing the private snapshot.
 */
export function mergeDraftProjectionRanks(value: DraftProjectionDataset, rankValue: DraftProjectionRankSnapshot): DraftProjectionDataset {
  const dataset = draftProjectionDatasetSchema.parse(value);
  const snapshot = draftProjectionRankSnapshotSchema.parse(rankValue);
  if (snapshot.source !== dataset.source || snapshot.seasonId !== dataset.seasonId) throw new Error('The supplied ranks must match the projection source and season.');
  const supplied = new Map(snapshot.ranks.map(row => [row.id, row.providerRank]));
  const players = dataset.players.map(player => {
    const rank = supplied.get(player.id);
    if (rank === undefined) return player;
    if (player.providerRank !== undefined && player.providerRank !== rank) throw new Error('Saved and supplied ranks disagree. Import one complete ranked projection table instead of combining different rankings.');
    return player.providerRank === undefined ? { ...player, providerRank: rank } : player;
  });
  return { ...dataset, players };
}
