import { Box, Container, Group, Loader } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconHome, IconSettings } from '@tabler/icons-react';
import { useEffect, type ReactElement } from 'react';
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

export function App() {
  const { ready, account, locked, services } = useApp();
  // A new screen starts at its top; the router alone keeps the old scroll position.
  const { pathname, search } = useLocation();
  // Onboarding is closed once a wallet exists, except to add another.
  const addingWallet = new URLSearchParams(search).has('add');
  useEffect(() => {
    window.scrollTo(0, 0);
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

  // Any interaction postpones the idle lock (R11).
  const touch = () => services.accounts.touch();

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
            {/* The desktop app's title bar already names it: the header keeps the mark. */}
            <h1 className="vault-brand">
              <Logo size={26} />
              <span className={NATIVE ? 'sr-only' : undefined}>Neptune Vault</span>
            </h1>
            <NetworkMenu />
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
              {TABS.map(({ to, label, Icon }) => (
                <NavLink key={to} to={to} end className={({ isActive }) => `vault-tab${isActive ? ' active' : ''}`}>
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
