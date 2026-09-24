import { Box, Container, Group, Loader } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconHome, IconSettings } from '@tabler/icons-react';
import { useEffect, useRef, type ReactElement } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { useApp } from './app/AppContext';
import { NATIVE } from './app/platform';
import { DesktopUpdateNotice } from './components/DesktopUpdateNotice';
import { Logo } from './components/Logo';
import { NetworkMenu } from './components/NetworkMenu';
import { SendStrip } from './components/SendStrip';
import { UpdateStrip } from './components/UpdateStrip';
import { Contacts } from './screens/Contacts';
import { Diagnostics } from './screens/Diagnostics';
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
  '/contacts': 'Contacts',
  '/diagnostics': 'Diagnostics',
  '/privacy': 'Privacy',
  '/onboarding': 'Set up',
};

/** The screen a path shows, for the page title; null for a path about to be redirected. */
function screenName(pathname: string, hasWallet: boolean, locked: boolean): string | null {
  // Privacy is open to all; every other screen of a wallet waits behind the lock.
  if (pathname === '/privacy') return SCREEN_NAMES[pathname];
  if (hasWallet && locked) return 'Locked';
  // With no wallet, only setup and the device facts are shown; the rest redirect.
  if (!hasWallet && pathname !== '/onboarding' && pathname !== '/diagnostics') return null;
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
    const heading = document.querySelector<HTMLElement>('main h2');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [pathname]);

  // Keyboard shortcuts, in the desktop app only: in a browser these keys
  // belong to the browser (Ctrl+L is its address bar, Ctrl+1 its first tab).
  // Ctrl or Cmd with L locks; with 1 to 4 opens a tab; with N starts a send.
  const navigate = useNavigate();
  const open = Boolean(account) && !locked;
  useEffect(() => {
    if (!NATIVE) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // Pressed with focus on the page's body, outside the shell's handlers.
      interacted.current = true;
      const key = event.key.toLowerCase();
      if (key === 'l' && open) {
        event.preventDefault();
        void services.accounts.lock();
      } else if (key === 'n' && open) {
        event.preventDefault();
        navigate('/send');
      } else if (/^[1-4]$/.test(key) && open) {
        event.preventDefault();
        navigate(TABS[Number(key) - 1].to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, services, navigate]);

  // Do not route until the stored account has been looked up, or a reload
  // would bounce an existing account to onboarding.
  if (!ready) return <Loader className="vault-starting" aria-label="Starting" />;

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

  const showTabs = Boolean(account) && !locked;

  return (
    <Box onClick={touch} onKeyDown={touch} className={showTabs ? 'vault-shell has-tabs' : 'vault-shell'}>
      <header className="vault-topbar">
        <Container size="xs" py="sm" className="vault-topbar-inner">
          <Group justify="space-between" align="center">
            {/* The desktop app's title bar already names it: the header keeps
                the mark. On a narrow phone the name gives way too, to leave
                the wallet pill room (global.css, .vault-wordmark). */}
            <h1 className="vault-brand">
              <Logo size={26} />
              <span className={NATIVE ? 'sr-only' : 'vault-wordmark'}>Neptune Vault</span>
            </h1>
            {/* Until a wallet exists the header is the brand alone: setup keeps
                the network question out of a newcomer's way, and the header
                should not ask it either. */}
            {account && <NetworkMenu />}
          </Group>
        </Container>
      </header>
      {NATIVE ? <DesktopUpdateNotice /> : <UpdateStrip />}
      <SendStrip />
      {/* On a wide screen every screen shares one width, so moving between
          them does not make the content jump; Home's balance becomes a band. */}
      <Container component="main" size="xs" py="md" className={pathname === '/' && !locked && account ? 'vault-main vault-main-home' : 'vault-main'}>
        <Routes>
          {/* Adding a wallet is for whoever can unlock the one that is there: a locked app offers nothing else. */}
          <Route path="/onboarding" element={account && !addingWallet ? <Navigate to="/" replace /> : account && locked ? <Unlock /> : <Onboarding />} />
          <Route path="/" element={gate(<Home />)} />
          <Route path="/receive" element={gate(<Receive />)} />
          <Route path="/send" element={gate(<Send />)} />
          <Route path="/contacts" element={gate(<Contacts />)} />
          <Route path="/settings" element={gate(<Settings />)} />
          {/* Behind the lock when there is a wallet to lock: the page tells when
              a send was last tried and, if it failed, which node was asked and
              what it said. With no wallet yet it stays open, since a person who
              cannot get started needs the device facts to report why. */}
          <Route path="/diagnostics" element={account && locked ? <Unlock /> : <Diagnostics />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
      {showTabs && (
        <nav className="vault-tabbar" aria-label="Main">
          <Container size="xs" px={0} className="vault-tabbar-inner">
            <Group gap={0} wrap="nowrap" className="vault-tabs">
              {TABS.map(({ to, label, Icon }, i) => (
                <NavLink key={to} to={to} end className={({ isActive }) => `vault-tab${isActive ? ' active' : ''}`} {...(NATIVE ? shortcutProps(label, i + 1) : {})}>
                  <Icon size={22} stroke={1.6} />
                  {label}
                </NavLink>
              ))}
            </Group>
          </Container>
        </nav>
      )}
    </Box>
  );
}
