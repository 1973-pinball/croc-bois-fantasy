'use client';

import { useEffect, useRef, useState } from 'react';
import { draftLotteryShareSchema } from '@/lib/draft-lottery-share';
import styles from './draft-lottery.module.css';

export function ShareLotteryResults({ seasonId, drawnAt, disabled, onAccessDenied }: {
  seasonId: string;
  drawnAt: string;
  disabled: boolean;
  onAccessDenied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const working = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);

  async function copy(link: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(link);
      if (active.current) setCopied(true);
    } catch {
      if (active.current) setCopied(false);
    }
  }

  async function share() {
    if (disabled || working.current) return;
    working.current = true; setBusy(true); setError(''); setCopied(false); setUrl('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch('/api/draft-lottery/share', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seasonId }), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!active.current || controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { onAccessDenied(); return; }
        throw new Error(body?.message || 'A replay link could not be created. Please try again.');
      }
      const parsed = draftLotteryShareSchema.safeParse(body?.replay);
      if (!parsed.success || Date.parse(parsed.data.drawnAt) !== Date.parse(drawnAt)) throw new Error('The shared result could not be verified. Refresh the lottery before trying again.');
      const link = new URL('/lottery-replay', window.location.origin);
      link.searchParams.set('shareId', parsed.data.shareId);
      setUrl(link.href);
      await copy(link.href);
    } catch (failure) {
      if (active.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'A replay link could not be created.');
    } finally { working.current = false; if (active.current) setBusy(false); }
  }

  return <div className={styles.share}>
    <div className={styles.replayControls}><button type="button" className="button button-green" disabled={disabled || busy} onClick={() => void share()}>{busy ? 'Preparing replay link…' : 'Share Lottery Results'}</button><p>Creates a replay link anyone with the link can view.</p></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {url && !busy && (copied ? <p role="status" className={styles.shareStatus}>Replay link copied. Anyone with this link can watch the saved choice order.</p> : <div className={styles.shareFallback}>
      <p role="status">The replay link is ready, but it could not be copied automatically. Select the link to copy it, or try again.</p>
      <label>Replay link<input type="url" readOnly value={url} onFocus={event => event.currentTarget.select()}/></label>
      <button type="button" className="button button-subtle" disabled={busy} onClick={() => void copy(url)}>Copy replay link</button>
    </div>)}
  </div>;
}
