import type { DraftCatalogPlayer } from './draft-player-catalog';
import type { LeaguePlayer } from './types';

export type PlayerPoolPlayer = Omit<LeaguePlayer, 'teamId'> & { teamId: number | null };

/** Add the current ESPN pool for browsing without granting keeper eligibility or league ownership. */
export function buildPlayerPool(rosterPlayers: readonly LeaguePlayer[], catalogPlayers: readonly DraftCatalogPlayer[]): PlayerPoolPlayer[] {
  const players = new Map<number, PlayerPoolPlayer>();
  for (const player of rosterPlayers) {
    if (!players.has(player.id)) players.set(player.id, player);
  }
  for (const player of catalogPlayers) {
    if (players.has(player.id) || !player.active || !player.selectable) continue;
    players.set(player.id, {
      id: player.id,
      name: player.name,
      teamId: null,
      baseCost: null,
      tenure: null,
      status: 'ineligible',
      reason: 'Not on a current league roster, so this player cannot be kept. Keeper ineligibility does not prevent drafting.',
      wasKept: false,
      previousRound: null,
      rosterSlot: '',
    });
  }
  return [...players.values()];
}
