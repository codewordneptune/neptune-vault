// Back, Android's or the browser's, closes the sheet on top rather than
// leaving the screen under it. An open sheet adds a history entry of its
// own: a copy of the screen's entry, so the router sees no change, marked
// with the sheets open. Back pops it, and every sheet whose mark is gone
// closes. A sheet closed any other way (its cross, Escape, a choice in it)
// takes its entry back out, unless a navigation from it replaced the entry.

import { useEffect, useRef } from 'react';

const KEY = 'vaultSheets';

/** The part of `window.history` this uses. */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
}

function marks(state: unknown): number[] {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

export function sheetHistory(history: HistoryLike) {
  let lastId = 0;
  // The sheets whose entries are in place, oldest first, as the current entry marks them.
  const stack: number[] = [];
  const closers = new Map<number, () => void>();
  // Popstates from this module's own steps back, which close nothing.
  let ownSteps = 0;
  const step = (delta: number) => {
    ownSteps += 1;
    history.go(delta);
  };
  return {
    /** A sheet opened: its entry goes on; `close` runs if Back takes it off. */
    open(close: () => void): number {
      lastId += 1;
      const id = lastId;
      const state = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...state, [KEY]: [...stack, id] }, '');
      stack.push(id);
      closers.set(id, close);
      return id;
    },
    /** A sheet closed some other way: its entry, and any above it, come off. */
    release(id: number): void {
      closers.delete(id);
      const at = stack.indexOf(id);
      if (at < 0) return;
      const steps = stack.length - at;
      stack.splice(at);
      if (marks(history.state).includes(id)) step(-steps);
    },
    /** For each popstate: the sheets whose marks are gone close, the newest first. */
    popped(): void {
      if (ownSteps > 0) {
        ownSteps -= 1;
        return;
      }
      const now = marks(history.state);
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const id = stack[i];
        if (now.includes(id)) continue;
        stack.splice(i, 1);
        const close = closers.get(id);
        closers.delete(id);
        close?.();
      }
    },
    /** At start: an entry a reload left with no sheet open is stepped back over. */
    tidy(): void {
      const stale = marks(history.state).length;
      if (stale > 0) step(-stale);
    },
  };
}

// Set up as the app loads, before the router reads the first entry.
const shared = typeof window === 'undefined' ? null : startSheets();
function startSheets(): ReturnType<typeof sheetHistory> {
  const made = sheetHistory(window.history);
  made.tidy();
  window.addEventListener('popstate', () => made.popped());
  return made;
}

/**
 * While `opened`, Back calls `onClose` instead of leaving the screen. The
 * entry comes off a moment after closing, so a sheet that closes and opens
 * again at once (React's double run in development included) keeps it.
 */
export function useBackCloses(opened: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  const entry = useRef<{ id: number; leaving: ReturnType<typeof setTimeout> | null } | null>(null);
  useEffect(() => {
    if (!opened || !shared) return;
    const sheets = shared;
    const kept = entry.current;
    if (kept?.leaving != null) {
      clearTimeout(kept.leaving);
      kept.leaving = null;
    } else {
      entry.current = { id: sheets.open(() => close.current()), leaving: null };
    }
    const mine = entry.current!;
    return () => {
      mine.leaving = setTimeout(() => {
        if (entry.current === mine) entry.current = null;
        sheets.release(mine.id);
      }, 0);
    };
  }, [opened]);
}
