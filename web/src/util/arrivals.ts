// Which payments to this wallet arrived while History was in view, so that
// each slides in rather than simply appearing (Home.tsx).

import type { HistoryRecord } from '../storage/db';

/** A payment from the last half hour has just arrived; an older one newly listed was found by a scan. */
export const ARRIVED_WITHIN_MS = 30 * 60 * 1000;

/** What History listed, to tell a payment that just arrived from one it already showed. */
export interface Listed {
  keys: Set<string>;
  /** The amounts of the pending payments to this wallet, by row. */
  pending: Map<string, string>;
  /** The amounts of pending payments whose rows have gone: their confirmed rows come under other keys. */
  confirming: string[];
}

/**
 * The payments to this wallet in `rows` that were not listed `before`, and
 * the listing to compare the next rows with. A payment's pending row and
 * its confirmed row have different keys, so a confirmed row with the amount
 * of a pending row that went is that payment confirming, not a new one.
 * With nothing before (a wallet's first listing), nothing has arrived.
 */
export function arrivals(before: Listed | null, rows: HistoryRecord[], now: number): { listed: Listed; arrived: string[] } {
  const keys = new Set(rows.map((r) => r.key));
  const pending = new Map(rows.filter((r) => r.kind === 'received' && r.status === 'pending').map((r) => [r.key, r.amountNau]));
  if (!before) return { listed: { keys, pending, confirming: [] }, arrived: [] };
  const confirming = [...before.confirming];
  for (const [key, amount] of before.pending) if (!keys.has(key)) confirming.push(amount);
  const arrived: string[] = [];
  for (const r of rows) {
    if (r.kind !== 'received' || before.keys.has(r.key)) continue;
    const i = r.status === 'confirmed' ? confirming.indexOf(r.amountNau) : -1;
    if (i >= 0) confirming.splice(i, 1);
    else if (now - r.timestampMs <= ARRIVED_WITHIN_MS) arrived.push(r.key);
  }
  // A pending payment that never confirms leaves its amount here: a few are kept.
  return { listed: { keys, pending, confirming: confirming.slice(-20) }, arrived };
}
