// Dates for lists: what a person needs at a glance. The full timestamp
// belongs in a detail view.

/** A time of day as this device writes it: "8:55 PM", or "20:55" where the clock has 24 hours. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * How many calendar days back a moment is, when it is within the last week:
 * 0 today, 1 yesterday, up to 6. Past that a weekday would name two days
 * (today's weekday a week ago), so null.
 */
function daysBack(ms: number, now: number): number | null {
  const d = new Date(ms);
  const n = new Date(now);
  for (let days = 0; days <= 6; days++) {
    const x = new Date(n);
    x.setDate(n.getDate() - days);
    if (sameDay(d, x)) return days;
  }
  return null;
}

/** The calendar day of a moment on this device, for grouping: "2026-9-22". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * A day as people say it, for a heading over that day's rows: "Today",
 * "Yesterday", the weekday within the last week ("Monday"), then the date
 * ("21 Aug"), with the year only when it is not this one.
 */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const days = daysBack(ms, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days !== null) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A moment in one phrase, where it stands alone: "Today 8:55 PM", "Mon 8:55 PM", "21 Aug 8:55 PM". */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = formatTime(ms);
  const days = daysBack(ms, now);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days !== null) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
