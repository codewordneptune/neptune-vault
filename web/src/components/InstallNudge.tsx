// The offer to install, on Home, while the app runs in a browser tab on a
// phone. Installing is not cosmetic here: it is what makes the browser keep
// the wallet's storage, and where the camera and updates behave. Shown only
// where the browser can prompt (Android Chrome) or, on iOS, with the one
// instruction there is; a desktop browser is not the target and sees
// nothing. Dismissed for two weeks at a time, on this device.

import { Button } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { Info } from './Notice';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function InstallNudge() {
  const { services } = useApp();
  const [state, setState] = useState<InstallState>(installState());
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(services.settings.installNudgeDismissedAt);
  useEffect(() => onInstallChange(() => setState(installState())), []);

  const recently = dismissedAt !== undefined && Date.now() - dismissedAt < TWO_WEEKS_MS;
  if (recently || (state.kind !== 'promptable' && state.kind !== 'ios-share')) return null;

  const dismiss = async () => {
    const now = Date.now();
    setDismissedAt(now);
    await services.updateSettings({ installNudgeDismissedAt: now });
  };

  return (
    <Info icon={<IconDeviceMobile size={18} stroke={1.8} />} title="Install Neptune Vault on this device" onClose={() => void dismiss()} closeLabel="Dismiss the install offer">
      An installed app keeps its storage, works full screen, and opens from its own icon.
      {state.kind === 'promptable' ? (
        <div>
          <Button variant="light" size="sm" onClick={() => void promptInstall()}>
            Install
          </Button>
        </div>
      ) : (
        <div>In Safari: tap Share, then "Add to Home Screen".</div>
      )}
    </Info>
  );
}
