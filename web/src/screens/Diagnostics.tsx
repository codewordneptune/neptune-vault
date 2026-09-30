// The facts about this device and the app (whether this page can run the
// threaded prover, what the device reports, the versions, and how the last
// proof went) and a button that copies them, on two pages, one for each
// reason to look. Diagnostics, a page of Settings reached from Advanced,
// for whoever wants to see how the wallet runs here. Report a problem,
// reached from About, and a screen of its own before a wallet exists,
// reached from setup: first what to do with the facts, and where to send
// them. The same facts on both, so a report copies what Diagnostics shows.

import { Anchor, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';

import { useApp } from '../app/AppContext';
import { LINKS } from '../app/links';
import { NATIVE } from '../app/platform';
import { copyText } from '../util/clipboard';
import { showInt } from '../util/format';
import { formatDateTime } from '../util/time';
import { BackLink } from './Privacy';

type FactRow = { label: string; value: string; state?: 'ok' | 'warn' };

/** The facts and their Copy button, for a page that gives them a title; for a report, first what to do with them and where. */
export function DeviceDetails({ report = false }: { report?: boolean }) {
  const { services, account } = useApp();
  const accountId = account?.id ?? null;
  const engine = services.accounts.engine;
  const isolated = self.crossOriginIsolated;
  const cores = navigator.hardwareConcurrency ?? 1;
  const installed = matchMedia('(display-mode: standalone)').matches;
  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const last = services.settings.lastProving;

  // Each verdict is said in words, not only by the colour of its dot.
  const facts: FactRow[] = [
    NATIVE
      ? { label: 'Proving', value: `Native, on all ${cores} cores: the desktop app needs no cross-origin isolation`, state: 'ok' }
      : {
          label: 'Cross-origin isolation',
          value: isolated ? 'Yes: the wallet engine can run, and proving uses every core' : 'No: the wallet engine needs it and cannot run on this page',
          state: isolated ? 'ok' : 'warn',
        },
    { label: 'Cores', value: String(cores) },
    {
      label: 'Memory, as this device reports it',
      value: memoryGb === undefined ? 'Not reported' : memoryGb >= 4 ? `${memoryGb} GB or more: enough for most sends` : `${memoryGb} GB or more: a send with many coins may run out of memory while proving`,
      state: memoryGb === undefined ? undefined : memoryGb >= 4 ? 'ok' : 'warn',
    },
    { label: 'Running as', value: NATIVE ? 'Desktop app' : installed ? 'Installed app' : 'Browser tab: the browser may delete its data when space runs low', state: NATIVE || installed ? 'ok' : 'warn' },
    { label: 'App version', value: `${__APP_VERSION__} (${__APP_COMMIT__}), built ${formatDateTime(Date.parse(__APP_BUILT_AT__))}` },
    { label: 'Wallet core', value: services.backendKind === 'native' ? 'Native, in the app' : 'WebAssembly, in a worker' },
    ...(accountId ? engine.problems(accountId).map((problem): FactRow => ({ label: 'Did not move', value: problem, state: 'warn' })) : []),
  ];
  const proof: FactRow[] | null = last
    ? [
        {
          label: formatDateTime(last.at),
          // A peak of 0 was not measured (an app from before it was, or macOS): left out, not shown as nothing.
          value: last.error ? `Failed: ${last.error}` : `${showInt(last.seconds)} s${last.peakMb > 0 ? `, peak ${showInt(last.peakMb)} MB` : ''}, ${last.threads || 'single'} threads`,
          state: last.error ? 'warn' : 'ok',
        },
        { label: 'Prover', value: `Claim version ${last.claimVersion}${last.error && last.peakMb > 0 ? `, ${showInt(last.peakMb)} MB before it failed` : ''}` },
      ]
    : null;
  // What is on this page, as text for a report: nothing else, and only when asked.
  const details = () =>
    [
      ...facts.map((f) => `${f.label}: ${f.value}`),
      '',
      'Last proof on this device:',
      ...(proof ? proof.map((f) => `${f.label}: ${f.value}`) : ['None yet']),
      '',
      navigator.userAgent,
    ].join('\n');

  return (
    <Paper>
      <Stack>
        {report && <Text size="sm">Copy these details into your report.</Text>}
        <Group>
          <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(details(), 'Details copied')}>
            Copy details
          </Button>
        </Group>
        {report && (
          <Group gap="md" style={{ rowGap: 24 }}>
            <Anchor href={LINKS.issues} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Report on GitHub
            </Anchor>
            <Anchor href={LINKS.telegram} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Ask in Telegram
            </Anchor>
          </Group>
        )}
        <Stack gap="sm">
          {facts.map((f, i) => (
            <Fact key={i} {...f} />
          ))}
        </Stack>
        <Title order={3}>Last proof on this device</Title>
        {proof ? (
          <Stack gap="sm">
            {proof.map((f, i) => (
              <Fact key={i} {...f} />
            ))}
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

/** Report a problem on its own, before a wallet exists: the way back, then the title, as Settings' pages have them. */
export function ReportProblemScreen() {
  return (
    <Stack gap="md">
      <BackLink />
      <Title order={2}>Report a problem</Title>
      <DeviceDetails report />
    </Stack>
  );
}

/** A label over its value; a dot marks the few rows that are a yes or a no. */
function Fact({ label, value, state }: FactRow) {
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
