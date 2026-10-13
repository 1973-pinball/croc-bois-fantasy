'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { draftBoardSchema, draftQueueSchema, type DraftAction, type DraftBoard, type DraftQueue } from '@/lib/draft-board';
import type { LeagueAccount } from './league-account';
import styles from './live-draft-board.module.css';

function clockSeconds(board: DraftBoard, elapsed: number) {
  if (board.clock.status === 'running' && board.clock.deadlineAt) {
    return Math.max(0, Math.ceil((Date.parse(board.clock.deadlineAt) - Date.parse(board.clock.serverNow) - elapsed) / 1000));
  }
  return Math.max(0, Math.ceil(board.clock.remainingSeconds ?? board.clock.durationSeconds));
}

export function DraftClock({ board, commissioner, busy, blocked, send, acceptBoard }: {
  board: DraftBoard; commissioner: boolean; busy: boolean; blocked: boolean;
  send: (action: DraftAction, success: string) => Promise<boolean>; acceptBoard: (board: DraftBoard) => void;
}) {
  const [duration, setDuration] = useState(String(board.clock.durationSeconds));
  const [seconds, setSeconds] = useState(() => clockSeconds(board, 0));
  const [tickError, setTickError] = useState('');
  const latest = useRef({ board, busy, acceptBoard });
  latest.current = { board, busy, acceptBoard };
  const anchor = useRef<{ serverNow: string; receivedAt: number } | null>(null);
  useEffect(() => { setDuration(String(board.clock.durationSeconds)); }, [board.clock.durationSeconds]);
  useEffect(() => {
    const current = latest.current.board;
    // A repeated response with the same server timestamp must not restart elapsed time.
    if (!anchor.current || anchor.current.serverNow !== current.clock.serverNow) anchor.current = { serverNow: current.clock.serverNow, receivedAt: performance.now() };
    const remaining = clockSeconds(current, performance.now() - anchor.current.receivedAt);
    setSeconds(remaining);
    if (current.clock.status !== 'running' || remaining > 0) setTickError('');
  }, [board.clock.serverNow, board.clock.status, board.clock.deadlineAt, board.clock.remainingSeconds, board.clock.durationSeconds]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let retryAt = 0;
    const refreshClock = async () => {
      const current = latest.current;
      const elapsed = anchor.current ? performance.now() - anchor.current.receivedAt : 0;
      const remaining = clockSeconds(current.board, elapsed);
      setSeconds(remaining);
      if (current.board.clock.status !== 'running' || remaining > 0 || pending || current.busy || Date.now() < retryAt || document.visibilityState !== 'visible') return;
      pending = true;
      retryAt = Date.now() + 1500;
      try {
        const response = await fetch('/api/draft-board', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'tick', seasonId: current.board.seasonId }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'The automatic pick is waiting for the server. Retrying…');
        const next = draftBoardSchema.parse(body.board);
        if (controller.signal.aborted || next.seasonId !== current.board.seasonId) return;
        latest.current.acceptBoard(next); setTickError('');
      } catch (failure) {
        if (!controller.signal.aborted) setTickError(failure instanceof Error ? failure.message : 'The automatic pick is waiting for the server. Retrying…');
      } finally { pending = false; }
    };
    const interval = window.setInterval(() => void refreshClock(), 250);
    void refreshClock();
    window.addEventListener('focus', refreshClock); document.addEventListener('visibilitychange', refreshClock);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', refreshClock); document.removeEventListener('visibilitychange', refreshClock); };
  }, [board.seasonId]);

  const status = board.clock.status;
  const configurable = status === 'waiting' && !board.clock.startedAt;
  const validDuration = /^\d+$/.test(duration) && Number(duration) >= 10 && Number(duration) <= 600;
  const changed = Number(duration) !== board.clock.durationSeconds;
  const ready = board.phase === 'draft_ready' && board.orderComplete && Boolean(board.keepersRevealedAt && board.nextPickId);
  const disabled = !commissioner || busy || blocked;
  const action = status === 'running' ? 'pause' : status === 'paused' ? 'resume' : 'start';
  const label = status === 'running' ? 'PAUSE DRAFT' : status === 'paused' ? 'RESUME DRAFT' : status === 'completed' ? 'DRAFT COMPLETE' : 'START DRAFT';
  const formatted = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return <div className={styles.clockPanel} aria-label="Draft clock and commissioner controls">
    <div className={styles.clockReadout}><span>{status === 'running' ? seconds === 0 ? 'Making automatic pick' : 'Time remaining' : status === 'paused' ? 'Draft paused' : status === 'completed' ? 'Draft complete' : 'Draft starts here'}</span><strong className={status === 'running' && seconds <= 10 ? styles.clockUrgent : ''} role="timer" aria-label={status === 'completed' ? 'Draft complete' : `${seconds} seconds remaining`}>{status === 'completed' ? '—' : formatted}</strong></div>
    <div className={styles.clockControls}>
      {configurable ? <div className={styles.timerSetting}><label htmlFor="draft-pick-seconds">Seconds per pick<input id="draft-pick-seconds" type="number" min={10} max={600} step={1} value={duration} onChange={event => setDuration(event.target.value)} disabled={disabled} aria-describedby="draft-clock-help"/></label><button type="button" className="button button-subtle" disabled={disabled || !validDuration || !changed} onClick={() => void send({ action: 'configure', seasonId: board.seasonId, expectedRevision: board.revision, durationSeconds: Number(duration) }, 'Draft timer saved.')}>Save timer</button></div> : <span className={styles.timerDuration}>{board.clock.durationSeconds} seconds per pick</span>}
      <button type="button" className={`button ${status === 'running' ? 'button-subtle' : 'button-green'}`} disabled={disabled || !ready || status === 'completed' || (configurable && (!validDuration || changed))} onClick={() => void send({ action, seasonId: board.seasonId, expectedRevision: board.revision }, action === 'pause' ? 'Draft paused. Time remaining is saved.' : action === 'resume' ? 'Draft resumed.' : 'Draft started. The first pick is on the clock.')}>{busy ? 'Saving…' : label}</button>
    </div>
    <p id="draft-clock-help" className={styles.clockHelp}>{!commissioner ? 'Only the commissioner can configure, start, pause, or resume the draft. ' : configurable && (!validDuration || changed) ? !validDuration ? 'Choose a whole number from 10 to 600 seconds. ' : 'Save the timer before starting the draft. ' : ''}{!ready && status !== 'completed' ? 'The draft needs a published order, revealed keepers, and an available pick. ' : ''}{status === 'paused' ? 'The countdown resumes from the saved time. ' : ''}When time expires, your team’s first available queued player is drafted, then the highest available ESPN-ranked player if your queue is empty.</p>
    {tickError && <p className={styles.clockError} role="status">{tickError}</p>}
  </div>;
}

