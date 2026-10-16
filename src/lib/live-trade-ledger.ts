import type { TradeRecord } from './types';

type Transfer = { from_franchise_id: string; to_franchise_id: string };
export type FinalizedTradeRow = {
  id: string; season_id: string; status: string; application_mode: string; terms: string; created_at: string; finalized_at: string | null;
  trade_participants: { franchise_id: string }[];
  trade_player_transfers: (Transfer & { player_id: number; players: { full_name: string } | null })[];
  trade_pick_transfers: (Transfer & { pick_id: string; draft_picks: { round: number; season_id: string; original_franchise_id: string } | null })[];
  trade_obligations: (Transfer & { kind: string; terms: string; status: string })[];
};
export type TradeLedgerTeam = { franchiseId: string; teamId: number; name: string };

/** Keep the imported ledger intact; only newly finalized live agreements extend it. */
export function mergeFinalizedTradeLedger(archive: TradeRecord[], rows: FinalizedTradeRow[], teams: TradeLedgerTeam[], seasons: { id: string; draft_year: number }[]): TradeRecord[] {
  const teamById = new Map(teams.map(team => [team.franchiseId, team]));
  const yearById = new Map(seasons.map(season => [season.id, season.draft_year]));
  const known = new Set(archive.map(trade => trade.id));
  const team = (id: string) => {
    const result = teamById.get(id);
    if (!result) throw new Error('A finalized trade references an unknown franchise.');
    return result;
  };
  const year = (id: string) => {
    const result = yearById.get(id);
    if (!result) throw new Error('A finalized trade references an unknown draft season.');
    return result;
  };
  const live: TradeRecord[] = [];
  for (const row of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (row.status !== 'finalized' || row.application_mode !== 'live' || known.has(row.id)) continue;
    if (!row.finalized_at) throw new Error('A finalized trade is missing its completion date.');
    const participants = [...new Set(row.trade_participants.map(participant => participant.franchise_id))].map(team);
    if (participants.length < 2) throw new Error('A finalized trade is missing its participants.');
    const direction = (leg: Transfer) => `${team(leg.from_franchise_id).name} → ${team(leg.to_franchise_id).name}`;
    const transferLines = [
      ...row.trade_player_transfers.map(leg => {
        if (!leg.players?.full_name) throw new Error('A finalized player transfer is missing its player.');
        return `${direction(leg)}: ${leg.players.full_name}`;
      }),
      ...row.trade_pick_transfers.map(leg => {
        const pick = leg.draft_picks;
        if (!pick) throw new Error('A finalized pick transfer is missing its original pick.');
        return `${direction(leg)}: ${year(pick.season_id)} round ${pick.round} (originally ${team(pick.original_franchise_id).name})`;
      }),
      ...row.trade_obligations.map(leg => `${direction(leg)}: ${leg.terms} (${leg.status})`),
    ];
    if (!transferLines.length) throw new Error('A finalized trade is missing its assets or obligations.');
    live.push({ id: row.id, source: 'live', status: 'finalized', parties: participants.map(participant => participant.name), participantTeamIds: participants.map(participant => participant.teamId),
      summary: transferLines.join(' · '), notes: row.terms, transferLines, createdAt: row.created_at, finalizedAt: row.finalized_at, season: year(row.season_id),
    });
    known.add(row.id);
  }
  return [...archive, ...live];
}
