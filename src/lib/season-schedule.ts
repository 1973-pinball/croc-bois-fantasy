/** The commissioner enters wall-clock time in the league's named time zone. */
function localParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

export function scheduleInput(value: string | null, timeZone: string): string {
  return value ? localParts(new Date(value), timeZone).slice(0, 16) : '';
}

export function scheduleInstant(value: string, timeZone: string): string | null {
  if (!value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Enter a complete date and time.');
  const target = value + ':00';
  const naive = Date.parse(target + 'Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== target) throw new Error('Enter a valid calendar date and time.');
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = naive + hours * 3_600_000;
    offsets.add(Date.parse(localParts(new Date(instant), timeZone) + 'Z') - instant);
  }
  const candidates = [...offsets].map(offset => naive - offset)
    .filter(instant => localParts(new Date(instant), timeZone) === target);
  if (!candidates.length) throw new Error('That time does not exist because the clocks change. Choose another time.');
  if (candidates.length > 1) throw new Error('That time occurs twice because the clocks change. Choose an unambiguous time, or enter the schedule in UTC.');
  return new Date(candidates[0]).toISOString();
}

export function formatSeasonDate(value: string | null | undefined, timeZone?: string | null): string {
  if (!value) return 'Not scheduled';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(value));
  } catch { return 'Schedule unavailable'; }
}
