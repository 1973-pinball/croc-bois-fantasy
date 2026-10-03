/** Assigning an already occupied franchise exchanges the two slots in one edit. */
export function assignDraftSlot(ids: readonly string[], slot: number, franchiseId: string): string[] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ids.length) return [...ids];
  const next = [...ids];
  const previousSlot = franchiseId ? next.indexOf(franchiseId) : -1;
  if (previousSlot !== -1 && previousSlot !== slot) next[previousSlot] = next[slot];
  next[slot] = franchiseId;
  return next;
}

/** Stored local lists are untrusted; retain unique IDs from the current catalog only. */
export function readDraftShortlist(raw: string | null, availableIds: ReadonlySet<number>): number[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && availableIds.has(id)))];
  } catch { return []; }
}
