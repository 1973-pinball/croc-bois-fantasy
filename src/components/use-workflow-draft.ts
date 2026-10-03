'use client';

import { useRef, useState } from 'react';
import { workflowDrafts } from '@/lib/workflow-drafts';

/** Call from a component keyed by its account/season/entity scope. */
export function useWorkflowDraft<T>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const [draft, setDraft] = useState<T>(() => workflowDrafts.read(key, valid) ?? initial);
  const current = useRef(draft);
  const [persisted, setPersisted] = useState(() => workflowDrafts.persisted(key));
  const [hasDraft, setHasDraft] = useState(() => workflowDrafts.read(key, valid) !== null);
  function updateDraft(patch: Partial<T>) {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPersisted(workflowDrafts.write(key, next));
    setHasDraft(true);
    setDraft(next);
  }
  function discardDraft(next = initial) {
    workflowDrafts.remove(key);
    current.current = next;
    setDraft(next);
    setPersisted(true);
    setHasDraft(false);
  }
  function clearSubmittedDraft(submitted: T, next = initial) {
    // An earlier form may finish saving after another mounted form edits this key.
    // Clear only the submitted snapshot; explicit user discard stays unconditional.
    workflowDrafts.removeIfUnchanged(key, submitted);
    if (current.current !== submitted || workflowDrafts.read(key, valid) !== null) return;
    current.current = next;
    setDraft(next);
    setPersisted(true);
    setHasDraft(false);
  }
  return { draft, updateDraft, discardDraft, clearSubmittedDraft, persisted, hasDraft };
}
