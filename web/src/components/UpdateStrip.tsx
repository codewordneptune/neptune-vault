// A new build is offered, and never applied while the app is open: the
// service worker downloads it and waits, and this strip asks. The running
// code stays for as long as a window of the app does, so the wallet's code
// does not change under a running session, and a send in progress is never
// interrupted (the strip waits until the job is done).
//
// What this does not do, and must not be said to do: keep a build out for
// good. A waiting service worker takes over by itself once every window of
// the app has closed, so "Later" lasts until the app is next closed, and a
// host that meant harm could ship a worker that does not wait at all. No
// web page can refuse its own host's next version. The defences against a
// bad build are outside the page: a gated deploy, and published file hashes
// anyone can hold against what the site serves (docs/HOSTING.md).
//
// The strip names the build that is waiting, read from the host's
// version.json, and links the commits between the two on GitHub. That is
// what the host says it serves: information, not proof.
//
// The app also asks for a new build every hour and whenever it comes back
// to the front. Without that a browser checks only when the app is opened,
// and an installed wallet left open for days would not hear of a fix.

import { Anchor, Button, Group, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useApp } from '../app/AppContext';
import { LINKS } from '../app/links';
import { fetchWaitingBuild, updateWording, type BuildInfo } from './updateWording';

/** How often an open app asks the host for a new build. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function UpdateStrip() {
  const { sendJob } = useApp();
  const [later, setLater] = useState(false);
  const [waiting, setWaiting] = useState<BuildInfo | null>(null);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => {
        // Offline, or mid-install: nothing to ask, and nothing to report.
        if (!navigator.onLine || registration.installing) return;
        void registration.update().catch(() => undefined);
      };
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });

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
