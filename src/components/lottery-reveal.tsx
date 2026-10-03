'use client';

import { useEffect, type CSSProperties, type Dispatch, type Ref, type SetStateAction } from 'react';
import styles from './draft-lottery.module.css';

export const lotteryRevealSeconds = [10, 17, 22, 24, 26, 28, 30, 32] as const;
export const lotteryRevealDuration = 32;

export type LotteryPresentation = { resultId: string; startedAt: number; elapsed: number; replay?: boolean };

export function useLotteryRevealTimer(presentation: LotteryPresentation | null, setPresentation: Dispatch<SetStateAction<LotteryPresentation | null>>) {
  const resultId = presentation?.resultId;
  const startedAt = presentation?.startedAt;
  useEffect(() => {
    if (!resultId || startedAt === undefined) return;
    const tick = () => setPresentation(current => current?.resultId === resultId && current.startedAt === startedAt
      ? { ...current, elapsed: Math.min(lotteryRevealDuration, (performance.now() - startedAt) / 1000) } : current);
    const interval = window.setInterval(tick, 100);
    const stop = window.setTimeout(() => {
      setPresentation(current => current?.resultId === resultId && current.startedAt === startedAt ? { ...current, elapsed: lotteryRevealDuration } : current);
      window.clearInterval(interval);
    }, Math.max(0, lotteryRevealDuration * 1000 - (performance.now() - startedAt)));
    return () => { window.clearInterval(interval); window.clearTimeout(stop); };
  }, [resultId, startedAt, setPresentation]);
}

/** Receives only names whose reveal boundary has passed. */
export function LotteryReveal({ visibleNames, elapsed, replay, note, onSkip, containerRef, className = '' }: {
  visibleNames: readonly string[];
  elapsed: number;
  replay?: boolean;
  note?: string;
  onSkip: () => void;
  containerRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  const count = visibleNames.length;
  const animating = count < lotteryRevealSeconds.length;
  return <div ref={containerRef} className={`${styles.presentation} ${className}`} aria-label="Lottery reveal">
    <div className={`${styles.machine} ${animating ? styles.mixing : ''}`} aria-hidden="true">
      <div className={styles.globe}>{Array.from({ length: 8 }, (_, index) => <span key={index} style={{ '--ball': index, '--column': index % 4, '--row': Math.floor(index / 4) } as CSSProperties}/>)}</div>
      <div className={styles.machineBase}>CROC BOIS LOTTERY</div>
    </div>
    <div className={styles.revealContent}>
      <p className={styles.drawEyebrow}>{replay ? 'REPLAY · ' : ''}{animating ? `CHOICE PRIORITY · ${count} OF 8 REVEALED` : 'ALL EIGHT CHOICES REVEALED'}</p>
      {count > 0 ? <div key={count} className={styles.revealedChoice}>
        <div className={styles.openingBall} aria-hidden="true"><i/><b>{count}</b><i/>
          <span className={styles.confetti} data-lottery-confetti={count}>{Array.from({ length: 24 }, (_, index) => <span key={index} style={{ '--dx': `${(index * 47) % 240 - 120}px`, '--dy': `${(index * 37) % 170 - 135}px`, '--turn': `${index * 51}deg`, '--delay': `${(index % 5) * 25}ms` } as CSSProperties}/>)}</span>
        </div>
        <p role="status"><span>Choice priority {count}</span><strong>{visibleNames[count - 1]}</strong></p>
      </div> : <p className={styles.mixingLabel} role="status">Mixing the lottery balls…</p>}
      <progress className={styles.progress} max={lotteryRevealDuration} value={elapsed} aria-label="Lottery reveal progress"/>
      {note && <p className={styles.presentationNote}>{note}</p>}
      {animating && <button type="button" className="text-button" onClick={onSkip}>Skip animation · show saved order</button>}
    </div>
  </div>;
}
