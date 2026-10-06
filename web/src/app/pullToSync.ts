// A pull down from the top of Home syncs, as phone apps refresh (Home.tsx,
// in the Android and iOS apps). A mark follows the finger at half its
// travel; let go once it is full, and the wallet syncs.

import { useEffect, useRef, useState } from 'react';

/** How far the mark travels before a release syncs, and the most it travels. */
export const PULL_READY_PX = 60;
const PULL_MOST_PX = 90;

/** How far the page is pulled now (0 at rest), and whether letting go would sync. */
export function usePullToSync(enabled: boolean, onPull: () => void): { pulled: number; ready: boolean } {
  const [pulled, setPulled] = useState(0);
  const latest = useRef(onPull);
  useEffect(() => {
    latest.current = onPull;
  });
  useEffect(() => {
    if (!enabled) return;
    let from: number | null = null;
    let now = 0;
    // Only a pull that starts with the page at its top, one finger, and no sheet open.
    const start = (e: TouchEvent) => {
      from = window.scrollY <= 0 && e.touches.length === 1 && !document.querySelector('[role="dialog"]') ? e.touches[0].clientY : null;
      now = 0;
    };
    const move = (e: TouchEvent) => {
      if (from === null) return;
      const travel = e.touches[0].clientY - from;
      now = travel > 0 && window.scrollY <= 0 ? Math.min(PULL_MOST_PX, travel / 2) : 0;
      setPulled(now);
    };
    const cancel = () => {
      from = null;
      now = 0;
      setPulled(0);
    };
    const end = () => {
      if (from !== null && now >= PULL_READY_PX) latest.current();
      cancel();
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', cancel);
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
    };
  }, [enabled]);
  return { pulled, ready: pulled >= PULL_READY_PX };
}
