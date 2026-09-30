// Payment links (neptunecash:) opened from other apps and web pages, in the
// phone app: the one that started the app, and each one that arrives while
// it runs (Tauri's deep-link plugin, shells/tauri). Each is handed on to be
// read as a scanned code is, into Send; nothing is sent until the person
// reviews it. A link is never logged: NIP-002 forbids it, since one can
// carry a key.

/** Where the links come from: the shell's deep-link plugin, or a stand-in in tests. */
export interface LinkSource {
  /** The links that started the app, or null. */
  current(): Promise<string[] | null>;
  /** Calls the handler with the links that arrive while the app runs; resolves to the way to stop. */
  onNew(handler: (urls: string[]) => void): Promise<() => void>;
}

/** Where the link that started the app is remembered, so a page that loads again does not open it twice. */
export type LinkMemory = Pick<Storage, 'getItem' | 'setItem'> | null;

const HANDLED = 'neptune-vault.handled-link';

const tauriLinks: LinkSource = {
  async current() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string[] | null>('plugin:deep-link|get_current');
  },
  async onNew(handler) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<string[]>('deep-link://new-url', (event) => handler(event.payload));
  },
};

function sessionMemory(): LinkMemory {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Calls `open` with each payment link the app is asked to open: the one it
 * started with (once), then each that arrives. Other links are ignored.
 * Returns the way to stop.
 */
export function onPaymentLinks(open: (link: string) => void, source: LinkSource = tauriLinks, memory: LinkMemory = sessionMemory()): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  const paymentLink = (urls: string[] | null | undefined) => urls?.find((url) => /^neptunecash:/i.test(url)) ?? null;
  const remember = (link: string) => {
    try {
      memory?.setItem(HANDLED, link);
    } catch {
      // Unremembered: a page that loads again may open it again, no more.
    }
  };
  const seen = (link: string) => {
    try {
      return memory?.getItem(HANDLED) === link;
    } catch {
      return false;
    }
  };
  void source.current().then(
    (urls) => {
      const link = paymentLink(urls);
      if (!link || stopped || seen(link)) return;
      remember(link);
      open(link);
    },
    () => undefined,
  );
  void source
    .onNew((urls) => {
      const link = paymentLink(urls);
      if (!link || stopped) return;
      remember(link);
      open(link);
    })
    .then(
      (stop) => {
        if (stopped) stop();
        else unlisten = stop;
      },
      () => undefined,
    );
  return () => {
    stopped = true;
    unlisten?.();
  };
}
