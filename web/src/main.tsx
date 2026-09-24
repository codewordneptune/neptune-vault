import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import { Loader, MantineProvider, Text } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OpenElsewhere } from './components/OpenElsewhere';
import { captureInstallPrompt } from './app/install';
import { installNativeBehaviour } from './app/platform';
import { AppProvider } from './app/AppContext';
import { createServices, type Services } from './app/services';
import { browserWindowOwner } from './app/windowOwner';
import { theme } from './theme';

function Root() {
  // One window holds the wallet. Nothing is opened, not the database and not
  // the wallet core, until it is known that this is the one.
  const [owner] = useState(browserWindowOwner);
  const [where, setWhere] = useState<'asking' | 'elsewhere' | 'here'>('asking');
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void owner.acquire().then((mine) => setWhere(mine ? 'here' : 'elsewhere'));
  }, [owner]);
  useEffect(() => {
    if (where !== 'here') return;
    createServices(owner).then(
      (s) => {
        owner.beforeRelease = () => s.accounts.lock();
        // Start again from nothing. The reload finds the wallet in the other
        // window and says so, with no state of this one left behind.
        owner.afterRelease = () => window.location.reload();
        setServices(s);
      },
      (e) => setError((e as Error).message),
    );
  }, [where, owner]);
  if (where === 'elsewhere') return <OpenElsewhere owner={owner} onHere={() => setWhere('here')} />;
  if (error) return <Text c="var(--v-danger-text)">Could not start: {error}</Text>;
  if (!services) return <Loader className="vault-starting" aria-label="Starting" />;
  return (
    <AppProvider services={services}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppProvider>
  );
}

// Before the first render: Chrome may fire the install event immediately.
captureInstallPrompt();
// In the desktop app: links to the system's browser, no reload or print.
installNativeBehaviour();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-center" />
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </MantineProvider>
  </StrictMode>,
);
