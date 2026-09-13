// Home-screen installation. Chromium fires `beforeinstallprompt` once the
// page qualifies; the event must be captured early and kept, then `prompt()`
// is called from a user gesture. Safari on iOS has no such event: the only
// route is the Share sheet, so the UI shows instructions there.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Listener = () => void;

let deferred: BeforeInstallPromptEvent | null = null;
let installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

/** Call once at start-up, before the browser decides the page qualifies. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export type InstallState = { kind: 'installed' } | { kind: 'promptable' } | { kind: 'ios-share' } | { kind: 'browser-menu' };

export function installState(): InstallState {
  if (installed) return { kind: 'installed' };
  if (deferred) return { kind: 'promptable' };
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return { kind: 'ios-share' };
  return { kind: 'browser-menu' };
}

/** Show the browser's install prompt; resolves to whether the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === 'accepted';
}

export function onInstallChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
