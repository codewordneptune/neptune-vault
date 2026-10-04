import { Box, Button, Container, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconHome, IconSettings } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { Sheet } from './components/Sheet';
import { useApp } from './app/AppContext';
import { DESKTOP, MOBILE, NATIVE } from './app/platform';
import { DesktopUpdateNotice } from './components/DesktopUpdateNotice';
import { Logo } from './components/Logo';
import { NetworkMenu } from './components/NetworkMenu';
import { PocTag } from './components/PocNotice';
import { SendStrip } from './components/SendStrip';
import { UpdateStrip } from './components/UpdateStrip';
import { ReportProblemScreen } from './screens/Diagnostics';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Privacy } from './screens/Privacy';
import { Receive } from './screens/Receive';
import { Send } from './screens/Send';
import { Settings } from './screens/Settings';
import { Unlock } from './screens/Unlock';

const TABS = [
  { to: '/', label: 'Home', Icon: IconHome },
  { to: '/send', label: 'Send', Icon: IconArrowUpRight },
  { to: '/receive', label: 'Receive', Icon: IconArrowDownLeft },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

const SCREEN_NAMES: Record<string, string> = {
  '/': 'Home',
  '/send': 'Send',
  '/receive': 'Receive',
  '/settings': 'Settings',
  '/diagnostics': 'Report a problem',
  '/privacy': 'Privacy statement',
  '/onboarding': 'Set up',
};

/** The screen a path shows, for the page title; null for a path about to be redirected. */
function screenName(pathname: string, hasWallet: boolean, locked: boolean): string | null {
  // Privacy is open to all; every other screen of a wallet waits behind the lock.
  if (pathname === '/privacy') return SCREEN_NAMES[pathname];
  if (hasWallet && locked) return 'Locked';
  // With no wallet, only setup and the device facts are shown; the rest redirect.
  if (!hasWallet && pathname !== '/onboarding' && pathname !== '/diagnostics') return null;
  // Settings' pages share its name: the page's own heading says which one.
  if (pathname.startsWith('/settings/')) return SCREEN_NAMES['/settings'];
  return SCREEN_NAMES[pathname] ?? null;
}

/**
 * The desktop app's shortcut for a tab, in its tooltip and for assistive
 * technology, so the shortcuts below are not a secret. Cmd on a Mac.
 */
function shortcutProps(label: string, digit: number): { title: string; 'aria-keyshortcuts': string } {
  const mac = /Mac/i.test(navigator.userAgent);
  return { title: `${label} (${mac ? 'Cmd' : 'Ctrl'}+${digit})`, 'aria-keyshortcuts': `${mac ? 'Meta' : 'Control'}+${digit}` };
}

export function App() {
  const { ready, account, locked, services } = useApp();
  // A new screen starts at its top; the router alone keeps the old scroll position.
  const { pathname, search } = useLocation();
  // Onboarding is closed once a wallet exists, except to add another.
  const addingWallet = new URLSearchParams(search).has('add');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  // The title names the screen, so a tab, the window list and a screen
  // reader all say where the app is, not only "Neptune Vault".
  const hasWallet = Boolean(account);
  useEffect(() => {
    const name = screenName(pathname, hasWallet, locked);
    document.title = name ? `${name} · Neptune Vault` : 'Neptune Vault';
  }, [pathname, hasWallet, locked]);

  // A new screen takes focus at its heading (every screen has an h2, some
  // visually hidden), so a keyboard or screen-reader user starts there and
  // hears where they are, instead of on the page's body. Not on the first
  // load, or on redirects before the person has done anything, where the
  // browser's own start is right; and not when the screen has focused a
  // field of its own (the lock screen's password).
  const interacted = useRef(false);
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (!interacted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.closest('main')) return;
    // A screen that moves focus itself (a result on Send, a card reached by
    // a link such as /settings/advanced#rescan) is left to it: two moves in a row
    // cut off what the first one started to read out.
    if (window.location.hash || document.querySelector('main [data-focus-managed]')) return;
    const heading = document.querySelector<HTMLElement>('main h2');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [pathname]);

  // Unlocking keeps the screen's path, and the password field that had the
  // focus is gone: the screen's heading takes it, as after a change of screen.
  const wasLocked = useRef(locked);
  useEffect(() => {
    const unlocked = wasLocked.current && !locked;
    wasLocked.current = locked;
    if (!unlocked) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const heading = document.querySelector<HTMLElement>('main h2');
      if (!heading) return;
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [locked]);

  // Whether this device has a wallet on any network: the header's menu is
  // the way back from a network without one.
  const [anyWallet, setAnyWallet] = useState(false);
  useEffect(() => {
    void services.db.count('accounts').then((n) => setAnyWallet(n > 0), () => undefined);
  }, [services, account]);

  // Keyboard shortcuts, in the desktop app only: in a browser these keys
  // belong to the browser (Ctrl+L is its address bar, Ctrl+1 its first tab).
  // Ctrl or Cmd with L locks; with 1 to 4 opens a tab; with N starts a send.
  const navigate = useNavigate();
  const open = Boolean(account) && !locked;
  useEffect(() => {
    if (!DESKTOP) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // Pressed with focus on the page's body, outside the shell's handlers.
      interacted.current = true;
      const key = event.key.toLowerCase();
      if (key === 'l' && open) {
        event.preventDefault();
        // During a send, once the send is done with the keys: a lock now would end it without a word.
        services.accounts.lockWhenFree();
      } else if (key === 'n' && open) {
        event.preventDefault();
        // A new send: an empty form, not the half-filled one of before.
        navigate('/send', { state: { fresh: true } });
      } else if (/^[1-4]$/.test(key) && open) {
        event.preventDefault();
        navigate(TABS[Number(key) - 1].to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, services, navigate]);

  // In the phone app, a payment link tapped in another app or on a web page
  // opens Send, filled in from it (app/paymentLinks.ts). A locked wallet asks
  // for its password first; with no wallet, setup comes first and the link
  // is let go. Loaded only there: the web app never gets these links.
  useEffect(() => {
    if (!MOBILE) return;
    let gone = false;
    let stop: (() => void) | undefined;
    void import('./app/paymentLinks').then(({ onPaymentLinks }) => {
      if (!gone) stop = onPaymentLinks((link) => navigate('/send', { state: { link } }));
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [navigate]);

  // Anything the person does postpones the idle lock: not only a click or a
  // key, but a touch, scrolling, typing, and focus moving on (a screen
  // reader reading). At most once a second. While the warning before the
  // lock is showing, focus moving into it is the app, not the person.
  const warningOpen = useRef(false);
  useEffect(() => {
    let last = 0;
    const onActivity = (event: Event) => {
      if (event.type === 'focusin' && warningOpen.current) return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      services.accounts.touch();
    };
    const kinds = ['pointerdown', 'keydown', 'focusin', 'input', 'wheel', 'scroll', 'touchstart'];
    for (const kind of kinds) window.addEventListener(kind, onActivity, { capture: true, passive: true });
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, onActivity, { capture: true });
    };
  }, [services]);

  // Do not route until the stored account has been looked up, or a reload
  // would bounce an existing account to onboarding.
  if (!ready) return <Loader className="vault-starting" role="status" aria-label="Starting" />;

  // Any interaction postpones the idle lock, and from the first one on a
  // change of screen moves focus to its heading.
  const touch = () => {
    interacted.current = true;
    services.accounts.touch();
  };

  const gate = (element: ReactElement) => {
    if (!account) return <Navigate to="/onboarding" replace />;
    if (locked) return <Unlock />;
    return element;
  };

  // Setup, adding a wallet included, keeps the whole screen: a tab would
  // leave it and drop what was typed. Cancel and Back are the way out.
  const showTabs = Boolean(account) && !locked && pathname !== '/onboarding';

  return (
    <Box onClick={touch} onKeyDown={touch} className={showTabs ? 'vault-shell has-tabs' : 'vault-shell'}>
      {/* The navigation comes after the screen in the page, so a keyboard
          reaches it last: this link, first of all and shown when focused,
          goes straight there. */}
      {showTabs && (
        <a
          href="#main-nav"
          className="vault-skip"
          onClick={(e) => {
            e.preventDefault();
            document.querySelector<HTMLElement>('#main-nav a')?.focus();
          }}
        >
          Skip to navigation
        </a>
      )}
      <header className={account && locked ? 'vault-topbar vault-topbar-locked' : 'vault-topbar'}>
        <Container size="xs" className="vault-topbar-inner">
          <Group justify="space-between" align="center">
            {/* The desktop app's title bar already names it: the header keeps
                the mark. On a narrow phone the name gives way too, to leave
                the wallet pill room (global.css, .vault-wordmark), except on
                the lock screen, which has no pill. */}
            <Group gap={6} wrap="nowrap">
              <h1 className="vault-brand">
                <Logo size={26} />
                <span className={DESKTOP ? 'sr-only' : 'vault-wordmark'}>Neptune Vault</span>
              </h1>
              {/* The early-version warning, on every screen: setup also shows it in full. */}
              <PocTag />
            </Group>
            {/* Until a wallet exists the header is the brand and its tag: setup keeps
                the network question out of a newcomer's way, and the header
                should not ask it either. Once one does, on any network, the
                menu stays: it is the way back from a network without one. */}
            {/* While locked the lock screen says which wallet it is, and offers
                the others itself: the menu would only say it again, and its
                Add a wallet would lead back to the lock. */}
            {(account || anyWallet) && !(account && locked) && <NetworkMenu />}
          </Group>
        </Container>
      </header>
      {/* Updates: the web app's own, the desktop app's releases on GitHub; a
          phone app is updated by installing its next build. */}
      {DESKTOP ? <DesktopUpdateNotice /> : !NATIVE ? <UpdateStrip /> : null}
      <SendStrip />
      {/* On a wide screen every screen shares one width, so moving between
          them does not make the content jump; Home's balance becomes a band. */}
      <Container component="main" size="xs" py="md" className={!locked && account && pathname === '/' ? 'vault-main vault-main-home' : !locked && account && pathname.startsWith('/settings') ? 'vault-main vault-main-settings' : 'vault-main'}>
        <Routes>
          {/* Adding a wallet is for whoever can unlock the one that is there: a locked app offers nothing else. */}
          <Route path="/onboarding" element={account && !addingWallet ? <Navigate to="/" replace /> : account && locked ? <Unlock /> : <Onboarding />} />
          <Route path="/" element={gate(<Home />)} />
          <Route path="/receive" element={gate(<Receive />)} />
          <Route path="/send" element={gate(<Send />)} />
          {/* Contacts is a page of Settings; the old address still leads there. */}
          <Route path="/contacts" element={gate(<Navigate to="/settings/contacts" replace />)} />
          <Route path="/settings" element={gate(<Settings />)} />
          <Route path="/settings/:section" element={gate(<Settings />)} />
          {/* Behind the lock when there is a wallet to lock: the page tells when
              a send was last tried and, if it failed, which node was asked and
              what it said. With no wallet yet it stays open, since a person who
              cannot get started needs the device facts to report why. */}
          <Route path="/diagnostics" element={account && locked ? <Unlock /> : <ReportProblemScreen />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
      {showTabs && (
        <nav className="vault-tabbar" aria-label="Main" id="main-nav">
          <Container size="xs" px={0} className="vault-tabbar-inner">
            <Group gap={0} wrap="nowrap" className="vault-tabs">
              {TABS.map(({ to, label, Icon }, i) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `vault-tab${isActive ? ' active' : ''}`} {...(DESKTOP ? shortcutProps(label, i + 1) : {})}>
                  <Icon size={20} />
                  {label}
                </NavLink>
              ))}
            </Group>
          </Container>
        </nav>
      )}
      {showTabs && <IdleWarning onOpen={(open) => (warningOpen.current = open)} />}
      <CloseGuard />
    </Box>
  );
}

/**
 * Before the idle lock: a warning that it is coming, and a way to stay
 * unlocked. Reading, or writing a seed phrase down by hand, looks idle to
 * the app, and a lock without warning takes the screen away mid-way.
 */
function IdleWarning({ onOpen }: { onOpen: (open: boolean) => void }) {
  const { services } = useApp();
  const [deadline, setDeadline] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(
    () =>
      services.accounts.onIdleWarning((left) => {
        setDeadline((current) => (left === null ? null : (current ?? Date.now() + left)));
      }),
    [services],
  );
  useEffect(() => {
    onOpen(deadline !== null);
    if (deadline === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [deadline, onOpen]);
  const seconds = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const stay = () => services.accounts.touch();
  return (
    <Sheet opened={deadline !== null} onClose={stay} title="The wallet is about to lock" withCloseButton={false}>
      <Stack>
        <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          Nothing has happened here for a while, so the wallet locks in {seconds} {seconds === 1 ? 'second' : 'seconds'}.
        </Text>
        <Button onClick={stay} data-autofocus>
          Stay unlocked
        </Button>
      </Stack>
    </Sheet>
  );
}

/**
 * Closing the app or the tab while a send runs: asked first. Before the
 * send reaches the node, closing stops it and nothing is sent; while it is
 * handed over, the next unlock says how it ended.
 */
function CloseGuard() {
  const { sendJob } = useApp();
  const running = Boolean(sendJob && !sendJob.done);
  const handing = sendJob?.progress.stage === 'submitting';
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    // A phone app has no window to close: swiped away, it is gone, as a tab is.
    if (!running || MOBILE) return;
    if (!NATIVE) {
      // The browser asks, in its own words; the page cannot choose them.
      const onLeave = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', onLeave);
      return () => window.removeEventListener('beforeunload', onLeave);
    }
    let unlisten: (() => void) | null = null;
    let done = false;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested((event) => {
          event.preventDefault();
          setAsking(true);
        }),
      )
      .then((stop) => {
        if (done) stop();
        else unlisten = stop;
      }, () => undefined);
    return () => {
      done = true;
      unlisten?.();
    };
  }, [running]);
  const closeAnyway = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().destroy();
  };
  return (
    <Sheet opened={asking && running} onClose={() => setAsking(false)} title="Close while sending?">
      <Stack>
        <Text size="sm">
          {handing
            ? 'The send is being handed to the node right now. If you close the app, the next unlock says whether it went out.'
            : 'A send is being prepared. Closing now stops it, and nothing has been sent yet.'}
        </Text>
        <Group grow>
          <Button variant="default" onClick={() => setAsking(false)} data-autofocus>
            Keep sending
          </Button>
          <Button color="red" onClick={() => void closeAnyway()}>
            Close anyway
          </Button>
        </Group>
      </Stack>
    </Sheet>
  );
}
