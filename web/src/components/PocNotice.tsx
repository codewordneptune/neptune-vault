// The proof-of-concept warning, on the first screens a person sees. Shown
// in full the first time on a device; after that as one line that expands
// on tap, so the balance stays on the first screen of a phone.

import { Alert, Text } from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

const SEEN_KEY = 'neptune-vault.poc-notice-seen';

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function PocNotice() {
  const [expanded, setExpanded] = useState(() => !seen());
  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // No storage: the full notice shows every time, which is the safe side.
    }
  }, []);
  const Chevron = expanded ? IconChevronUp : IconChevronDown;
  return (
    <Alert
      color="orange"
      icon={<IconAlertTriangle size={18} />}
      title={
        <span className="vault-poc-title">
          Proof of concept, not for production use
          <Chevron size={16} stroke={1.8} aria-hidden />
        </span>
      }
      className="vault-poc"
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
      {expanded && (
        <Text size="sm">No security audit, breaking changes ahead, and bugs may lose funds. Use it only with amounts you can afford to lose, and keep your phrase somewhere safe.</Text>
      )}
    </Alert>
  );
}
