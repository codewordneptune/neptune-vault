// Keeping the screen on for as long as something needs it.
//
// The browser lets a screen wake lock go whenever the page is hidden, even
// for a moment (a notification pulled down, a glance at another app), and
// does not give it back: it has to be asked for again each time the page
// returns. Asked for once, a lock quietly lapses, the screen dims, the
// phone locks, and a locked phone suspends the page. So this asks again on
// every return, and says when the browser refuses outright (battery saver,
// or no support), which is worth telling the person rather than guessing.

import { useEffect, useState } from 'react';

export type WakeLockState = 'off' | 'held' | 'refused';

export function useScreenWakeLock(active: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>('off');

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.wakeLock) {
      setState('refused');
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let ended = false;
    const hold = async () => {
      if (ended || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const got = await navigator.wakeLock.request('screen');
        if (ended) {
          void got.release().catch(() => undefined);
          return;
        }
        lock = got;
        setState('held');
      } catch {
        setState('refused');
      }
    };
    void hold();
    document.addEventListener('visibilitychange', hold);
    return () => {
      ended = true;
      document.removeEventListener('visibilitychange', hold);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);

  return state;
}
