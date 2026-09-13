// Dates for lists: what a person needs at a glance. The full timestamp
// belongs in a detail view.

export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) return `Today ${time}`;
  const yesterday = new Date(n);
  yesterday.setDate(n.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
