// The balance counts to a new value, so that a change says what changed
// rather than only showing the result (Home.tsx).

import { useLayoutEffect, useRef, useState } from 'react';

import { NAU_PER_COIN, showNau } from './AppContext';

/** Most of a second, slowing as it lands. */
const COUNT_MS = 800;
/** The count starts once the value has held this long: a block's changes arrive in steps a few milliseconds apart, and a value between them would show as a dip. */
const SETTLE_MS = 150;

/** How many decimals the figure of an amount shows (showNau). */
export function decimalsOf(nau: bigint): number {
  const text = showNau(nau);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** The figure of an amount with exactly `decimals` decimals (at most 8), cut as showNau cuts: a figure counting to its value keeps one width. */
export function fixedNau(nau: bigint, decimals: number): string {
  const step = NAU_PER_COIN / 10n ** BigInt(decimals);
  const [whole, frac = ''] = showNau(nau - (nau % step)).split('.');
  return decimals === 0 ? whole : `${whole}.${frac.padEnd(decimals, '0')}`;
}

/**
 * The amount to show for `target`: after a change, the values between the
 * one shown and the new one, frame by frame, with `decimals` set so the
 * figure keeps its width (null once it has landed). The first value, one
 * in another `scope` (another wallet), and any while `still` (reduced
 * motion, hidden amounts) show at once.
 */
export function useCountUp(target: bigint | null, still: boolean, scope: string): { nau: bigint; decimals: number | null } | null {
  const [frame, setFrame] = useState<{ nau: bigint; decimals: number } | null>(null);
  const shown = useRef<{ nau: bigint; scope: string } | null>(null);
  // Before the screen is painted, so the new value never shows ahead of the count.
  useLayoutEffect(() => {
    const before = shown.current;
    if (target === null || still || before === null || before.scope !== scope || before.nau === target) {
      shown.current = target === null ? null : { nau: target, scope };
      setFrame(null);
      return;
    }
    const from = before.nau;
    const decimals = Math.max(decimalsOf(from), decimalsOf(target));
    const start = performance.now() + SETTLE_MS;
    setFrame({ nau: from, decimals: decimalsOf(from) });
    let raf = requestAnimationFrame(function step(now) {
      if (now < start) {
        raf = requestAnimationFrame(step);
        return;
      }
      const k = Math.min(1, (now - start) / COUNT_MS);
      const nau = k >= 1 ? target : from + ((target - from) * BigInt(Math.round((1 - (1 - k) ** 3) * 1e6))) / 1_000_000n;
      shown.current = { nau, scope };
      if (k >= 1) {
        setFrame(null);
      } else {
        setFrame({ nau, decimals });
        raf = requestAnimationFrame(step);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [target, still, scope]);
  if (target === null) return null;
  return frame ?? { nau: target, decimals: null };
}
