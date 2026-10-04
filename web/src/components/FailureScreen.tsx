// The screen for when the app cannot go on: it could not start, or a screen
// failed to show. What happened in plain words, Reload, and the details for
// a report, copied only when asked, as Report a problem does.

import { Anchor, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';

import { LINKS } from '../app/links';
import { copyText } from '../util/clipboard';

export function FailureScreen({ title, said, error }: { title: string; said: string; error: string }) {
  const details = () =>
    [`${title}: ${error}`, `Neptune Vault ${__APP_VERSION__} (${__APP_COMMIT__})`, `Cross-origin isolated: ${self.crossOriginIsolated ? 'yes' : 'no'}`, navigator.userAgent].join('\n');
  return (
    <div style={{ maxWidth: 540, margin: '48px auto', padding: '0 16px' }}>
      <Paper>
        <Stack>
          <Title order={2}>{title}</Title>
          <Text size="sm" c="dimmed">
            {said}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-word' }}>
            {error}
          </Text>
          <Button onClick={() => location.reload()}>Reload</Button>
          <Group gap="md" style={{ rowGap: 24 }}>
            <Button variant="light" leftSection={<IconCopy size={16} />} onClick={() => void copyText(details(), 'Details copied')}>
              Copy details
            </Button>
            <Anchor href={LINKS.issues} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Report a problem on GitHub
            </Anchor>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}
