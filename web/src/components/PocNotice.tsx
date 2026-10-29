// The not-yet-audited warning. At setup it is a line under the ways in,
// with its full sentence under it the first time on a device (the line).
// Everywhere, it is a small Beta tag by the mark in the header (the tag).
// Both open the same text: a row on Home every day was more than it needs,
// and dropping it was not honest.

import { Button, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { Sheet } from './Sheet';

const SEEN_KEY = 'neptune-vault.poc-notice-seen';
const POC_TITLE = 'Early version, not yet audited';
// The title says it is not audited; the seed phrase comes on the next screen.
const POC_TEXT = 'Prototype, for testing only. Not audited. Do not use it for real funds.';
// Under the line, which already says it is not audited.
const POC_FIRST = 'Prototype, for testing only. Do not use it for real funds.';

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function PocSheet({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Sheet opened={opened} onClose={onClose} title={POC_TITLE}>
      <Stack>
        <Text size="sm">{POC_TEXT}</Text>
        <Button variant="default" onClick={onClose} data-autofocus>
          OK
        </Button>
      </Stack>
    </Sheet>
  );
}

/** The warning at setup: the line, and in full under it the first time on a device. */
export function PocLine() {
  const [first] = useState(() => !seen());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // No storage: the full sentence shows every time, which is the safe side.
    }
  }, []);
  return (
    <>
      <UnstyledButton type="button" className="vault-poc-line vault-tap-link" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <IconAlertTriangle size={16} aria-hidden />
        {POC_TITLE}
      </UnstyledButton>
      {first && (
        <Text size="sm" ta="center" className="vault-poc-first">
          {POC_FIRST}
        </Text>
      )}
      <PocSheet opened={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The warning on every screen: a tag by the mark that opens the full text. */
export function PocTag() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* The tag is drawn small; the button around it is a full touch target. */}
      <button type="button" className="vault-beta" aria-haspopup="dialog" aria-label={`Beta: ${POC_TITLE}`} onClick={() => setOpen(true)}>
        <span aria-hidden>Beta</span>
      </button>
      <PocSheet opened={open} onClose={() => setOpen(false)} />
    </>
  );
}
