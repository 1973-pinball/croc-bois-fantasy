import type { DraftBoard, DraftBoardPick } from './draft-board';
import type { DraftRosterEligibility, DraftRosterSettings } from './espn-roster-settings';

const ESPN_BENCH_SLOT_ID = 12;

export type DraftRosterPlayer = {
  id: number; name: string; status: 'keeper' | 'selected'; pickId: string; overallPick: number | null;
  eligibleSlots: number[] | null; eligibleLabels: string[]; primaryPositionId: number | null; injuryStatus: string | null;
};
export type DraftRosterSlot = { key: string; slotId: number; label: string; ordinal: number; player: DraftRosterPlayer | null };
export type DraftRosterSlotCount = { slotId: number; label: string; kind: 'normal' | 'reserve'; filled: number; total: number; open: number };
export type DraftRosterUnplaced = {
  player: DraftRosterPlayer;
  reason: 'missing_eligibility' | 'no_normal_slot_eligibility' | 'no_suggested_slot';
  message: string;
};
export type DraftTeamRoster = {
  franchiseId: string; displayName: string; totalPlayers: number; keptPlayers: number; draftedPlayers: number;
  normalCapacity: number; reserveCapacity: number; remainingCapacity: number; overflow: number;
  players: DraftRosterPlayer[]; slots: DraftRosterSlot[]; reserveSlots: DraftRosterSlot[]; slotCounts: DraftRosterSlotCount[];
  eligiblePositionCounts: { slotId: number; label: string; count: number }[];
  unplaced: DraftRosterUnplaced[]; issues: string[];
};
export type DraftRosterSummary = { available: boolean; unavailableReason: string | null; teams: DraftTeamRoster[]; issues: string[] };

function comparePicks(a: DraftBoardPick, b: DraftBoardPick) {
  return (a.overallPick ?? Infinity) - (b.overallPick ?? Infinity) || a.round - b.round || a.id.localeCompare(b.id);
}

/** Breadth-first alternating paths minimize the moves required for this addition. */
function matchPlayers(players: DraftRosterPlayer[], slots: DraftRosterSlot[]) {
  const occupant = new Map<number, number>();
  function augment(start: number, allowedSlots: number[]) {
    const visitedSlots = new Set<number>();
    const parents = new Map<number, { player: number; slot: number } | null>([[start, null]]);
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const player = queue[cursor];
      for (const slot of allowedSlots) {
        if (visitedSlots.has(slot) || !players[player].eligibleSlots?.includes(slots[slot].slotId)) continue;
        visitedSlots.add(slot);
        const previous = occupant.get(slot);
        if (previous !== undefined) {
          if (!parents.has(previous)) { parents.set(previous, { player, slot }); queue.push(previous); }
          continue;
        }
        let nextPlayer = player;
        let nextSlot = slot;
        while (true) {
          occupant.set(nextSlot, nextPlayer);
          const parent = parents.get(nextPlayer);
          if (!parent) break;
          nextPlayer = parent.player;
          nextSlot = parent.slot;
        }
        return true;
      }
    }
    return false;
  }
  const allSlots = slots.map((_, index) => index);
  const positionSlots = allSlots.filter(index => slots[index].slotId >= 0 && slots[index].slotId <= 4);
  const activeSlots = allSlots.filter(index => slots[index].slotId !== ESPN_BENCH_SLOT_ID);
  // Fill specific positions before flex/UTIL, and active positions before BE.
  // A free flex or bench slot must not hide a useful PG/SG reassignment. Each
  // augmentation preserves every occupied slot from the preceding stages.
  for (const stage of [positionSlots, activeSlots, allSlots]) {
    const matchedPlayers = new Set(occupant.values());
    players.forEach((_, index) => { if (!matchedPlayers.has(index)) augment(index, stage); });
  }
  return slots.map((slot, index) => ({ ...slot, player: occupant.has(index) ? players[occupant.get(index)!] : null }));
}

/**
 * A display-only fit of public draft picks to ESPN's configured lineup slots.
 * Position limits and unlimited bench rules are not reinterpreted as draft
 * legality checks. Reserve slots never increase capacity or receive auto-fills.
 */
