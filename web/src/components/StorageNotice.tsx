// On Home, once: the browser may delete this wallet when space runs low,
// and nothing else would say so where a browser offers no install (a
// desktop browser, mostly; installing is what keeps storage on a phone, and
// the install offer says that). Shown while the browser has not promised to
// keep the wallet's data and no backup file of this wallet has been saved.
// Dismissed, it does not come back on this device; the Backup page keeps its
// own warning.

import { Button, Group, Text } from '@mantine/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { installState } from '../app/install';
import { NATIVE } from '../app/platform';
import { requestPersistentStorage } from '../storage/db';
import { Caution } from './Notice';

export function StorageNotice() {
  const { services, account } = useApp();
  const navigate = useNavigate();
  const [persistent, setPersistent] = useState(services.persistent);
  const [dismissed, setDismissed] = useState(services.settings.storageNoticeDismissedAt !== undefined);
  const [asked, setAsked] = useState(false);
  if (NATIVE || persistent || dismissed || !account || account.lastBackupAt || installState().kind !== 'browser-menu') return null;

  const dismiss = async () => {
    setDismissed(true);
    await services.updateSettings({ storageNoticeDismissedAt: Date.now() });
  };
  const ask = async () => {
    const granted = await requestPersistentStorage();
    services.persistent = granted;
    setPersistent(granted);
    setAsked(true);
  };

  return (
    <Caution title="This browser may delete this wallet" onClose={() => void dismiss()} closeLabel="Dismiss the storage warning">
      <span>When space runs low, a browser can delete what a site keeps. A backup file, or the seed phrase, brings the wallet back.</span>
      <Group mt={4} gap="sm" align="center">
        <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => navigate('/settings/backup')}>
          Back up
        </Button>
        <Button variant="subtle" size="compact-sm" onClick={() => void ask()}>
          Ask the browser to keep it
        </Button>
        {asked && (
          <Text size="sm" c="dimmed">
            Not granted.
          </Text>
        )}
      </Group>
    </Caution>
  );
}
