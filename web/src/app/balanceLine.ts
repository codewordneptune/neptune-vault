// The balance over the last days, for the line on Home's balance card:
// today's balance walked back through what each entry in History did to
// it. Worked out on the device from History alone, with no prices and no
// requests; the figures are for drawing, not for adding up.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LineEntry {
  /** What the entry did to the balance: negative for money that left. */
  netNau: bigint;
  timestampMs: number;
  /** Whether the balance shown today includes it (confirmed, or a send on its way). */
  counts: boolean;
}

/**
 * The balance at `days + 1` moments, a day apart, the last being `nowMs`:
 * each is today's balance less what counted entries after that moment did.
 */
export function balanceLine(nowNau: bigint, entries: LineEntry[], nowMs: number, days = 30): bigint[] {
  const counted = entries.filter((e) => e.counts);
  const points: bigint[] = [];
  for (let i = 0; i <= days; i++) {
    const at = nowMs - (days - i) * DAY_MS;
    let after = 0n;
    for (const e of counted) if (e.timestampMs > at) after += e.netNau;
    points.push(nowNau - after);
  }
  return points;
}
