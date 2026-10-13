import type { CategoryPreferenceSeason } from './category-preferences';

/** Allowlisted actual-owner evidence; null means unavailable, never a zero result. */
export type AiOwnerSnapshot = {
  season: number;
  capturedAt: string;
  draftComplete: boolean;
  draft: { teamId: string; playerId: number; name: string; overallPick: number; keeper: boolean | null }[] | null;
  categories: CategoryPreferenceSeason | null;
  acquisitions: { teamId: string; byPeriod: Record<string, number> }[] | null;
  limitations: string[];
};
