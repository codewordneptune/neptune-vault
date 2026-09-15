// Numbers for people to read: digit grouping in threes by a narrow no-break
// space, which is locale-neutral (no comma-or-point ambiguity) and never
// wraps. Values that go into links, inputs or the node stay ungrouped.

export const NARROW_SPACE = ' ';

/** Group the digits of a plain decimal string's whole part. */
export function groupDigits(text: string): string {
  const [whole, frac] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_SPACE);
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

/** A whole number (block height, megabytes, seconds) for display. */
export function showInt(value: number): string {
  return groupDigits(String(Math.round(value)));
}
