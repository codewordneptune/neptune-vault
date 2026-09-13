import { Box, Container, Group, Loader } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconHome, IconSettings } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';

import { useApp } from './app/AppContext';
import { Logo } from './components/Logo';
import { NetworkMenu } from './components/NetworkMenu';
import { SendStrip } from './components/SendStrip';
import { Diagnostics } from './screens/Diagnostics';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Receive } from './screens/Receive';
import { Send } from './screens/Send';
import { Settings } from './screens/Settings';
import { Unlock } from './screens/Unlock';

const TABS = [
  { to: '/', label: 'Home', Icon: IconHome },
  { to: '/receive', label: 'Receive', Icon: IconArrowDownLeft },
  { to: '/send', label: 'Send', Icon: IconArrowUpRight },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

export function App() {
  const { ready, account, locked, services } = useApp();

  // Do not route until the stored account has been looked up, or a reload
  // would bounce an existing account to onboarding.
  if (!ready) return <Loader m="xl" />;

  // Any interaction postpones the idle lock (R11).
  const touch = () => services.accounts.touch();

  const gate = (element: ReactElement) => {
    if (!account) return <Navigate to="/onboarding" replace />;
    if (locked) return <Unlock />;
    return element;
  };

  const showTabs = Boolean(account) && !locked;

  return (
    <Box onClick={touch} onKeyDown={touch} pb={showTabs ? 84 : 0}>
      <header className="vault-topbar">
        <Container size="xs" py="sm">
          <Group justify="space-between" align="center">
            <h1 className="vault-brand">
              <Logo size={26} />
              Neptune Vault
            </h1>
            <NetworkMenu />
          </Group>
        </Container>
      </header>
      <SendStrip />
      <Container component="main" size="xs" py="md">
        <Routes>
          <Route path="/onboarding" element={account ? <Navigate to="/" replace /> : <Onboarding />} />
          <Route path="/" element={gate(<Home />)} />
          <Route path="/receive" element={gate(<Receive />)} />
          <Route path="/send" element={gate(<Send />)} />
          <Route path="/settings" element={gate(<Settings />)} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
      {showTabs && (
        <nav className="vault-tabbar" aria-label="Main">
          <Container size="xs" px={0}>
            <Group gap={0} wrap="nowrap">
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
