// The offer to install, on Home, while the app runs in a browser tab on a
// phone. Installing is not cosmetic here: it is what makes the browser keep
// the wallet's storage, and where the camera and updates behave. Shown only
// where the browser can prompt (Android Chrome) or, on iOS, with the one
// instruction there is; a desktop browser is not the target and sees
// nothing. Dismissed for two weeks at a time, on this device.

import { Group, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { Caution, headingNear, NoticeLine } from './Notice';
import { INSTALL_BENEFITS } from '../app/words';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function InstallNudge() {
  const { services } = useApp();
  const navigate = useNavigate();
  const [state, setState] = useState<InstallState>(installState());
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(services.settings.installNudgeDismissedAt);
  useEffect(() => onInstallChange(() => setState(installState())), []);

  // On an iPhone or iPad, Safari deletes what a site keeps once it has not
  // been opened for about a week, unless it was added to the Home Screen:
  // this is a caution, and it comes back until the app is installed. A Home
  // Screen app has storage of its own and opens empty (WebKit bug 181849),
  // so the wallet moves there by its backup.
  if (state.kind === 'ios-share') {
    return (
      <Caution title="Move this wallet to the Home Screen">
        <span>Safari deletes this wallet if you do not open it for about a week. The Home Screen app starts empty, so back up first. Then tap Share, then Add to Home Screen, and restore the wallet there.</span>
        <Group gap="sm" mt={4}>
          <UnstyledButton onClick={() => navigate('/settings/backup', { state: { from: 'home' } })} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
            Back up
          </UnstyledButton>
        </Group>
      </Caution>
    );
  }
  const recently = dismissedAt !== undefined && Date.now() - dismissedAt < TWO_WEEKS_MS;
  if (recently || state.kind !== 'promptable') return null;

  const dismiss = async () => {
    const now = Date.now();
    setDismissedAt(now);
    await services.updateSettings({ installNudgeDismissedAt: now });
  };

  return (
    <NoticeLine
      about="installing the app"
      title="Install Neptune Vault on this device"
      action={
        <UnstyledButton
          onClick={(e) => {
            // Installed, the nudge goes: the focus goes to the heading near it.
            const heading = headingNear(e.currentTarget);
            void promptInstall().then((ok) => ok && heading?.focus({ preventScroll: true }));
          }}
          c="var(--v-accent-text)"
          fz="sm"
          className="vault-tap-link"
        >
          Install
        </UnstyledButton>
      }
    >
      <span>{INSTALL_BENEFITS}</span>
      <Group>
        <UnstyledButton
          onClick={(e) => {
            const heading = headingNear(e.currentTarget);
            void dismiss();
            heading?.focus({ preventScroll: true });
          }}
          c="var(--v-accent-text)"
          fz="sm"
          className="vault-tap-link vault-tap-link-start"
        >
          Not now
        </UnstyledButton>
      </Group>
    </NoticeLine>
  );
}
