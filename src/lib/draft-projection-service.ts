import 'server-only';
import catalog from '../../data/draft-player-catalog.json';
import { fetchAiPlayerPool } from './ai-league-feed';
import type { DraftPlayerCatalog } from './draft-player-catalog';
import { extractEspnDraftProjections, importDraftProjections, type DraftProjectionSource } from './draft-projections';
import { validatedEspnCookies } from './espn-history-sync-core';
import { fetchYahooDraftProjections } from './yahoo-draft-projections';
import type { DraftProjectionDataset } from './draft-projections';

const playerCatalog = catalog as DraftPlayerCatalog;
const yahooCache = new Map<number, { expiresAt: number; dataset: DraftProjectionDataset }>();
const yahooPending = new Map<number, Promise<DraftProjectionDataset>>();

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

/** Public-source cache only; each API request still checks Draft Tool access. */
export async function importYahooDraftProjections(seasonId: number, options: { refresh?: boolean } = {}): Promise<DraftProjectionDataset> {
  const cached = yahooCache.get(seasonId);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.dataset;
  const pending = yahooPending.get(seasonId);
  if (pending) return pending;
  const refresh = fetchYahooDraftProjections(seasonId, playerCatalog).then(dataset => {
    // Keep the actual source-read timestamp on cache hits. Partial/failed pulls
    // never replace the last successful dataset or get advertised as fresh.
    yahooCache.set(seasonId, { dataset, expiresAt: Date.now() + 30 * 60_000 });
    return dataset;
  }).finally(() => yahooPending.delete(seasonId));
  yahooPending.set(seasonId, refresh);
  return refresh;
}
