// The offer to install, on Home, while the app runs in a browser tab on a
// phone. Installing is not cosmetic here: it is what makes the browser keep
// the wallet's storage, and where the camera and updates behave. Shown only
// where the browser can prompt (Android Chrome) or, on iOS, with the one
// instruction there is; a desktop browser is not the target and sees
// nothing. Dismissed for two weeks at a time, on this device.

import { Group, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { Caution, headingNear, NoticeLine } from './Notice';
import { INSTALL_BENEFITS } from '../app/words';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function InstallNudge() {
  const { services } = useApp();
  const [state, setState] = useState<InstallState>(installState());
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(services.settings.installNudgeDismissedAt);
  useEffect(() => onInstallChange(() => setState(installState())), []);

  // On an iPhone or iPad, Safari deletes what a site keeps once it has not
  // been opened for about a week, unless it was added to the Home Screen:
  // this is a caution, and it comes back until the app is installed. One
  // sentence: the risk, then the two taps that remove it.
  if (state.kind === 'ios-share') {
    return (
      <Caution title="Add Neptune Vault to the Home Screen">
        Safari deletes this wallet if you do not open it for about a week; to keep it, tap Share, then Add to Home Screen.
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
        <UnstyledButton onClick={() => void promptInstall()} c="var(--v-accent-text)" fz="sm" fw={600} className="vault-tap-link">
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
