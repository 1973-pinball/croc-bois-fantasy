import 'server-only';
import catalog from '../../data/draft-player-catalog.json';
import { fetchAiPlayerPool } from './ai-league-feed';
import type { DraftPlayerCatalog } from './draft-player-catalog';
import { extractEspnDraftProjections, importDraftProjections, type DraftProjectionSource } from './draft-projections';
import { validatedEspnCookies } from './espn-history-sync-core';

const playerCatalog = catalog as DraftPlayerCatalog;

export async function importEspnDraftProjections(seasonId: number) {
  if (seasonId !== playerCatalog.espnSeasonId) throw new Error('The ESPN player catalog does not cover this draft season yet.');
  const connection = validatedEspnCookies(process.env.ESPN_S2, process.env.ESPN_SWID ?? process.env.SWID);
  if (!connection) throw new Error('The league’s ESPN server connection is unavailable. Paste or upload a projection export instead.');
  // This helper uses a fixed ESPN endpoint, blocks redirects, and never returns credentials or raw source records.
  const payload = await fetchAiPlayerPool(seasonId, { espnS2: connection.s2, swid: connection.swid });
  return extractEspnDraftProjections(payload, seasonId, playerCatalog);
}

export function importDraftProjectionText(options: { seasonId: number; source: DraftProjectionSource; text: string; basis: 'per-game' | 'totals' }) {
  return importDraftProjections({ ...options, catalog: playerCatalog });
}
