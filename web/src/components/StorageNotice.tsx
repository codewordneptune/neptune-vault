// On Home, once: the browser may delete this wallet when space runs low,
// and nothing else would say so where a browser offers no install (a
// desktop browser, mostly; installing is what keeps storage on a phone, and
// the install offer says that). Shown while the browser has not promised to
// keep the wallet's data and no backup file of this wallet has been saved.
// Dismissed, it does not come back on this device; the Backup page keeps its
// own warning.

import { Group, Text, UnstyledButton } from '@mantine/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { installState } from '../app/install';
import { NATIVE } from '../app/platform';
import { requestPersistentStorage } from '../storage/db';
import { headingNear, NoticeLine } from './Notice';

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
    <NoticeLine
      about="the storage warning"
      title="This browser may delete this wallet"
      action={
        <UnstyledButton onClick={() => navigate('/settings/backup')} c="var(--v-accent-text)" fz="sm" fw={600} className="vault-tap-link">
          Back up
        </UnstyledButton>
      }
    >
      <span>When space runs low, a browser can delete what a site keeps. A backup file, or the seed phrase, brings the wallet back.</span>
      <Group gap="md" align="center">
        <UnstyledButton onClick={() => void ask()} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
          Ask the browser to keep it
        </UnstyledButton>
        <UnstyledButton
          onClick={(e) => {
            const heading = headingNear(e.currentTarget);
            void dismiss();
            heading?.focus({ preventScroll: true });
          }}
          c="var(--v-accent-text)"
          fz="sm"
          className="vault-tap-link"
        >
          Dismiss
        </UnstyledButton>
        {asked && (
          <Text size="sm" c="dimmed">
            Not granted.
          </Text>
        )}
      </Group>
    </NoticeLine>
  );
}
