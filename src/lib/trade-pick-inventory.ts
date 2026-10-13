import { z } from 'zod';
import type { DraftPick } from './types';

const inventorySchema = z.object({
  source: z.literal('supabase'), usedPickIds: z.array(z.string().uuid()),
  seasons: z.array(z.object({
    year: z.number().int(), roundCount: z.number().int().min(1).max(30), source: z.enum(['live', 'archive', 'reference']),
    teams: z.array(z.object({ id: z.number().int(), franchiseId: z.string().uuid().optional() })),
    picks: z.array(z.object({ id: z.string(), season: z.number().int(), round: z.number().int(), originalTeamId: z.number().int(), ownerTeamId: z.number().int() })),
  })),
});

export type TradePickInventory = { picks: DraftPick[]; usedPickIds: string[]; years: number[]; participantIdsByYear: Record<string, number[]> };

/** Only verified live UUIDs are tradable. Archive and reference grid cells are display data. */
export function buildTradePickInventory(value: unknown, currentYear: number, franchiseIds: Record<string, string>): TradePickInventory {
  const parsed = inventorySchema.safeParse(value);
  if (!parsed.success) throw new Error('Live draft-pick ownership and availability could not be verified. Refresh records to try again.');
  const currentHandles = new Map(Object.entries(franchiseIds).map(([handle, franchiseId]) => [franchiseId, Number(handle)]));
  const seasons = parsed.data.seasons.filter(season => season.source === 'live' && season.year >= currentYear).sort((a, b) => a.year - b.year);
  if (!seasons.some(season => season.year === currentYear) || new Set(seasons.map(season => season.year)).size !== seasons.length) throw new Error('The current live draft-pick inventory is unavailable.');
  const picks: DraftPick[] = []; const participantIdsByYear: Record<string, number[]> = {};
  for (const season of seasons) {
    const handles = new Map(season.teams.map(team => [team.id, team.franchiseId ? currentHandles.get(team.franchiseId) : undefined]));
    if (handles.size !== season.teams.length || season.teams.some(team => !team.franchiseId) || season.picks.length !== season.teams.length * season.roundCount) throw new Error('A live draft season has incomplete ownership records.');
    participantIdsByYear[season.year] = [...handles.values()].filter((id): id is number => id !== undefined);
    const coordinates = new Set<string>();
    for (const pick of season.picks) {
      const coordinate = `${pick.originalTeamId}:${pick.round}`;
      if (!z.string().uuid().safeParse(pick.id).success || pick.season !== season.year || pick.round < 1 || pick.round > season.roundCount || !handles.has(pick.originalTeamId) || !handles.has(pick.ownerTeamId) || coordinates.has(coordinate)) throw new Error('A live draft pick has an invalid identity or owner.');
      coordinates.add(coordinate);
      const originalTeamId = handles.get(pick.originalTeamId); const ownerTeamId = handles.get(pick.ownerTeamId);
      // Current-season trade participants are the authority; future-only expansion teams cannot send an asset here.
      if (originalTeamId !== undefined && ownerTeamId !== undefined) picks.push({ ...pick, originalTeamId, ownerTeamId });
    }
  }
  if (new Set(picks.map(pick => pick.id)).size !== picks.length) throw new Error('The live inventory contains duplicate pick identities.');
  const ids = new Set(picks.map(pick => pick.id));
  return { picks, usedPickIds: [...new Set(parsed.data.usedPickIds)].filter(id => ids.has(id)), years: seasons.map(season => season.year), participantIdsByYear };
}
