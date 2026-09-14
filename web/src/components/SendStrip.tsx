// A slim strip under the header while a send is running, shown on every
// screen including the lock screen, so a proof that continues after the
// app was backgrounded stays visible. Tapping it opens the Send screen.

import { Progress, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';

const STAGE_TEXT: Record<string, string> = {
  planning: 'Choosing inputs',
  'membership-proofs': 'Fetching membership proofs',
  building: 'Building the transaction',
  proving: 'Proving',
  submitting: 'Submitting to the node',
  done: 'Submitted',
};

export function SendStrip() {
  const { sendJob, locked } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!sendJob || sendJob.done) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sendJob]);

  if (!sendJob || sendJob.done || (!locked && location.pathname === '/send')) return null;

  const p = sendJob.progress.proving;
  const stage = STAGE_TEXT[sendJob.progress.stage] ?? sendJob.progress.stage;
  const detail = p ? `step ${Math.min(p.index + 1, p.total)} of ${p.total}` : stage;
  const elapsed = Math.round((Date.now() - sendJob.startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const value = p ? (100 * p.index) / p.total : 3;

  return (
    <UnstyledButton className="vault-sendstrip" onClick={() => !locked && navigate('/send')} aria-live="polite" disabled={locked}>
      <div className="vault-sendstrip-row">
        <Text size="sm" fw={500}>
          Sending {sendJob.request.amount} NPT · {detail}
        </Text>
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {mm}:{ss}
        </Text>
      </div>
      <Progress value={value} size="xs" animated={!p} />
    </UnstyledButton>
  );
}
