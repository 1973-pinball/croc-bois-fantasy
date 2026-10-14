import { z } from 'zod';
import type { DraftPick } from './types';

export type KeeperPaymentInventory = { deadline: string; capturedAt: string; picks: DraftPick[] };
const inventorySchema = z.object({
  deadline: z.string().datetime({ offset: true }), capturedAt: z.string().datetime({ offset: true }),
  picks: z.array(z.object({ id: z.string().uuid(), seasonId: z.string().uuid(), ownerId: z.string().uuid(),
    originalOwnerId: z.string().uuid(), round: z.number().int().positive(), status: z.enum(['available', 'used']) })),
});

/** Public pick ownership at the cutoff, never private keeper selections. */
export function parseKeeperPaymentInventory(value: unknown, seasonId: string, year: number, franchiseIds: Record<string, string>): KeeperPaymentInventory | null {
  if (value === null) return null;
  const raw = inventorySchema.parse(value);
  const handles = new Map(Object.entries(franchiseIds).map(([id, franchise]) => [franchise, Number(id)]));
  if (new Set(raw.picks.map(pick => pick.id)).size !== raw.picks.length || raw.picks.some(pick => pick.seasonId !== seasonId || !handles.has(pick.ownerId) || !handles.has(pick.originalOwnerId))) {
    throw new Error('The keeper deadline pick inventory could not be verified.');
  }
  return { deadline: raw.deadline, capturedAt: raw.capturedAt, picks: raw.picks.filter(pick => pick.status === 'available').map(pick => ({
    id: pick.id, season: year, round: pick.round, ownerTeamId: handles.get(pick.ownerId)!, originalTeamId: handles.get(pick.originalOwnerId)!,
  })) };
}
