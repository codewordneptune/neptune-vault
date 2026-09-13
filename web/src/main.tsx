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
import { captureInstallPrompt } from './app/install';
import { AppProvider } from './app/AppContext';
import { createServices, type Services } from './app/services';
import { theme } from './theme';

function Root() {
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    createServices().then(setServices, (e) => setError((e as Error).message));
  }, []);
  if (error) return <Text c="red">Could not start: {error}</Text>;
  if (!services) return <Loader m="xl" />;
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-center" />
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </MantineProvider>
  </StrictMode>,
);
