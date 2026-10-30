// A form whose parts come and go: what stays glides to its new place, what
// is new fades in and what has gone fades out where it stood, in place of
// everything jumping at once. It looks at the form after every render, so a
// field that opens or an error that appears needs no word of its own. Reads
// the layout's own positions (offsetTop), which a running glide does not
// disturb. With less motion asked for, nothing moves.

import { useLayoutEffect, useRef, type RefObject } from 'react';

const GLIDE_MS = 180;
const FADE_MS = 140;
// Quicker than what glides in over it.
const GONE_MS = 90;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

interface Place {
  top: number;
  left: number;
  width: number;
  parent: Element | null;
}

/** Everything in `root` matching `parts` glides; `frame`, the card around them, follows in height. */
export function useGlide(root: RefObject<HTMLElement | null>, frame: RefObject<HTMLElement | null>, parts: string): void {
  const places = useRef(new Map<HTMLElement, Place>());
  const height = useRef<number | null>(null);
  useLayoutEffect(() => {
    const form = root.current;
    // Out of the page, or hidden while a result shows: start afresh when it is back.
    if (!form || form.offsetParent === null) {
      places.current = new Map();
      height.current = null;
      return;
    }
    const before = places.current;
    const now = new Map<HTMLElement, Place>();
    for (const el of form.querySelectorAll<HTMLElement>(parts)) now.set(el, { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, parent: el.offsetParent });
    const box = frame.current?.offsetHeight ?? null;
    const still = before.size === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still) {
      for (const [el, place] of now) {
        const was = before.get(el);
        if (!was) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
        else if (was.parent === place.parent && was.top !== place.top) el.animate([{ transform: `translateY(${was.top - place.top}px)` }, { transform: 'none' }], { duration: GLIDE_MS, easing: EASE });
      }
      for (const [el, was] of before) {
        if (el.isConnected || !was.parent) continue;
        // Gone from the page: back for a moment, as a picture of itself, where it stood.
        el.inert = true;
        Object.assign(el.style, { position: 'absolute', top: `${was.top}px`, left: `${was.left}px`, width: `${was.width}px`, margin: '0', pointerEvents: 'none' });
        was.parent.append(el);
        void el
          .animate([{ opacity: 1 }, { opacity: 0 }], { duration: GONE_MS, easing: 'ease-out', fill: 'forwards' })
          .finished.catch(() => undefined)
          .finally(() => el.remove());
      }
      if (frame.current && box !== null && height.current !== null && box !== height.current) frame.current.animate([{ height: `${height.current}px` }, { height: `${box}px` }], { duration: GLIDE_MS, easing: EASE });
    }
    places.current = now;
    height.current = box;
  });
}