export function useDraftQueue(account: LeagueAccount, board: DraftBoard | null) {
  const teams = board?.teams.filter(team => team.espnTeamId !== null && account.ownTeamIds.includes(team.espnTeamId)) || [];
  const [selectedTeam, setSelectedTeam] = useState('');
  const franchiseId = teams.some(team => team.franchiseId === selectedTeam) ? selectedTeam : teams[0]?.franchiseId || '';
  const key = account.session?.user && account.connection === 'live' && franchiseId ? `${account.session.user.id}:${account.seasonId}:${franchiseId}:${teams.map(team => team.franchiseId).sort().join(',')}` : '';
  const keyRef = useRef(key); keyRef.current = key;
  const [saved, setSaved] = useState<{ key: string; queue: DraftQueue } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const latestAccount = useRef(account); latestAccount.current = account;
  const queue = saved?.key === key ? saved.queue : null;

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!key) return;
    try {
      const response = await fetch(`/api/draft-queue?seasonId=${encodeURIComponent(account.seasonId)}&franchiseId=${encodeURIComponent(franchiseId)}`, { cache: 'no-store', credentials: 'same-origin', signal });
      const body = await response.json();
      if (signal?.aborted || keyRef.current !== key) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) { setSaved(null); void latestAccount.current.reloadSession(); }
        throw new Error(body.message || 'Your draft queue could not be loaded.');
      }
      const next = draftQueueSchema.parse(body.queue);
      if (next.seasonId !== account.seasonId || next.franchiseId !== franchiseId) throw new Error('The queue response could not be verified.');
      setSaved(previous => previous?.key === key && previous.queue.revision > next.revision ? previous : { key, queue: next }); setError('');
    } catch (failure) {
      if (!signal?.aborted && keyRef.current === key) setError(failure instanceof Error ? failure.message : 'Your draft queue could not be loaded.');
    } finally { if (!signal?.aborted && keyRef.current === key) setLoading(false); }
  }, [key, account.seasonId, franchiseId]);

  useEffect(() => {
    setSaved(null); setError(''); setLoading(Boolean(key)); setBusy(false); writing.current = false;
    const controller = new AbortController(); controllerRef.current = controller;
    let pending = false;
    const refresh = async () => {
      if (!key || pending || writing.current || document.visibilityState !== 'visible') return;
      pending = true; try { await load(controller.signal); } finally { pending = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [key, load]);

  async function save(playerIds: number[]) {
    if (!key || !queue || writing.current || !controllerRef.current || controllerRef.current.signal.aborted) return;
    const signal = controllerRef.current.signal;
    writing.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/draft-queue', { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seasonId: account.seasonId, franchiseId, expectedRevision: queue.revision, playerIds }) });
      const body = await response.json();
      if (signal.aborted || keyRef.current !== key) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) { setSaved(null); void latestAccount.current.reloadSession(); }
        if (response.status === 409) await load(signal);
        throw new Error(body.message || 'Your queue change could not be saved.');
      }
      const next = draftQueueSchema.parse(body.queue);
      if (next.seasonId !== account.seasonId || next.franchiseId !== franchiseId) throw new Error('The queue response could not be verified.');
      setSaved(previous => previous?.key === key && previous.queue.revision > next.revision ? previous : { key, queue: next });
    } catch (failure) {
      if (!signal.aborted && keyRef.current === key) setError(failure instanceof Error ? failure.message : 'Your queue change could not be saved.');
    } finally { if (!signal.aborted && keyRef.current === key) { writing.current = false; setBusy(false); } }
  }
  return { teams, franchiseId, selectTeam: setSelectedTeam, queue, loading: Boolean(key) && (loading || !queue && !error), busy, error, save, reload: () => load(controllerRef.current?.signal), enabled: Boolean(key) };
}
