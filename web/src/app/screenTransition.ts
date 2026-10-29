// A change of screen glides: the old screen fades out and the new one rises
// into place (global.css, ::view-transition-*), while the header and the tab
// bar stay put. The screens are drawn from the location this returns, which
// trails the router's by the moment the browser needs to picture the old
// screen; the new one then comes in synchronously, inside the transition.
// Without view transitions in the browser, with reduced motion asked for, or
// within one screen (a hash, a query, state), it is the router's location
// at once.

import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Location } from 'react-router-dom';

export function useScreenTransition(location: Location): Location {
  const [shown, setShown] = useState(location);
  useLayoutEffect(() => {
    if (location === shown) return;
    const show = () => setShown(location);
    const glide =
      location.pathname !== shown.pathname &&
      typeof document.startViewTransition === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (glide) document.startViewTransition(() => flushSync(show));
    else show();
    // shown is what the transition starts from, not a reason to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  return shown;
}
