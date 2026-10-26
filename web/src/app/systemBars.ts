// The Android app draws under the phone's status and navigation bars, and
// Android's web view gives env(safe-area-inset-*) as 0 or wrongly before
// version 140. So the shell measures the bars (app_insets) and the page
// keeps them on the root as --v-inset-*, and global.css takes the larger of
// the two on each side. A browser draws nothing under them, and asks nothing.

import { ANDROID } from './platform';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function measure(): void {
  void import('../backend/native/appClient')
    .then(({ insets }) => insets())
    .then((sizes) => {
      for (const side of SIDES) document.documentElement.style.setProperty(`--v-inset-${side}`, `${sizes[side]}px`);
    })
    .catch((e) => console.warn('system bars', (e as Error).message));
}

/** Keeps the page clear of the system bars in the Android app: from the start, and again whenever the window turns or comes back. */
export function followSystemBars(): void {
  if (!ANDROID) return;
  measure();
  addEventListener('resize', measure);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') measure();
  });
}
