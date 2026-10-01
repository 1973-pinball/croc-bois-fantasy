import type { DraftPick } from "./types";

/** Identity never includes current ownership or a lottery-dependent overall slot. */
export function draftPickId(season: number, round: number, originalFranchiseId: string): string {
  return `pick:${season}:${round}:${encodeURIComponent(originalFranchiseId)}`;
}

export function generateDraftPicks(input: {
  season: number;
  franchiseIds: readonly string[];
  rounds: number;
}): DraftPick[] {
  if (!Number.isInteger(input.season) || !Number.isInteger(input.rounds) || input.rounds < 1) throw new Error("A draft requires an integer season and positive round count.");
  if (input.franchiseIds.length < 2 || input.franchiseIds.some((id) => !id) || new Set(input.franchiseIds).size !== input.franchiseIds.length) throw new Error("A draft requires at least two distinct franchises.");
  return Array.from({ length: input.rounds }, (_, index) => index + 1).flatMap((round) =>
    input.franchiseIds.map((franchiseId) => ({
      id: draftPickId(input.season, round, franchiseId), season: input.season, round,
      originalFranchiseId: franchiseId, ownerFranchiseId: franchiseId,
    })));
}

export interface DraftBoardCell extends DraftPick {
  slotInRound: number;
  overallPick: number;
}

export function buildSnakeDraftBoard(picks: readonly DraftPick[], draftOrder: readonly string[]): DraftBoardCell[] {
  if (draftOrder.length < 2 || new Set(draftOrder).size !== draftOrder.length) throw new Error("Draft order must contain distinct franchises.");
  if (!picks.length) return [];
  if (new Set(picks.map((pick) => pick.season)).size !== 1) throw new Error("A draft board can contain only one season.");
  const rounds = Math.max(...picks.map((pick) => pick.round));
  const expectedCount = rounds * draftOrder.length;
  if (picks.length !== expectedCount || new Set(picks.map((pick) => pick.id)).size !== picks.length) throw new Error("The pick ledger is incomplete or contains duplicate identities.");
  const identities = new Map<string, DraftPick>();
  for (const pick of picks) {
    if (!Number.isInteger(pick.round) || pick.round < 1 || !draftOrder.includes(pick.originalFranchiseId)) throw new Error("A pick does not belong to this season's participants and rounds.");
    const key = `${pick.round}:${encodeURIComponent(pick.originalFranchiseId)}`;
    if (identities.has(key)) throw new Error("A franchise has more than one originating pick in a round.");
    identities.set(key, pick);
  }
  const board: DraftBoardCell[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 === 1 ? [...draftOrder] : [...draftOrder].reverse();
    for (const [index, franchiseId] of order.entries()) {
      const pick = identities.get(`${round}:${encodeURIComponent(franchiseId)}`);
      if (!pick) throw new Error("An originating pick is missing from the draft ledger.");
      board.push({ ...pick, slotInRound: index + 1, overallPick: board.length + 1 });
    }
  }
  return board;
}
