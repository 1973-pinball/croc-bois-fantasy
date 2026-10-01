import type { LeagueData } from './types';

export type ObligationKind = 'loan_return' | 'conditional_pick' | 'espn_action' | 'other';
type TeamLeg = { key: string; fromTeamId: number; toTeamId: number };
export type TradeDraftLeg = TeamLeg & (
  { kind: 'player'; playerId: number } |
  { kind: 'pick'; pickId: string } |
  { kind: 'obligation'; obligationKind: ObligationKind; terms: string; dueAt: string | null }
);
export type TradeCategory = 'player_only' | 'advanced';

export function serializeTradeDraft(input: {
  seasonId: string; category: TradeCategory; terms: string; legs: TradeDraftLeg[];
  data: Pick<LeagueData, 'teams' | 'players' | 'picks'>;
  franchiseIds: Record<string, string>; usedPickIds: string[];
}) {
  if (input.legs.length < 1 || input.legs.length > 100) throw new Error('Add between 1 and 100 player, pick, or obligation entries.');
  if (input.terms.length > 10000) throw new Error('Trade terms must be 10,000 characters or fewer.');
  if (input.category === 'player_only' && input.legs.some(leg => leg.kind !== 'player')) throw new Error('Choose Advanced for a trade involving picks or obligations.');
  const players: { playerId: number; fromFranchiseId: string; toFranchiseId: string }[] = [];
  const picks: { pickId: string; fromFranchiseId: string; toFranchiseId: string }[] = [];
  const obligations: { kind: ObligationKind; terms: string; dueAt: string | null; fromFranchiseId: string; toFranchiseId: string }[] = [];
  const seen = new Set<string>();
  for (const leg of input.legs) {
    const fromFranchiseId = input.franchiseIds[String(leg.fromTeamId)];
    const toFranchiseId = input.franchiseIds[String(leg.toTeamId)];
    if (!fromFranchiseId || !toFranchiseId || !input.data.teams.some(t => t.id === leg.fromTeamId) || !input.data.teams.some(t => t.id === leg.toTeamId)) throw new Error('Every sending and receiving team must participate in this season.');
    if (leg.fromTeamId === leg.toTeamId) throw new Error('Choose different sending and receiving teams for each entry.');
    if (leg.kind === 'player') {
      const player = input.data.players.find(p => p.id === leg.playerId);
      if (!player || player.teamId !== leg.fromTeamId) throw new Error('A selected player is no longer on the sending team. Reload the league and review that entry.');
      const key = `player:${leg.playerId}`;
      if (seen.has(key)) throw new Error('Each player can appear only once in a trade.');
      seen.add(key); players.push({ playerId: leg.playerId, fromFranchiseId, toFranchiseId });
    } else if (leg.kind === 'pick') {
      const pick = input.data.picks.find(p => p.id === leg.pickId);
      if (!pick || pick.ownerTeamId !== leg.fromTeamId || input.usedPickIds.includes(pick.id)) throw new Error('A selected pick is no longer available to the sending team. Reload the league and review that entry.');
      const key = `pick:${leg.pickId}`;
      if (seen.has(key)) throw new Error('Each pick can appear only once in a trade.');
      seen.add(key); picks.push({ pickId: leg.pickId, fromFranchiseId, toFranchiseId });
    } else {
      if (!leg.terms.trim() || leg.terms.length > 10000) throw new Error('Each obligation needs terms of 1 to 10,000 characters.');
      if (leg.dueAt !== null && !Number.isFinite(Date.parse(leg.dueAt))) throw new Error('Enter a valid obligation due date or leave it blank.');
      obligations.push({ kind: leg.obligationKind, terms: leg.terms.trim(), dueAt: leg.dueAt, fromFranchiseId, toFranchiseId });
    }
  }
  const payload = { seasonId: input.seasonId, category: input.category, terms: input.terms.trim(), players, picks, obligations };
  if (JSON.stringify(payload).length > 32768) throw new Error('This trade contains too much text for one record. Shorten the overall or obligation terms before logging it.');
  return payload;
}
