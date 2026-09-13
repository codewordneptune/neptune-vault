import { Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';

// Placeholder first screen: shows whether this page can run the threaded
// prover. Replaced by the onboarding flow once the wallet core lands.
export function Diagnostics() {
  const navigate = useNavigate();
  const { services } = useApp();
  const [coreVersion, setCoreVersion] = useState<string>('…');
  useEffect(() => {
    void services.core.coreVersion?.().then(setCoreVersion, () => setCoreVersion('unavailable'));
  }, [services]);
  const isolated = self.crossOriginIsolated;
  const cores = navigator.hardwareConcurrency ?? 1;
  const installed = matchMedia('(display-mode: standalone)').matches;

  return (
    <Paper>
      <Stack gap="xs">
        <Title order={2}>Diagnostics</Title>
        <Row label="Cross-origin isolated" ok={isolated} text={isolated ? 'yes, threads available' : 'no, single-threaded'} />
        <Row label="Cores" ok text={String(cores)} />
        <Row label="Running as" ok={installed} text={installed ? 'installed app' : 'browser tab'} />
        <Row label="App version" ok text={`${__APP_VERSION__} (${__APP_COMMIT__})`} />
        <Row label="Built" ok text={new Date(__APP_BUILT_AT__).toLocaleString()} />
        <Row label="Wallet core" ok text={coreVersion} />
        <Text size="xs" c="dimmed">
          {navigator.userAgent}
        </Text>
        <Group>
          <Button variant="default" onClick={() => navigate(-1)}>
            Back
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function Row({ label, ok, text }: { label: string; ok: boolean; text: string }) {
  return (
    <Group justify="space-between">
      <Text>{label}</Text>
      <Badge color={ok ? 'green' : 'yellow'} variant="light">
        {text}
      </Badge>
    </Group>
  );
}
