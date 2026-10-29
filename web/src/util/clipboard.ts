// Copying, two ways. A Copy button answers on itself (useCopied): for a
// moment it reads "Copied" with a tick, where the eye already is, and a
// screen reader hears it. Copying from somewhere that is gone once pressed
// (a menu's item) or that is not a button (text copied by hand) confirms
// with a short toast (copyText).

import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';

// `failed` says what to do instead, where a screen has something better to
// offer than trying again (Receive shows only a shortened address, so
// long-pressing the text there would copy something that is not an address).
async function write(text: string, failed: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // What to do instead needs longer.
    notifications.show({ message: failed, color: 'red', autoClose: 10_000 });
    return false;
  }
}

const FAILED = 'Could not copy. Try again.';

export async function copyText(text: string, message = 'Copied', failed = FAILED): Promise<boolean> {
  const ok = await write(text, failed);
  // Long enough to be read, or heard, before it goes.
  if (ok) notifications.show({ message, color: 'green', autoClose: 4000 });
  return ok;
}

/** How long a Copy button reads "Copied". */
const COPIED_MS = 1500;

/**
 * A Copy button's state and its action: `copied` is true for a moment
 * after a copy, and `said` (such as "Address copied") is announced.
 */
export function useCopied(): [boolean, (text: string, said: string, failed?: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // The region is there before anything is said in it, or a screen reader may miss the first.
    region();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(async (text: string, said: string, failed = FAILED) => {
    if (!(await write(text, failed))) return;
    announce(said);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  return [copied, copy];
}

/** The region a screen reader hears copies confirmed in, added once. */
function region(): HTMLElement {
  let found = document.getElementById('vault-announce');
  if (!found) {
    found = document.createElement('div');
    found.id = 'vault-announce';
    found.className = 'sr-only';
    found.setAttribute('aria-live', 'polite');
    document.body.append(found);
  }
  return found;
}

/** Said politely to a screen reader; the same words twice are said twice. */
function announce(text: string): void {
  const r = region();
  r.textContent = '';
  setTimeout(() => (r.textContent = text), 50);
}
