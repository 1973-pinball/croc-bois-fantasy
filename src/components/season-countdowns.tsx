'use client';

import { useEffect, useState } from 'react';
import { formatSeasonDate } from '@/lib/season-schedule';
import styles from './season-countdowns.module.css';

type Schedule = {
  keeperDeadline?: string | null;
  draftAt?: string | null;
  seasonTimeZone?: string | null;
  phase: string;
  keepersRevealedAt?: string | null;
};

function Countdown({ label, value, timeZone, now, status }: { label: 'Keeper deadline' | 'Draft'; value?: string | null; timeZone: string; now: number | null; status?: string }) {
  const target = value ? Date.parse(value) : NaN;
  const dateLabel = formatSeasonDate(value, timeZone);
  const valid = Number.isFinite(target) && dateLabel !== 'Schedule unavailable';
  const seconds = valid && now !== null ? Math.max(0, Math.ceil((target - now) / 1_000)) : null;
  const reached = seconds === 0;
  const units = seconds === null ? [] : [
    { value: Math.floor(seconds / 86_400), label: 'days' },
    { value: Math.floor(seconds % 86_400 / 3_600), label: 'hours' },
    { value: Math.floor(seconds % 3_600 / 60), label: 'minutes' },
    { value: seconds % 60, label: 'seconds' },
  ];
  const description = reached ? `${label === 'Draft' ? 'Draft time' : label} reached` : seconds === null ? '' : `${units.map(unit => `${unit.value} ${unit.label}`).join(', ')} remaining`;
  return <div className={`${styles.card} ${reached ? styles.reached : ''}`}>
    <div className={styles.cardHeading}><strong>{label}</strong>{status && <span className={status === 'Submissions open' ? styles.open : styles.status}>{status}</span>}</div>
    <p className={styles.date}>{valid && value ? <time dateTime={value}>{dateLabel}</time> : dateLabel}</p>
    {valid ? <>
      <div className={styles.timer} role="timer" aria-live="off" aria-label={`${label} countdown: ${description || 'calculating time remaining'}`}>
        {seconds === null ? <span className={styles.pending}>Loading clock…</span> : units.map(unit => <span className={styles.unit} key={unit.label} aria-hidden="true"><b>{String(unit.value).padStart(2, '0')}</b><small>{unit.label[0]}</small></span>)}
      </div>
      {reached && <p className={styles.caption} role="status">{description}</p>}
    </> : <p className={styles.unscheduled}>{value ? 'A verified date and time are needed for this countdown.' : 'The countdown will appear when a date is saved.'}</p>}
  </div>;
}

/** Display-only clocks. Passing a deadline never changes submission or draft permissions. */
export function SeasonCountdowns({ schedule, label = 'League schedule countdowns' }: { schedule: Schedule; label?: string }) {
  // The first client render matches the server; the clock starts only after hydration.
  const [now, setNow] = useState<number | null>(null);
  const hasDate = Boolean(schedule.keeperDeadline || schedule.draftAt);
  useEffect(() => {
    if (!hasDate) return;
    const update = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    update();
    const timer = window.setInterval(update, 1_000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [hasDate]);
  const timeZone = schedule.seasonTimeZone || 'UTC';
  const deadlinePassed = now !== null && Boolean(schedule.keeperDeadline) && now >= Date.parse(schedule.keeperDeadline!);
  const keeperStatus = schedule.phase === 'keeper_selection' && !schedule.keepersRevealedAt ? deadlinePassed ? 'Submissions closed' : 'Submissions open' : schedule.phase === 'setup' ? 'Submissions not open' : 'Keeper selection closed';
  return <section className={styles.schedule} aria-label={label}>
    <div className={styles.cards}>
      <Countdown label="Keeper deadline" value={schedule.keeperDeadline} timeZone={timeZone} now={now} status={keeperStatus}/>
      <Countdown label="Draft" value={schedule.draftAt} timeZone={timeZone} now={now}/>
    </div>
    <p className={styles.note}>Players lock at deadline · Payment picks editable until draft</p>
  </section>;
}
