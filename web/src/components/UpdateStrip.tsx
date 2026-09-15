// A new build is offered, never applied on its own: the service worker
// downloads it and waits, and this strip asks. The running code stays
// until the person taps Update, so a changed host cannot swap the wallet's
// code under a running session, and a send in progress is never
// interrupted (the strip waits until the job is done).

import { Button, Group, Text } from '@mantine/core';
import { IconArrowUpCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useApp } from '../app/AppContext';

export function UpdateStrip() {
  const { sendJob } = useApp();
  const [later, setLater] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const sending = Boolean(sendJob && !sendJob.done);
  if (!needRefresh || later || sending) return null;

  return (
    <div className="vault-updatestrip" role="status">
      <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconArrowUpCircle size={18} stroke={1.8} />
          <Text size="sm">
            A new version of Neptune Vault is ready. You are on {__APP_VERSION__} ({__APP_COMMIT__}).
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="compact-sm" variant="subtle" className="vault-tap" onClick={() => setLater(true)}>
            Later
          </Button>
          <Button size="compact-sm" className="vault-tap" onClick={() => void updateServiceWorker(true)}>
            Update
          </Button>
        </Group>
      </Group>
    </div>
  );
}
