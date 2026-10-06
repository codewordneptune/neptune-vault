// An amount as people read it, and as a screen reader should say it.
//
// On screen the whole part is grouped in threes by a narrow no-break space
// ("12 345.5"), which reads well and never wraps; a voice is likely to say
// it as two numbers. So the figure on screen is hidden from assistive
// technology, and a plain one (no grouping) is said instead. Masked amounts
// show dots and are said as "hidden", not as a row of bullets.

import { formatNau, showNau } from '../app/AppContext';

/** An amount for a label that is read aloud: plain digits, or "hidden". */
export function speakNau(nau: bigint, hidden = false): string {
  return hidden ? 'hidden' : formatNau(nau);
}

/**
 * A figure shown as a value (the balance, a History row, a receipt): the
 * whole part, then its decimals a step quieter. Inside a sentence an amount
 * stays plain.
 */
export function Figure({ text }: { text: string }) {
  const dot = text.indexOf('.');
  if (dot < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, dot)}
      <span className="vault-dec">{text.slice(dot)}</span>
    </>
  );
}

export function Amount({ nau, hidden = false, unit = true, sign, figure = false }: { nau: bigint; hidden?: boolean; unit?: boolean; sign?: '+' | '−'; figure?: boolean }) {
  const shown = `${sign ?? ''}${hidden ? '••••' : showNau(nau)}`;
  const spoken = `${sign === '+' ? 'plus ' : sign === '−' ? 'minus ' : ''}${speakNau(nau, hidden)}${unit ? ' NPT' : ''}`;
  return (
    <>
      <span aria-hidden>
        {figure ? <Figure text={shown} /> : shown}
        {unit && (
          <>
            {' '}
            <span className="vault-unit">NPT</span>
          </>
        )}
      </span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}
