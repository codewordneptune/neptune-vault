// Dates and times, for every screen. The app is in English, so day and
// month names are English whatever the device's language; left to the
// device, a Finnish phone wrote "lauantai" under "Yesterday". Only the clock
// follows the device: 12 hours with AM and PM where it uses them ("8:55 PM"),
// otherwise 24 ("20:55"). Dates put the day first: "22 Sept 2026".

const deviceUses12Hours = (() => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h12' || cycle === 'h11';
  } catch {
    return false;
  }
})();
const TIME_LOCALE = deviceUses12Hours ? 'en-US' : 'en-GB';
const DATE_LOCALE = 'en-GB';

/** A time of day: "8:55 PM", or "20:55" where the device keeps a 24-hour clock. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(TIME_LOCALE, { hour: 'numeric', minute: '2-digit' });
}

/** A date: "22 Sept 2026". */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A date and time: "22 Sept 2026, 8:55 PM". */
export function formatDateTime(ms: number): string {
  return `${formatDate(ms)}, ${formatTime(ms)}`;
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

const dayMonth = (ms: number) => new Date(ms).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' });
const weekday = (ms: number, width: 'long' | 'short') => new Date(ms).toLocaleDateString(DATE_LOCALE, { weekday: width });

/**
 * A day as people say it, for a heading over that day's rows: "Today",
 * "Yesterday", the weekday within the last week ("Monday"), then the date
 * ("21 Aug"), with the year only when it is not this one.
 */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = daysBack(ms, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days !== null) return weekday(ms, 'long');
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return dayMonth(ms);
  return formatDate(ms);
}

/** A moment in one phrase, where it stands alone: "Today 8:55 PM", "Mon 8:55 PM", "21 Aug 8:55 PM". */
export function formatWhen(ms: number, now = Date.now()): string {
  const time = formatTime(ms);
  const days = daysBack(ms, now);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days !== null) return `${weekday(ms, 'short')} ${time}`;
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return `${dayMonth(ms)} ${time}`;
  return formatDate(ms);
}

/**
 * A length of time, one way everywhere: "45 s", "2 min 23 s", "1 h 5 min".
 * Seconds drop away past the hour, where nobody counts them.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
  const m = Math.round(s / 60);
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** An estimate, rounded as people say one: "about 40 s", "about 2 min". */
export function formatAbout(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 90 ? `about ${s} s` : `about ${Math.round(s / 60)} min`;
}
