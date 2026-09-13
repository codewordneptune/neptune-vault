import { Anchor, Container, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactElement } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { useApp } from './app/AppContext';
import { Diagnostics } from './screens/Diagnostics';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Receive } from './screens/Receive';
import { Send } from './screens/Send';
import { Settings } from './screens/Settings';
import { Unlock } from './screens/Unlock';

export function App() {
  const { account, locked, services } = useApp();
  const location = useLocation();

  // Any interaction postpones the idle lock (R11).
  const touch = () => services.accounts.touch();

  const gate = (element: ReactElement) => {
    if (!account) return <Navigate to="/onboarding" replace />;
    if (locked) return <Unlock />;
    return element;
  };

  return (
    <Container size="xs" py="md" onClick={touch} onKeyDown={touch}>
      <Stack gap="md">
        <Group justify="space-between" align="baseline">
          <Title order={2}>Neptune Vault</Title>
          <Text size="xs" c="dimmed">
            {services.settings.network}
          </Text>
        </Group>
        <Routes>
          <Route path="/onboarding" element={account && !locked && location.pathname === '/onboarding' ? <Navigate to="/" replace /> : <Onboarding />} />
          <Route path="/" element={gate(<Home />)} />
          <Route path="/receive" element={gate(<Receive />)} />
          <Route path="/send" element={gate(<Send />)} />
          <Route path="/settings" element={gate(<Settings />)} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {account && !locked && (
          <Group justify="space-around" pt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {[
              ['/', 'Home'],
              ['/receive', 'Receive'],
              ['/send', 'Send'],
              ['/settings', 'Settings'],
            ].map(([to, label]) => (
              <Anchor component={NavLink} to={to} key={to} size="sm" fw={location.pathname === to ? 700 : 400}>
                {label}
              </Anchor>
            ))}
          </Group>
        )}
      </Stack>
    </Container>
  );
}
