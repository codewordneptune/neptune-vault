// Texts with amounts or times in them, shown as written and said as a
// screen reader should. A voice is likely to say a figure grouped by narrow
// spaces ("12 345.5") as two numbers, the dots of a hidden amount as a row
// of bullets, and the "s" of "45 s" as a letter. So each of these is hidden
// from assistive technology and a plain form is said instead: "12345.5",
// "hidden", "45 seconds". Amount does the same for an amount on its own.

import { Fragment, type ReactNode } from 'react';

const SAID_BADLY = /\b(?:\d{1,3}(?: \d{3})+|\d+) (?:h|min|s)\b|\d{1,3}(?: \d{3})+(?:\.\d+)?|••••/g;
const UNIT_WORDS: Record<string, [string, string]> = { h: ['hour', 'hours'], min: ['minute', 'minutes'], s: ['second', 'seconds'] };

function spokenForm(shown: string): string {
  if (shown === '••••') return 'hidden';
  const figure = shown.replace(/ /g, '');
  const unit = /^(\d+) (h|min|s)$/.exec(figure);
  return unit ? `${unit[1]} ${UNIT_WORDS[unit[2]][unit[1] === '1' ? 0 : 1]}` : figure;
}

/** A text shown as written and said as above; nothing when there is no text. */
export function Spoken({ text }: { text: string | null | undefined }): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SAID_BADLY)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <Fragment key={at}>
        <span aria-hidden>{match[0]}</span>
        <span className="sr-only">{spokenForm(match[0])}</span>
      </Fragment>,
    );
    last = at + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** The same for a text that only a voice hears, such as a button's name. */
export function spokenText(text: string): string {
  return text.replace(SAID_BADLY, spokenForm);
}
