// The offer to install, on Home, while the app runs in a browser tab on a
// phone. Installing is not cosmetic here: it is what makes the browser keep
// the wallet's storage, and where the camera and updates behave. Shown only
// where the browser can prompt (Android Chrome) or, on iOS, with the one
// instruction there is; a desktop browser is not the target and sees
// nothing. Dismissed for two weeks at a time, on this device.

import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { Caution, Info } from './Notice';
import { INSTALL_BENEFITS } from '../app/words';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function InstallNudge() {
  const { services } = useApp();
  const [state, setState] = useState<InstallState>(installState());
  const [dismissedAt, setDismissedAt] = useState<number | undefined>(services.settings.installNudgeDismissedAt);
  useEffect(() => onInstallChange(() => setState(installState())), []);

  // On an iPhone or iPad, Safari deletes what a site keeps once it has not
  // been opened for about a week, unless it was added to the Home Screen:
  // this is a caution, and it comes back until the app is installed.
  if (state.kind === 'ios-share') {
    const device = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : 'iPhone';
    return (
      <Caution title="Add Neptune Vault to the Home Screen">
        Safari deletes this wallet from this {device} if you do not open it for about a week. Add it to the Home Screen to keep it: in Safari, tap Share, then "Add to Home Screen". And keep your seed phrase.
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
    <Info title="Install Neptune Vault on this device" onClose={() => void dismiss()} closeLabel="Dismiss the install offer">
      {INSTALL_BENEFITS}
      <div>
        <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => void promptInstall()}>
          Install app
        </Button>
      </div>
    </Info>
  );
}
