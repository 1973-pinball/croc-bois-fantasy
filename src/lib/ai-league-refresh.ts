import type { AiLeagueRun } from './ai-league-types';

export function easternDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function nextDate(date: string, amount = 1): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

/** A bounded fetch queue: protect today's live decision, then settle saved lineups and inspect missed calendar days. */
export function refreshDates(run: AiLeagueRun, today: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new RangeError('Refresh batches must contain one to three dates.');
  const first = run.matchups.map(matchup => matchup.start).sort()[0];
  const seededLast = run.matchups.map(matchup => matchup.end).sort().at(-1);
  if (!first || !seededLast || today < first || run.status === 'complete') return [];
  const scored = new Set(run.scoredDates);
  if (run.mode === 'replay') {
    const dates: string[] = [];
    // Stop at the current bracket boundary: scoring the preceding round creates the next one.
    for (let date = first; date <= seededLast && date < today && dates.length < limit; date = nextDate(date)) {
      if (!scored.has(date)) dates.push(date);
    }
    return dates;
  }
  const last = run.calendarEnd ?? seededLast;
  const missed = new Set(run.missedDates ?? []);
  const includeToday = today <= last && !scored.has(today) && !missed.has(today);
  const remaining = limit - Number(includeToday);
  const pending = [...new Set(run.lineups.filter(lineup => lineup.date >= first && lineup.date < today && lineup.date <= last && !scored.has(lineup.date) && !missed.has(lineup.date)).map(lineup => lineup.date))].sort().slice(0, remaining);
  // A past date without a lineup can still be an empty NBA day. The engine alone decides
  // whether it can score zero or must preserve an irrecoverable missed game-day lock.
  for (let date = first; date < today && date <= last && pending.length < remaining; date = nextDate(date)) {
    if (!scored.has(date) && !missed.has(date) && !pending.includes(date)) pending.push(date);
  }
  if (includeToday) pending.push(today);
  return pending.sort();
}
