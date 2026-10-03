'use client';

import { useEffect, useState } from 'react';
import { draftLotteryShareIdSchema, draftLotteryShareSchema, type DraftLotteryShare } from '@/lib/draft-lottery-share';
import { LotteryReveal, lotteryRevealSeconds, useLotteryRevealTimer, type LotteryPresentation } from './lottery-reveal';
import styles from './lottery-replay.module.css';

export function LotteryReplay({ shareId }: { shareId: string }) {
  const [replay, setReplay] = useState<DraftLotteryShare | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [retryable, setRetryable] = useState(true);
  const [presentation, setPresentation] = useState<LotteryPresentation | null>(null);
  useLotteryRevealTimer(presentation, setPresentation);

  useEffect(() => {
    const controller = new AbortController();
    setError(''); setReplay(null); setPresentation(null); setRetryable(true);
    if (!draftLotteryShareIdSchema.safeParse(shareId).success) {
      setError('This replay link is unavailable. Check that you have the complete link.');
      setRetryable(false);
      return;
    }
    async function load() {
      try {
        const response = await fetch('/api/draft-lottery/share?shareId=' + encodeURIComponent(shareId), { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) {
          const unavailable = response.status === 404 || response.status === 410;
          if (!controller.signal.aborted) setRetryable(!unavailable);
          throw new Error(unavailable ? 'This replay link is unavailable. It may have been removed.' : 'The replay could not be loaded. Retry to check the connection.');
        }
        const body = await response.json();
        const parsed = draftLotteryShareSchema.safeParse(body?.replay);
        if (!parsed.success || parsed.data.shareId !== shareId) throw new Error('The replay could not be verified. Please try again later.');
        if (controller.signal.aborted) return;
        setReplay(parsed.data);
        setPresentation({ resultId: shareId, startedAt: performance.now(), elapsed: 0 });
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The replay could not be loaded.');
      }
    }
    void load();
    return () => controller.abort();
  }, [shareId, attempt]);

  const count = presentation ? lotteryRevealSeconds.filter(second => second <= presentation.elapsed).length : replay?.order.length || 0;
  const visibleOrder = replay?.order.slice(0, count) || [];
  return <main className={styles.page}>
    <div className={styles.canvas}>
      <header className={styles.context}><h1>Draft-slot choice order{replay ? ` · ${replay.draftYear}` : ''}</h1>{replay && <p>Drawn <time dateTime={replay.drawnAt}>{new Date(replay.drawnAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></p>}</header>
      <p className={styles.explanation}>This draw determines who chooses a slot first. The league records the chosen slots separately before publishing the draft order.</p>
      {error ? <div className={styles.message}><p role="alert">{error}</p>{retryable && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry replay</button>}</div> : !replay ? <p role="status" className={styles.message}>Loading lottery replay…</p> : <>
        <LotteryReveal className={styles.stage} visibleNames={visibleOrder.map(entry => `${entry.managerLabel} · ${entry.teamName}`)} elapsed={presentation?.elapsed ?? 32} replay onSkip={() => setPresentation(null)}/>
        <ol className={styles.order} aria-label="Draft-slot choice priority">{visibleOrder.map(entry => <li key={entry.priority}><span>{entry.priority}</span><div><strong>{entry.managerLabel}</strong><small>{entry.teamName}</small></div></li>)}</ol>
        {count === 8 && <div className={styles.controls}><button type="button" onClick={() => setPresentation({ resultId: shareId, startedAt: performance.now(), elapsed: 0, replay: true })}>Replay animation</button></div>}
      </>}
      <div className={styles.controls}><a href="/?view=draft&draftView=live">Return to the league draft room →</a></div>
    </div>
  </main>;
}
