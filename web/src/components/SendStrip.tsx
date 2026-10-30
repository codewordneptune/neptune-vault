// A slim strip under the header while a send is running, shown on every
// screen including the lock screen, so a proof that continues after the
// app was backgrounded stays visible: the send moment made small, with who,
// how much and how far. Locked, it keeps who and how much to itself.
// Tapping it opens the Send screen.

import { Progress, Text, UnstyledButton } from '@mantine/core';
import { IconArrowUpRight, IconUser, IconUsers } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { showNau, useApp } from '../app/AppContext';
import { paymentsTotalNau } from '../app/send';
import { sendStageText } from '../app/words';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress } from '../util/address';
import { formatAbout, formatDuration } from '../util/time';
import { Avatar } from './Avatar';
import { WarnLine } from './Notice';
import { Spoken } from './Spoken';

export function SendStrip() {
  const { services, account, sendJob, locked, awaitingApproval } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [, setNow] = useState(Date.now());
  const running = Boolean(sendJob && !sendJob.done);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  useEffect(() => {
    if (running && account && !locked) void services.contacts.list(account.id).then(setContacts);
  }, [services, account, locked, running]);

  if (!sendJob || sendJob.done || (!locked && location.pathname === '/send')) return null;

  const { request, progress } = sendJob;
  const proving = progress.stage === 'proving';
  const p = progress.proving;
  const first = request.payments[0]?.recipient.trim() ?? '';
  const others = request.payments.length - 1;
  const contact = others === 0 ? contacts.find((c) => c.address === first.toLowerCase()) : undefined;
  const who = (contacts.find((c) => c.address === first.toLowerCase())?.name ?? abbreviateAddress(first)) + (others ? ` and ${others} more` : '');
  const hidden = services.settings.hideBalance ?? false;
  const step = `${proving ? 'Proving on this device' : sendStageText(progress.stage)}${awaitingApproval && progress.stage !== 'confirming' ? ' · confirm it on Send' : ''}`;
  // The same clock as the Send screen: the time left from this device's
  // last proof, until the proof runs past it.
  const last = services.settings.lastProving;
  const estimate = last && !last.error && last.seconds > 0 ? last.seconds : null;
  const seconds = sendJob.provingSince ? Math.max(0, Math.round((Date.now() - sendJob.provingSince) / 1000)) : 0;
  const time = !proving ? null : estimate !== null && seconds < estimate ? `${formatAbout(estimate - seconds)} left` : `${formatDuration(seconds)} so far`;
  const value = Math.round(p ? 100 * (p.work ?? p.index / p.total) : 3);

  // A region of its own, so it is found among the page's landmarks.
  return (
    <div role="region" aria-label="Send in progress">
      <UnstyledButton className="vault-sendstrip" onClick={() => !locked && navigate('/send')} disabled={locked}>
        <div className="vault-sendstrip-row">
          {!locked && contact ? (
            <Avatar name={contact.name} address={contact.address} />
          ) : (
            <span className="vault-row-icon out" aria-hidden>
              {locked ? <IconArrowUpRight size={16} /> : others > 0 ? <IconUsers size={16} /> : <IconUser size={16} />}
            </span>
          )}
          <div className="vault-sendstrip-text">
            <Text size="sm" fw={600}>
              {locked ? (
                'Sending'
              ) : (
                <>
                  Sending {!hidden && <Spoken text={`${showNau(paymentsTotalNau(request))} NPT `} />}to <bdi>{who}</bdi>
                </>
              )}
            </Text>
            <Text size="xs" c="dimmed" aria-live="polite">
              {step}
            </Text>
          </div>
          {time && (
            <Text size="xs" c="dimmed" className="vault-tabular vault-sendstrip-time">
              <Spoken text={time} />
            </Text>
          )}
        </div>
        {progress.note && <WarnLine mt={6}>{progress.note}</WarnLine>}
        <Progress value={value} size={3} radius={0} animated={!p} aria-label="Share of the send's work done" />
      </UnstyledButton>
    </div>
  );
}
