// A change of screen glides: the old screen fades out and the new one rises
// into place (global.css, ::view-transition-*), while the header and the tab
// bar stay put. The screens are drawn from the location this returns, which
// trails the router's by the moment the browser needs to picture the old
// screen; the new one then comes in synchronously, inside the transition.
// Without view transitions in the browser, with reduced motion asked for, or
// within one screen (a hash, a query, state), it is the router's location
// at once. The move is named on the root element while it runs, for
// global.css: within Settings on a wide window only the open page changes.

import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Location } from 'react-router-dom';

import { SETTINGS_SPLIT } from './layout';

type Move = 'screen' | 'pane';

function moveOf(from: string, to: string): Move {
  return from.startsWith('/settings') && to.startsWith('/settings') && window.matchMedia(SETTINGS_SPLIT).matches ? 'pane' : 'screen';
}

let running: ViewTransition | null = null;

/** Runs a change of what is on screen inside a view transition, named as `move`. */
function moveTo(move: Move, change: () => void): void {
  const root = document.documentElement;
  root.dataset.move = move;
  const transition = document.startViewTransition(() => flushSync(change));
  running = transition;
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (running === transition) delete root.dataset.move;
    });
}

export function useScreenTransition(location: Location): Location {
  const [shown, setShown] = useState(location);
  useLayoutEffect(() => {
    if (location === shown) return;
    const show = () => setShown(location);
    const glide =
      location.pathname !== shown.pathname &&
      typeof document.startViewTransition === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (glide) moveTo(moveOf(shown.pathname, location.pathname), show);
    else show();
    // shown is what the transition starts from, not a reason to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  return shown;
}
