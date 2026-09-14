import { ActionIcon, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';

// Facts for a bug report: whether this page can run the threaded prover,
// what the device reports, the versions, and how the last proof went.
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
  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const last = services.settings.lastProving;

  return (
    <Paper>
      <Stack gap="xs">
        <Group gap="xs" align="center" wrap="nowrap">
          <ActionIcon variant="subtle" size="lg" aria-label="Back" onClick={() => navigate(-1)}>
            <IconChevronLeft size={22} stroke={1.8} />
          </ActionIcon>
          <Title order={2}>Diagnostics</Title>
        </Group>
        <Row label="Cross-origin isolated" ok={isolated} text={isolated ? 'yes, threads available' : 'no, single-threaded'} />
        <Row label="Cores" ok text={String(cores)} />
        <Row label="Memory (as reported)" ok={memoryGb === undefined || memoryGb >= 4} text={memoryGb === undefined ? 'not reported' : `${memoryGb} GB or more`} />
        <Row label="Running as" ok={installed} text={installed ? 'installed app' : 'browser tab'} />
        <Row label="App version" ok text={`${__APP_VERSION__} (${__APP_COMMIT__})`} />
        <Row label="Built" ok text={new Date(__APP_BUILT_AT__).toLocaleString()} />
        <Row label="Wallet core" ok text={coreVersion} />
        <Title order={3} mt="sm">
          Last proof on this device
        </Title>
        {last ? (
          <Stack gap={2}>
            <Text size="sm" c={last.error ? 'red' : undefined}>
              {last.error
                ? `Failed: ${last.error}`
                : `${last.seconds.toFixed(0)} s, peak ${last.peakMb.toFixed(0)} MB, ${last.threads || 'single'} threads`}
            </Text>
            <Text size="xs" c="dimmed">
              {last.claimVersion === 5 ? 'Pre-fork prover (claim version 5)' : `Prover for claim version ${last.claimVersion}`}
              {last.peakMb > 0 && last.error ? `, ${last.peakMb.toFixed(0)} MB before it failed` : ''} · {new Date(last.at).toLocaleString()}
            </Text>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            No proof has run on this device yet.
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {navigator.userAgent}
        </Text>
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
