// The not-yet-audited warning. At setup it is read in full, on the first
// screen a person sees (the notice). Everywhere, it is a small Beta tag by
// the mark in the header, which opens the same text (the tag): a row on
// Home every day was more than it needs, and dropping it was not honest.

import { Button, Group, Stack, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { Sheet } from './Sheet';
import { Caution } from './Notice';

const SEEN_KEY = 'neptune-vault.poc-notice-seen';
const POC_TITLE = 'Early version, not yet audited';
// The title says it is not audited; the seed phrase comes on the next screen.
const POC_TEXT = 'It changes often. Use it only with amounts you can afford to lose.';

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** The warning at setup: in full the first time on a device, then one line that expands on tap. */
export function PocNotice() {
  const [expanded, setExpanded] = useState(() => !seen());
  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // No storage: the full notice shows every time, which is the safe side.
    }
  }, []);
  return (
    <Caution
      title={
        <span className="vault-poc-title">
          {POC_TITLE}
          <IconChevronRight size={16} aria-hidden className={expanded ? 'vault-chevron open' : 'vault-chevron'} />
        </span>
      }
      className={expanded ? 'vault-poc' : 'vault-poc collapsed'}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
    >
      {expanded && POC_TEXT}
    </Caution>
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
      <Sheet opened={open} onClose={() => setOpen(false)} title={POC_TITLE}>
        <Stack>
          <Text size="sm">{POC_TEXT}</Text>
          <Group justify="flex-end">
            <Button onClick={() => setOpen(false)} data-autofocus>
              OK
            </Button>
          </Group>
        </Stack>
      </Sheet>
    </>
  );
}
