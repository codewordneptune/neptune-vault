// A date to a block height: the first block whose timestamp is not before
// the date's start, found by binary search over heights. Block timestamps
// increase with height (the consensus rules require it), so about
// log2(tip) header lookups settle it; on mainnet that is sixteen.

/** Returns a block's timestamp in ms, or null when the node has no such block. */
export type TimestampAt = (height: number) => Promise<number | null>;

/**
 * The first height at or after which blocks are timestamped `dateMs` or
 * later, between 1 and `tip`. A date before the chain's start gives 1; a
 * date after the tip gives `tip`.
 */
export async function findHeightForDate(timestampAt: TimestampAt, tip: number, dateMs: number): Promise<number> {
  if (tip < 1) return 1;
  let low = 1;
  let high = tip;
  const tipStamp = await timestampAt(tip);
  if (tipStamp !== null && tipStamp < dateMs) return tip;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const stamp = await timestampAt(mid);
    if (stamp === null) throw new Error(`The node has no block ${mid}`);
    if (stamp < dateMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Midnight at the start of a calendar day given as YYYY-MM-DD, in the device's time zone. */
export function startOfDayMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}
