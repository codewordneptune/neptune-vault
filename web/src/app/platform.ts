// Where the app runs, for the few places where that changes what it says or
// does. The interface is the same everywhere; only a native shell has no
// browser around it, keeps its data in its own folder, and has a window.

import { isNative } from '../backend';

/** True inside the desktop (or, later, mobile) app, false in a browser. */
export const NATIVE = isNative();

/**
 * Desktop behaviour for the native app: links open in the system's browser,
 * the web view's own reload, print and context menu stay out of the way,
 * and the interface's chrome is not selectable text. Called once at start.
 */
export function installNativeBehaviour(): void {
  if (!NATIVE) return;
  document.documentElement.classList.add('vault-native');

  // A link that would open a new window (or leave the app) opens in the
  // system's browser instead; the shell only allows the project's pages.
  const openOutside = (href: string) => {
    void import('../backend/native/appClient').then(({ openUrl }) => openUrl(href)).catch((e) => console.warn('link', (e as Error).message));
  };
  document.addEventListener(
    'click',
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin && anchor.target !== '_blank') return;
      event.preventDefault();
      if (url.protocol === 'https:') openOutside(url.href);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    if (url) openOutside(String(url));
    return null;
  }) as typeof window.open;

  // Reloading would lock the wallet and lose the screen, and printing a
  // wallet is never meant; neither has a place in an app window.
  window.addEventListener(
    'keydown',
    (event) => {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (key === 'f5' || (mod && (key === 'r' || key === 'p'))) event.preventDefault();
    },
    true,
  );

  // A file dropped anywhere but a drop area would be opened by the web
  // view in place of the app. Drop areas handle theirs before this.
  const refuseDrop = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  };
  window.addEventListener('dragover', refuseDrop);
  window.addEventListener('drop', refuseDrop);

  // The web view's own menu (Back, Refresh, Print) is kept for where it
  // helps: in a field, and over selected text.
  document.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null;
    const editable = target?.closest?.('input, textarea, [contenteditable="true"]');
    const selected = (window.getSelection()?.toString() ?? '') !== '';
    if (!editable && !selected) event.preventDefault();
  });
}
