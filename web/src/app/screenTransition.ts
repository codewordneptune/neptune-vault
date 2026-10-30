// A change of screen glides: the old screen fades out and the new one rises
// into place (global.css, ::view-transition-*), while the header and the tab
// bar stay put. The screens are drawn from the location this returns, which
// trails the router's by the moment the browser needs to picture the old
// screen; the new one then comes in synchronously, inside the transition.
// Without view transitions in the browser, with reduced motion asked for, or
// within one screen (a hash, a query, state), it is the router's location
// at once. The move is named on the root element while it runs, for
// global.css: going deeper and coming back move sideways, so the way the
// person went shows, and within Settings on a wide window only the open page
// changes. A swipe back the browser has already animated is left to it, or
// the screen would move twice.

import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Location } from 'react-router-dom';

import { SETTINGS_SPLIT } from './layout';

type Move = 'screen' | 'pane' | 'deeper' | 'back' | 'fade';

function moveOf(from: string, to: string): Move {
  const [fromTop, ...fromRest] = from.split('/').filter(Boolean);
  const [toTop, ...toRest] = to.split('/').filter(Boolean);
  if (fromTop !== toTop) return 'screen';
  if (fromTop === 'settings' && window.matchMedia(SETTINGS_SPLIT).matches) return 'pane';
  if (toRest.length === fromRest.length) return 'screen';
  return toRest.length > fromRest.length ? 'deeper' : 'back';
}

let browserMoved = false;
window.addEventListener('popstate', (e) => {
  browserMoved = 'hasUAVisualTransition' in e && e.hasUAVisualTransition === true;
});

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

const canMove = () => typeof document.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A change over the whole window, such as the theme, as a cross-fade. */
export function crossFade(change: () => void): void {
  if (canMove()) moveTo('fade', change);
  else change();
}

export function useScreenTransition(location: Location): Location {
  const [shown, setShown] = useState(location);
  useLayoutEffect(() => {
    if (location === shown) return;
    const show = () => setShown(location);
    const glide =
      location.pathname !== shown.pathname &&
      !browserMoved &&
      canMove();
    browserMoved = false;
    if (glide) moveTo(moveOf(shown.pathname, location.pathname), show);
    else show();
    // shown is what the transition starts from, not a reason to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  return shown;
}
