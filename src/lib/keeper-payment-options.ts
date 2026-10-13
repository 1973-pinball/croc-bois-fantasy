import type { DraftPick } from './types';

export type PaymentAssignment = { playerId: number; pickId: string };
export type FixedKeeperPayment = PaymentAssignment & { baseRound: number | null };
export type KeeperPaymentOptionsInput = {
  season: number;
  teamId: number;
  keepers: FixedKeeperPayment[];
  /** May contain prospective owners when preparing a trade finalization. */
  picks: DraftPick[];
  usedPickIds?: string[];
  /** Only keeper-consumed picks being reconciled by this operation; never live draft picks. */
  reusablePickIds?: string[];
};

function paymentPool(input: KeeperPaymentOptionsInput) {
  const used = new Set(input.usedPickIds);
  const reusable = new Set(input.reusablePickIds);
  return input.picks.filter(pick => pick.season === input.season && pick.ownerTeamId === input.teamId
    && Number.isInteger(pick.round) && pick.round > 0 && (!used.has(pick.id) || reusable.has(pick.id)));
}

/** Payment rules use the submitted cost, independent of later profile edits. */
export function isValidKeeperPaymentAllocation(input: KeeperPaymentOptionsInput, assignments: PaymentAssignment[]): boolean {
  if (assignments.length !== input.keepers.length || new Set(input.keepers.map(k => k.playerId)).size !== input.keepers.length
    || new Set(assignments.map(a => a.playerId)).size !== assignments.length || new Set(assignments.map(a => a.pickId)).size !== assignments.length) return false;
  const pool = paymentPool(input);
  if (new Set(pool.map(p => p.id)).size !== pool.length) return false;
  const selected = new Set(assignments.map(a => a.pickId));
  return input.keepers.every(keeper => {
    if (!Number.isInteger(keeper.baseRound) || keeper.baseRound! < 1) return false;
    const assignment = assignments.find(a => a.playerId === keeper.playerId);
    const pick = pool.find(p => p.id === assignment?.pickId);
    return Boolean(pick && pick.round <= keeper.baseRound!
      && !pool.some(other => !selected.has(other.id) && other.round > pick.round && other.round <= keeper.baseRound!));
  });
}

/**
 * Every option includes a complete legal allocation. If another keeper must move,
 * the UI previews those payment changes together instead of presenting a dead end.
 * Nested round eligibility lets constrained keepers claim the nearest picks first.
 */
export function keeperPaymentOptions(input: KeeperPaymentOptionsInput, current: PaymentAssignment[] = input.keepers) {
  const pool = paymentPool(input);
  const fixed = input.keepers.map(({ playerId, pickId }) => ({ playerId, pickId }));
  const preferred = new Map(current.map(a => [a.playerId, a.pickId]));
  const complete = (pinned?: PaymentAssignment): PaymentAssignment[] | null => {
    const direct = fixed.map(keeper => ({ playerId: keeper.playerId, pickId: pinned?.playerId === keeper.playerId ? pinned.pickId : preferred.get(keeper.playerId) || keeper.pickId }));
    if (isValidKeeperPaymentAllocation(input, direct)) return direct;
    const selected = new Map<number, string>();
    const taken = new Set<string>();
    if (pinned) {
      const keeper = input.keepers.find(k => k.playerId === pinned.playerId);
      const pick = pool.find(p => p.id === pinned.pickId);
      if (!keeper || !pick || keeper.baseRound === null || pick.round > keeper.baseRound) return null;
      selected.set(pinned.playerId, pinned.pickId); taken.add(pinned.pickId);
    }
    for (const keeper of [...input.keepers].sort((a, b) => (a.baseRound ?? -1) - (b.baseRound ?? -1) || a.playerId - b.playerId)) {
      if (selected.has(keeper.playerId)) continue;
      if (!Number.isInteger(keeper.baseRound) || keeper.baseRound! < 1) return null;
      const pick = pool.filter(p => !taken.has(p.id) && p.round <= keeper.baseRound!)
        .sort((a, b) => b.round - a.round || Number(b.id === preferred.get(keeper.playerId)) - Number(a.id === preferred.get(keeper.playerId)) || a.id.localeCompare(b.id))[0];
      if (!pick) return null;
      selected.set(keeper.playerId, pick.id); taken.add(pick.id);
    }
    const result = fixed.map(keeper => ({ playerId: keeper.playerId, pickId: selected.get(keeper.playerId)! }));
    return isValidKeeperPaymentAllocation(input, result) ? result : null;
  };
  const assignments = complete();
  const options: Record<number, { pickId: string; assignments: PaymentAssignment[] }[]> = {};
  for (const keeper of input.keepers) {
    options[keeper.playerId] = pool.slice().sort((a, b) => a.round - b.round || a.id.localeCompare(b.id)).flatMap(pick => {
      const result = complete({ playerId: keeper.playerId, pickId: pick.id });
      return result ? [{ pickId: pick.id, assignments: result }] : [];
    });
  }
  return { assignments, options };
}
