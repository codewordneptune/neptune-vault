// A saved contact where the app lists people: the name's initial on a
// colour of its own. The colour follows the address, not the name, so a
// renamed contact keeps it, and an address made to look like a contact's
// usually shows another one.

import type { ReactNode } from 'react';

const HUES = 5;

/** A stable colour, 0 to 4, for an address. */
export function hueOf(address: string): number {
  let h = 0x811c9dc5;
  for (const ch of address.trim().toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % HUES;
}

/** The first letter, digit or emoji of a name as people read it, in upper case; invisible marks before it are skipped. */
export function initialOf(name: string): string {
  const graphemes =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name), (s) => s.segment) : Array.from(name);
  const first = graphemes.find((g) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(g));
  return first ? first.toLocaleUpperCase() : '?';
}

/** A contact's circle; `badge` is a small mark at its corner, such as the direction of a payment. */
export function Avatar({ name, address, badge, big = false }: { name: string; address: string; badge?: ReactNode; big?: boolean }) {
  return (
    <span className={big ? 'vault-avatar big' : 'vault-avatar'} data-hue={hueOf(address)} aria-hidden>
      {initialOf(name)}
      {badge && <span className="vault-avatar-badge">{badge}</span>}
    </span>
  );
}
