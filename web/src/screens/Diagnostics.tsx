// Facts for a bug report: whether this page can run the threaded prover,
// what the device reports, the versions, and how the last proof went.

import { ActionIcon, Paper, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { showInt } from '../util/format';
import { formatDateTime } from '../util/time';

export function Diagnostics() {
  const navigate = useNavigate();
  const { services, account } = useApp();
  const accountId = account?.id ?? null;
  const engine = services.accounts.engine;
  const isolated = self.crossOriginIsolated;
  const cores = navigator.hardwareConcurrency ?? 1;
  const installed = matchMedia('(display-mode: standalone)').matches;
  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const last = services.settings.lastProving;

  return (
    <Paper>
      <Stack>
        <div className="vault-title-row">
          <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Back" onClick={() => navigate(-1)}>
            <IconChevronLeft size={22} stroke={1.8} />
          </ActionIcon>
          <Title order={2}>Diagnostics</Title>
        </div>
        <Stack gap="sm">
          <Fact label="Threads" value={isolated ? 'Available: the page is cross-origin isolated' : 'Not available: the page is not cross-origin isolated, so proving runs on one thread'} state={isolated ? 'ok' : 'warn'} />
          <Fact label="Cores" value={String(cores)} />
          <Fact label="Memory, as this device reports it" value={memoryGb === undefined ? 'Not reported' : `${memoryGb} GB or more`} state={memoryGb === undefined ? undefined : memoryGb >= 4 ? 'ok' : 'warn'} />
          <Fact label="Running as" value={installed ? 'Installed app' : 'Browser tab'} state={installed ? 'ok' : 'warn'} />
          <Fact label="App version" value={`${__APP_VERSION__} (${__APP_COMMIT__}), built ${formatDateTime(Date.parse(__APP_BUILT_AT__))}`} />
          <Fact label="Wallet core" value={services.backendKind === 'native' ? 'Native, in the app' : 'WebAssembly, in a worker'} />
          {accountId && <Fact label="Contacts" value={engine.describe(accountId, 'contacts')} state={engine.describe(accountId, 'contacts') === 'In the sealed log' ? 'ok' : 'warn'} />}
          {accountId && engine.problems(accountId).map((problem) => <Fact key={problem} label="Did not move" value={problem} state="warn" />)}
        </Stack>
        <Title order={3}>Last proof on this device</Title>
        {last ? (
          <Stack gap="sm">
            <Fact
              label={formatDateTime(last.at)}
              value={
                last.error
                  ? `Failed: ${last.error}`
                  : `${showInt(last.seconds)} s, peak ${showInt(last.peakMb)} MB, ${last.threads || 'single'} threads`
              }
              state={last.error ? 'warn' : 'ok'}
            />
            <Fact
              label="Prover"
              value={`Claim version ${last.claimVersion}${last.error && last.peakMb > 0 ? `, ${showInt(last.peakMb)} MB before it failed` : ''}`}
            />
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            No proof has run on this device yet.
          </Text>
        )}
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>
          {navigator.userAgent}
        </Text>
      </Stack>
    </Paper>
  );
}

/** A label over its value; a dot marks the few rows that are a yes or a no. */
function Fact({ label, value, state }: { label: string; value: string; state?: 'ok' | 'warn' }) {
  return (
    <div className="vault-detail-row">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" className={state ? `vault-fact ${state}` : undefined}>
        {state && <span className="vault-dot" aria-hidden />}
        {value}
      </Text>
    </div>
  );
}
