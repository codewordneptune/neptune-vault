// A new build is offered, never applied on its own: the service worker
// downloads it and waits, and this strip asks. The running code stays
// until the person taps Update, so a changed host cannot swap the wallet's
// code under a running session, and a send in progress is never
// interrupted (the strip waits until the job is done). The strip names the
// build that is waiting, read from the host's version.json, and links the
// commits between the two on GitHub.

import { Anchor, Button, Group, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useApp } from '../app/AppContext';
import { LINKS } from '../app/links';
import { fetchWaitingBuild, updateWording, type BuildInfo } from './updateWording';

export function UpdateStrip() {
  const { sendJob } = useApp();
  const [later, setLater] = useState(false);
  const [waiting, setWaiting] = useState<BuildInfo | null>(null);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!needRefresh) return;
    let live = true;
    void fetchWaitingBuild().then((b) => {
      if (live) setWaiting(b);
    });
    return () => {
      live = false;
    };
  }, [needRefresh]);

  const sending = Boolean(sendJob && !sendJob.done);
  if (!needRefresh || later || sending) return null;

  const words = updateWording({ version: __APP_VERSION__, commit: __APP_COMMIT__ }, waiting);

  return (
    <div className="vault-updatestrip" role="status">
      <div className="vault-updatestrip-inner">
        <div className="vault-updatestrip-body">
          <IconRefresh size={18} stroke={1.8} />
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={600}>
              {words.headline}
            </Text>
            <Text size="xs" c="dimmed">
              {words.current}
            </Text>
          </div>
        </div>
        <div className="vault-updatestrip-actions">
          {words.compare ? (
            <Anchor href={`${LINKS.compare}${words.compare}`} target="_blank" rel="noreferrer" size="xs" className="vault-tap-link">
              What changed
            </Anchor>
          ) : (
            <span />
          )}
          <Group gap="xs" wrap="nowrap">
            <Button size="compact-sm" variant="subtle" className="vault-tap" onClick={() => setLater(true)}>
              Later
            </Button>
            <Button size="compact-sm" className="vault-tap" onClick={() => void updateServiceWorker(true)}>
              Update
            </Button>
          </Group>
        </div>
      </div>
    </div>
  );
}
