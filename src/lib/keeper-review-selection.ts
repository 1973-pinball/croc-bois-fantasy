/** Only the player just saved may remain outside the active review results. */
export function selectedReviewProfile<T extends { id: number }>(players: T[], candidates: T[], selectedId: number | null, justReviewedId: number | null) {
  return candidates.find(player => player.id === selectedId)
    || (selectedId === justReviewedId ? players.find(player => player.id === justReviewedId) : undefined)
    || candidates[0];
}
