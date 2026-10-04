// While a seed phrase is shown or typed, the Android app keeps its window
// out of screenshots, screen recordings and the recent-apps preview
// (FLAG_SECURE, set by the shell). Only then: the rest of the app can be
// captured, to show someone a problem. A browser has no such switch.

import { useEffect } from 'react';

import { ANDROID } from './platform';

// How many components showing a phrase are on screen: the window is
// protected from the first until the last one goes.
let showing = 0;

function protect(on: boolean): void {
  void import('../backend/native/appClient')
    .then(({ secureScreen }) => secureScreen(on))
    .catch((e) => console.warn('secure screen', (e as Error).message));
}

/** Keeps the screen out of captures while the calling component is on it. */
export function useSecureScreen(): void {
  useEffect(() => {
    if (!ANDROID) return;
    if (showing++ === 0) protect(true);
    return () => {
      if (--showing === 0) protect(false);
    };
  }, []);
}
