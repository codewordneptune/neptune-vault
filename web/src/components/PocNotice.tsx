// The not-yet-audited warning, on the first screens a person sees. Shown
// in full the first time on a device; after that as one line that expands
// on tap, so the balance stays on the first screen of a phone.

import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { Caution } from './Notice';

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
    <Caution
      title={
        <span className="vault-poc-title">
          Early version, not yet audited
          <Chevron size={16} stroke={1.8} aria-hidden />
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
      {expanded && 'No security audit yet, and changes every week. Use it only with amounts you can afford to lose, and keep your seed phrase somewhere safe.'}
    </Caution>
  );
}
