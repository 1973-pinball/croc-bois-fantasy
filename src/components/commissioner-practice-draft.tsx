'use client';

import { useEffect, useState } from 'react';
import { draftBoardSchema } from '@/lib/draft-board';
import { canUsePracticeDraft, createPracticeDraft, type PracticeDraft, type PracticeDraftAccess } from '@/lib/practice-draft';
import type { LeagueAccount } from './league-account';
import { PracticeDraftRoom } from './practice-draft-room';
import styles from './live-draft-board.module.css';

/** Dedicated commissioner tab. It never mounts the live room or its clock/queue hooks. */
export function CommissionerPracticeDraft({ account, onExit }: { account: LeagueAccount; onExit: () => void }) {
  if (!account.session?.user || !account.commissioner) return null;
  const access: PracticeDraftAccess = { userId: account.session.user.id, commissioner: account.commissioner, seasonId: account.seasonId, connection: account.connection };
  if (!canUsePracticeDraft(access)) return <section className={`panel ${styles.panel}`} aria-labelledby="practice-loading-title"><div className="panel-header"><h2 id="practice-loading-title">Practice draft</h2><button type="button" className="button button-subtle" onClick={onExit}>Exit practice</button></div><div className={styles.practiceBanner}><p role="status">Connect to the live league to copy its current board into practice.</p><button type="button" className="button button-subtle" onClick={() => void account.reloadLeague()}>Refresh league connection</button></div></section>;
  return <PracticeSnapshotLoader key={`${access.userId}:${access.seasonId}:${access.connection}`} access={access} onExit={onExit}/>;
}

function PracticeSnapshotLoader({ access, onExit }: { access: PracticeDraftAccess; onExit: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [initial, setInitial] = useState<PracticeDraft | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setInitial(null); setError('');
    async function loadSnapshot() {
      try {
        const response = await fetch(`/api/draft-board?seasonId=${encodeURIComponent(access.seasonId)}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : 'The current draft board could not be loaded.');
        const board = draftBoardSchema.parse(body?.board);
        const next = createPracticeDraft(board, access);
        if (!controller.signal.aborted) setInitial(next);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The practice snapshot could not be verified.');
      }
    }
    void loadSnapshot();
    return () => controller.abort();
  }, [access.userId, access.commissioner, access.connection, access.seasonId, attempt]);

  if (initial) return <PracticeDraftRoom initial={initial} access={access} onExit={onExit}/>;
  return <section className={`panel ${styles.panel}`} aria-labelledby="practice-loading-title"><div className="panel-header"><div><p className="eyebrow">COMMISSIONER · LOCAL PRACTICE</p><h2 id="practice-loading-title">Practice draft</h2></div><button type="button" className="button button-subtle" onClick={onExit}>Exit practice</button></div><div className={styles.practiceBanner}><strong>Your official draft stays unchanged</strong><p>Practice starts from a fresh copy of the current board, including revealed keepers and traded pick ownership.</p></div>{error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" className="button button-subtle" onClick={() => setAttempt(value => value + 1)}>Retry practice snapshot</button></div> : <p className={styles.success} role="status">Loading a separate practice copy of the current draft board…</p>}</section>;
}
