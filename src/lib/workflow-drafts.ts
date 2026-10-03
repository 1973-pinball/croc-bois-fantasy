const prefix = 'croc-bois:workflow:v1:';
type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export function workflowDraftKey(accountId: string, seasonId: string, kind: 'trade' | 'profile', playerId?: number) {
  return `${prefix}${encodeURIComponent(accountId)}:${encodeURIComponent(seasonId)}:${kind}${playerId === undefined ? '' : `:${playerId}`}`;
}

/** Session-only drafts never cross account boundaries or become official records. */
export function createWorkflowDraftStore(getStorage: () => DraftStorage | null) {
  const memory = new Map<string, unknown>();
  function storage() { try { return getStorage(); } catch { return null; } }
  function remove(key: string) {
    memory.delete(key);
    try { storage()?.removeItem(key); } catch { /* Keep navigation usable if storage is blocked. */ }
  }
  return {
    account(accountId: string | null) {
      const keep = accountId ? `${prefix}${encodeURIComponent(accountId)}:` : null;
      for (const key of memory.keys()) if (!keep || !key.startsWith(keep)) memory.delete(key);
      try {
        const target = storage();
        if (target) for (let index = target.length - 1; index >= 0; index--) {
          const key = target.key(index);
          if (key?.startsWith(prefix) && (!keep || !key.startsWith(keep))) target.removeItem(key);
        }
      } catch { /* The in-memory account boundary still applies. */ }
    },
    read<T>(key: string, valid: (value: unknown) => value is T): T | null {
      let value = memory.get(key);
      if (value === undefined) {
        try { const raw = storage()?.getItem(key); if (raw) value = JSON.parse(raw); } catch { remove(key); }
      }
      if (value !== undefined && valid(value)) { memory.set(key, value); return value; }
      if (value !== undefined) remove(key);
      return null;
    },
    write<T>(key: string, value: T) {
      memory.set(key, value);
      try { const target = storage(); if (!target) return false; target.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    persisted(key: string) {
      if (!memory.has(key)) return true;
      try { return storage()?.getItem(key) === JSON.stringify(memory.get(key)); } catch { return false; }
    },
    removeIfUnchanged<T>(key: string, submitted: T) {
      let current = memory.get(key);
      if (current === undefined) {
        try { const raw = storage()?.getItem(key); if (raw) current = JSON.parse(raw); } catch { return false; }
      }
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(submitted)) return false;
      remove(key);
      return true;
    },
    remove,
  };
}

export const workflowDrafts = createWorkflowDraftStore(() => typeof window === 'undefined' ? null : window.sessionStorage);
