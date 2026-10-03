export type KeeperDraftAssignment = { playerId: number; pickId: string };

export type KeeperDraft = {
  assignments: KeeperDraftAssignment[];
  /** The revision accepted by this editor, never the most recent background read. */
  baseRevision: number | null;
};

export function loadKeeperDraft(assignments: KeeperDraftAssignment[], revision: number): KeeperDraft {
  return { assignments, baseRevision: revision };
}

export function editKeeperDraft(draft: KeeperDraft | undefined, assignments: KeeperDraftAssignment[]): KeeperDraft {
  return { assignments, baseRevision: draft?.baseRevision ?? null };
}

/** Initialize once. A refresh must not attach a newer revision to older local selections. */
export function initializeKeeperDraft(draft: KeeperDraft | undefined, assignments: KeeperDraftAssignment[], revision: number): KeeperDraft {
  if (!draft) return loadKeeperDraft(assignments, revision);
  // A plan made before the first read can safely use an explicitly empty saved baseline.
  if (draft.baseRevision === null && revision === 0) return { ...draft, baseRevision: 0 };
  return draft;
}

export function hasKeeperDraftConflict(draft: KeeperDraft | undefined, savedRevision: number): boolean {
  return draft?.baseRevision === null || draft?.baseRevision === undefined || draft.baseRevision !== savedRevision;
}

/** Keep edits made while saving; advance only the editor that started this save. */
export function acceptKeeperDraftSave(draft: KeeperDraft | undefined, expectedRevision: number, savedRevision: number): KeeperDraft | undefined {
  if (!draft || draft.baseRevision !== expectedRevision) return draft;
  return { ...draft, baseRevision: savedRevision };
}
