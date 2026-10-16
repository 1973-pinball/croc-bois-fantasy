import type { TradeRecord } from './types';

export type TradeObservation = { franchiseId: string; wins: number; trades: number };

/** The workbook totals already include the imported ledger. Only new finalized
 * live records add participation, once per franchise rather than per asset. */
export function aggregateLeagueTrades<T extends TradeObservation>(baseline: readonly T[], trades: readonly TradeRecord[]) {
  const participation = new Map<string, number>();
  const counted = new Set<string>();
  for (const trade of trades) {
    if (trade.source !== 'live' || trade.status !== 'finalized' || counted.has(trade.id)) continue;
    counted.add(trade.id);
    for (const teamId of new Set(trade.participantTeamIds ?? [])) {
      const id = String(teamId);
      participation.set(id, (participation.get(id) ?? 0) + 1);
    }
  }
  const observations = baseline.map(item => ({
    ...item,
    archivedTrades: item.trades,
    liveTrades: participation.get(item.franchiseId) ?? 0,
    trades: item.trades + (participation.get(item.franchiseId) ?? 0),
  })).filter(item => Number.isFinite(item.wins) && Number.isFinite(item.trades));
  const meanTrades = observations.reduce((sum, item) => sum + item.trades, 0) / Math.max(1, observations.length);
  const meanWins = observations.reduce((sum, item) => sum + item.wins, 0) / Math.max(1, observations.length);
  const covariance = observations.reduce((sum, item) => sum + (item.trades - meanTrades) * (item.wins - meanWins), 0);
  const tradeVariance = observations.reduce((sum, item) => sum + (item.trades - meanTrades) ** 2, 0);
  const winVariance = observations.reduce((sum, item) => sum + (item.wins - meanWins) ** 2, 0);
  const pearson = observations.length < 2 || tradeVariance === 0 || winVariance === 0
    ? null : Math.max(-1, Math.min(1, covariance / Math.sqrt(tradeVariance * winVariance)));
  return { observations, pearson, finalizedTradeCount: counted.size };
}