export function buildDraftRosters(board: DraftBoard, settings: DraftRosterSettings, eligibility: DraftRosterEligibility): DraftRosterSummary {
  const unavailable = (unavailableReason: string): DraftRosterSummary => ({ available: false, unavailableReason, teams: [], issues: [] });
  if (settings.leagueId !== eligibility.leagueId || settings.espnSeasonId !== eligibility.espnSeasonId || board.draftYear + 1 !== settings.espnSeasonId) {
    return unavailable('ESPN roster settings and player eligibility are not available for this draft season.');
  }
  const definitions = [...settings.slots].sort((a, b) => a.slotId - b.slotId);
  if (new Set(definitions.map(slot => slot.slotId)).size !== definitions.length || definitions.some(slot => !Number.isSafeInteger(slot.count) || slot.count < 1)) {
    return unavailable('The ESPN roster slot configuration could not be verified.');
  }
  const normal = definitions.filter(slot => slot.kind === 'normal');
  const reserve = definitions.filter(slot => slot.kind === 'reserve');
  const normalCapacity = normal.reduce((total, slot) => total + slot.count, 0);
  const reserveCapacity = reserve.reduce((total, slot) => total + slot.count, 0);
  if (normalCapacity !== settings.normalCapacity || reserveCapacity !== settings.reserveCapacity) return unavailable('The ESPN roster capacity could not be verified.');
  const catalog = new Map(eligibility.players.map(player => [player.id, player]));
  if (catalog.size !== eligibility.players.length) return unavailable('The ESPN player eligibility snapshot contains duplicate identities.');
  const teamIds = new Set(board.teams.map(team => team.franchiseId));
  if (teamIds.size !== board.teams.length) return unavailable('The public draft board contains duplicate team identities.');
  const issues: string[] = [];
  const teamIssues = new Map(board.teams.map(team => [team.franchiseId, [] as string[]]));
  const picksByPlayer = new Map<number, DraftBoardPick[]>();
  for (const pick of [...board.picks].sort(comparePicks)) {
    if (pick.status === 'available' || (pick.status === 'keeper' && !board.keepersRevealedAt)) continue;
    if (pick.playerId === null || !pick.currentOwnerId || !teamIds.has(pick.currentOwnerId)) {
      issues.push('A public selection without a recognized player or owner was omitted.');
      continue;
    }
    const prior = picksByPlayer.get(pick.playerId) || [];
    prior.push(pick); picksByPlayer.set(pick.playerId, prior);
  }
  const teamPlayers = new Map(board.teams.map(team => [team.franchiseId, [] as DraftRosterPlayer[]]));
  for (const [id, picks] of picksByPlayer) {
    const pick = picks[0];
    const player = catalog.get(id);
    const name = pick.playerName || player?.name || `Player ${id}`;
    const owners = new Set(picks.map(item => item.currentOwnerId!));
    if (owners.size > 1) {
      const message = `${name} appears under multiple owners and is omitted until the public board is corrected.`;
      issues.push(message);
      owners.forEach(owner => teamIssues.get(owner)!.push(message));
      continue;
    }
    if (picks.length > 1) teamIssues.get(pick.currentOwnerId!)!.push(`${name} appears in multiple public picks and is counted once.`);
    const eligibleSlots = player ? [...new Set(player.eligibleSlots)].sort((a, b) => a - b) : null;
    teamPlayers.get(pick.currentOwnerId!)!.push({
      id, name, status: pick.status as 'keeper' | 'selected', pickId: pick.id, overallPick: pick.overallPick,
      eligibleSlots,
      // ESPN includes IR in every captured player's raw eligibleSlots, even when
      // healthy. Labels here cover only this league's normal configured slots.
      eligibleLabels: normal.filter(slot => eligibleSlots?.includes(slot.slotId)).map(slot => slot.label),
      primaryPositionId: player?.primaryPositionId ?? null, injuryStatus: player?.injuryStatus ?? null,
    });
  }
  const expand = (items: typeof definitions): DraftRosterSlot[] => items.flatMap(slot => Array.from({ length: slot.count }, (_, index) => ({
    key: `${slot.slotId}:${index + 1}`, slotId: slot.slotId, label: slot.label, ordinal: index + 1, player: null,
  })));
  const teams = board.teams.map(team => {
    const players = teamPlayers.get(team.franchiseId)!;
    const slots = matchPlayers(players, expand(normal));
    const reserveSlots = expand(reserve);
    const placed = new Set(slots.flatMap(slot => slot.player ? [slot.player.id] : []));
    const unplaced: DraftRosterUnplaced[] = players.filter(player => !placed.has(player.id)).map(player => {
      if (!player.eligibleSlots?.length) return { player, reason: 'missing_eligibility', message: 'ESPN slot eligibility is unavailable for this player.' };
      if (!normal.some(slot => player.eligibleSlots!.includes(slot.slotId))) return { player, reason: 'no_normal_slot_eligibility', message: 'No eligibility for a configured normal slot was supplied by ESPN.' };
      return { player, reason: 'no_suggested_slot', message: 'No suggested slot is available in the configured lineup. This is not a roster legality check.' };
    });
    return {
      franchiseId: team.franchiseId, displayName: team.displayName, totalPlayers: players.length,
      keptPlayers: players.filter(player => player.status === 'keeper').length, draftedPlayers: players.filter(player => player.status === 'selected').length,
      normalCapacity, reserveCapacity, remainingCapacity: Math.max(0, normalCapacity - players.length), overflow: Math.max(0, players.length - normalCapacity),
      players, slots, reserveSlots,
      slotCounts: definitions.map(slot => { const filled = slots.filter(item => item.slotId === slot.slotId && item.player !== null).length;
        return { slotId: slot.slotId, label: slot.label, kind: slot.kind, filled, total: slot.count, open: slot.count - filled }; }),
      eligiblePositionCounts: normal.map(slot => ({ slotId: slot.slotId, label: slot.label, count: players.filter(player => player.eligibleSlots?.includes(slot.slotId)).length })),
      unplaced, issues: teamIssues.get(team.franchiseId)!,
    };
  });
  return { available: true, unavailableReason: null, teams, issues };
}
