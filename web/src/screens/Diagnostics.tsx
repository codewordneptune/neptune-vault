import { Badge, Group, Paper, Stack, Text } from '@mantine/core';

// Placeholder first screen: shows whether this page can run the threaded
// prover. Replaced by the onboarding flow once the wallet core lands.
export function Diagnostics() {
  const isolated = self.crossOriginIsolated;
  const cores = navigator.hardwareConcurrency ?? 1;
  const installed = matchMedia('(display-mode: standalone)').matches;

  return (
    <Paper>
      <Stack gap="xs">
        <Row label="Cross-origin isolated" ok={isolated} text={isolated ? 'yes, threads available' : 'no, single-threaded'} />
        <Row label="Cores" ok text={String(cores)} />
        <Row label="Installed as app" ok={installed} text={installed ? 'yes' : 'no, running in the browser'} />
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
      <Badge color={ok ? 'teal' : 'yellow'} variant="light">
        {text}
      </Badge>
    </Group>
  );
}
