// Balance, sync status and history (F13, F14, R18).

import { ActionIcon, Alert, Badge, Button, Group, Modal, Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconArrowsExchange, IconCopy, IconEye, IconEyeOff, IconRefresh, IconShieldCheck, IconWifiOff } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatNau, useApp } from '../app/AppContext';
import type { ContactRecord, HistoryRecord } from '../storage/db';
import { abbreviateAddress } from '../util/address';
import { copyText } from '../util/clipboard';
import { groupHistory, type HistoryEntry } from '../util/history';
import { formatWhen } from '../util/time';

export function Home() {
  const { balance, sync, history, utxos, syncNow, lastSyncedAt, online, services, refresh, account } = useApp();
  // Masked amounts for reading the app in public; remembered across visits.
  const [hidden, setHidden] = useState<boolean>(services.settings.hideBalance ?? false);
  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    void services.updateSettings({ hideBalance: next });
  };
  const amount = (nau: bigint) => (hidden ? '••••' : formatNau(nau));
  // Re-render every 30 s so "2 min ago" stays right.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  };
  const navigate = useNavigate();

  // Reminder until an export file exists; a dismissal snoozes it for a week.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const showBackupNudge =
    Boolean(account) && !account?.lastBackupAt && !(account?.backupNudgeDismissedAt && Date.now() - account.backupNudgeDismissedAt < WEEK_MS);
  const dismissNudge = async () => {
    if (!account) return;
    await services.accounts.dismissBackupNudge(account.id);
    await refresh();
  };

  // One entry per transaction, with the recipient named when it is a contact.
  const entries = groupHistory(history, utxos);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  useEffect(() => {
    if (!account) return;
    void services.contacts.list(account.id).then(setContacts);
  }, [services, account, history.length]);
  const contactFor = (address: string | null) => (address ? contacts.find((c) => c.address === address) : undefined);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);

  // Giving up on a pending send frees its reserved coins; confirmed first.
  const [givingUp, setGivingUp] = useState<HistoryRecord | null>(null);
  const giveUp = async () => {
    if (!account || !givingUp) return;
    await services.sendService(account.id).forget(givingUp.txid);
    setGivingUp(null);
    await refresh();
  };
  // Exactly what is held: the inputs reserved for that transaction.
  const reservedFor = (h: HistoryRecord) => utxos.filter((u) => u.pendingTxid === h.txid).reduce((sum, u) => sum + BigInt(u.amountNau), 0n);

  const busy = sync?.phase === 'checking' || sync?.phase === 'scanning';
  const syncText =
    sync === null
      ? 'Not synced yet'
      : sync.phase === 'checking'
        ? 'Checking the chain'
        : sync.phase === 'scanning'
          ? `Scanning block ${sync.syncedHeight} of ${sync.tipHeight}`
          : sync.phase === 'done'
            ? `Up to date · block ${sync.syncedHeight}${lastSyncedAt ? ` · ${ago(lastSyncedAt)}` : ''}`
            : sync.message ?? 'Sync failed';

  const titleOf = (e: HistoryEntry) => {
    if (e.kind === 'received') return 'Received';
    if (e.kind === 'self') return 'Moved to yourself';
    const c = contactFor(e.record.recipient);
    return `Sent to ${c ? c.name : e.record.recipient ? abbreviateAddress(e.record.recipient) : 'address'}`;
  };
  const statusOf = (h: HistoryRecord) =>
    h.status === 'confirmed' ? (h.height !== null ? `Confirmed in block ${h.height}` : 'Confirmed') : h.status === 'pending' ? 'Pending, waiting for the network' : 'Failed';

  return (
    <Stack gap="md">
      <Title order={2} className="sr-only">
        Home
      </Title>
      <div className={`vault-status${sync?.phase === 'error' ? ' error' : ''}`}>
        <span className="vault-status-text">
          {!online && <IconWifiOff size={14} stroke={1.8} />}
          {busy && <IconRefresh size={14} stroke={1.8} className="vault-spin" />}
          {syncText}
        </span>
        {!busy && online && (
          <span className="vault-status-actions">
            {sync?.phase === 'error' && (
              <UnstyledButton onClick={() => navigate('/settings')} fz="xs" c="var(--v-accent-text)">
                Settings
              </UnstyledButton>
            )}
            <UnstyledButton onClick={() => void syncNow()} fz="xs" c="var(--v-accent-text)">
              {sync?.phase === 'error' ? 'Retry' : 'Sync'}
            </UnstyledButton>
          </span>
        )}
      </div>
      {showBackupNudge && (
        <Alert color="yellow" icon={<IconShieldCheck size={18} />} title="Back up this wallet" withCloseButton onClose={() => void dismissNudge()}>
          <Text size="sm">Clearing the browser's site data deletes it. Save a backup file so you can restore the wallet and its contacts.</Text>
          <Button size="compact-sm" variant="light" mt="xs" onClick={() => navigate('/settings')}>
            Save a backup file
          </Button>
        </Alert>
      )}
      <Paper>
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <span className="vault-eyebrow">Spendable balance</span>
            <ActionIcon variant="subtle" size="sm" aria-label={hidden ? 'Show amounts' : 'Hide amounts'} aria-pressed={hidden} onClick={toggleHidden}>
              {hidden ? <IconEyeOff size={16} stroke={1.8} /> : <IconEye size={16} stroke={1.8} />}
            </ActionIcon>
          </Group>
          <div className="vault-balance" aria-label={hidden ? 'Balance hidden' : `${formatNau(balance.spendableNau)} NPT`}>
            {amount(balance.spendableNau)}
            <small> NPT</small>
          </div>
          {balance.reservedNau > 0n && (
            <Text size="sm" c="dimmed">
              {amount(balance.reservedNau)} NPT is held by a pending send. It stays held until the network includes the transaction, usually within a few blocks; then the change comes back as spendable.
            </Text>
          )}
          <Group grow mt="sm">
            <Button leftSection={<IconArrowUpRight size={18} stroke={1.8} />} onClick={() => navigate('/send')}>
              Send
            </Button>
            <Button variant="light" leftSection={<IconArrowDownLeft size={18} stroke={1.8} />} onClick={() => navigate('/receive')}>
              Receive
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper>
        <Title order={3} mb="sm">
          History
        </Title>
        {entries.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing yet. Share a receiving address to get started.
          </Text>
        ) : (
          <div>
            {entries.map((e) => {
              const h = e.record;
              const incoming = e.kind === 'received';
              return (
                <UnstyledButton className="vault-row vault-row-button" key={h.key} onClick={() => setDetail(e)} aria-label={`${titleOf(e)}, details`}>
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className={`vault-row-icon${incoming ? '' : ' out'}`}>
                      {incoming ? <IconArrowDownLeft size={18} stroke={1.8} /> : e.kind === 'self' ? <IconArrowsExchange size={18} stroke={1.8} /> : <IconArrowUpRight size={18} stroke={1.8} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} truncate>
                        {titleOf(e)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatWhen(h.timestampMs)}
                        {h.height !== null && ` · block ${h.height}`}
                      </Text>
                    </div>
                  </Group>
                  <div style={{ textAlign: 'right' }}>
                    <Text size="sm" fw={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {incoming ? '+' : '−'}
                      {amount(e.shownNau)}
                    </Text>
                    {h.status !== 'confirmed' ? (
                      <Badge size="xs" color={h.status === 'pending' ? 'yellow' : 'red'}>
                        {h.status}
                      </Badge>
                    ) : e.kind === 'sent' && h.feeNau ? (
                      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        fee {amount(BigInt(h.feeNau))}
                      </Text>
                    ) : e.kind === 'self' ? (
                      <Text size="xs" c="dimmed">
                        fee only
                      </Text>
                    ) : null}
                  </div>
                </UnstyledButton>
              );
            })}
          </div>
        )}
      </Paper>

      <Modal opened={detail !== null} onClose={() => setDetail(null)} title={detail ? titleOf(detail) : ''}>
        {detail && (
          <Stack gap="sm">
            <DetailRow label="Status" value={statusOf(detail.record)} />
            {detail.record.error && <DetailRow label="Error" value={detail.record.error} />}
            <DetailRow label="When" value={new Date(detail.record.timestampMs).toLocaleString()} />
            {detail.kind === 'received' && <DetailRow label="Amount" value={`${amount(detail.shownNau)} NPT`} />}
            {detail.kind !== 'received' && (
              <>
                {detail.kind === 'sent' && <DetailRow label="Amount" value={`${amount(BigInt(detail.record.amountNau))} NPT`} />}
                {detail.kind === 'self' && <DetailRow label="Moved" value={`${amount(BigInt(detail.record.amountNau))} NPT, back to this wallet`} />}
                {detail.record.feeNau && <DetailRow label="Fee" value={`${amount(BigInt(detail.record.feeNau))} NPT`} />}
                {detail.changeNau !== null && detail.kind === 'sent' && <DetailRow label="Change returned" value={`${amount(detail.changeNau)} NPT`} />}
                <DetailRow label="Taken from balance" value={`${amount(-detail.netNau)} NPT`} />
                {detail.record.recipient && (
                  <DetailRow
                    label={contactFor(detail.record.recipient) ? `Recipient · ${contactFor(detail.record.recipient)?.name}` : 'Recipient'}
                    value={detail.record.recipient}
                    mono
                    copy="Address copied"
                  />
                )}
                {detail.record.txid && <DetailRow label="Transaction id" value={detail.record.txid} mono copy="Transaction id copied" />}
              </>
            )}
            {detail.kind !== 'received' && detail.record.status === 'pending' && (
              <Group justify="flex-end" mt="xs">
                <Button
                  variant="light"
                  color="red"
                  onClick={() => {
                    setGivingUp(detail.record);
                    setDetail(null);
                  }}
                >
                  Give up on this send
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Modal>

      <Modal opened={givingUp !== null} onClose={() => setGivingUp(null)} title="Give up on this send?">
        {givingUp && (
          <Stack>
            <Text size="sm">
              The coins held for it become spendable again. If the network includes the transaction anyway, it still goes through and shows up as sent.
            </Text>
            <Text size="sm" c="dimmed">
              This send: {formatNau(BigInt(givingUp.amountNau))} NPT{givingUp.feeNau && ` plus a ${formatNau(BigInt(givingUp.feeNau))} NPT fee`}. Held for it: {formatNau(reservedFor(givingUp))} NPT, which becomes spendable again.
            </Text>
            <Group grow>
              <Button variant="default" onClick={() => setGivingUp(null)}>
                Keep waiting
              </Button>
              <Button color="red" onClick={() => void giveUp()}>
                Give up
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/** A label and its value in the detail sheet; long values wrap and can be copied. */
function DetailRow({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: string }) {
  return (
    <div className="vault-detail-row">
      <Text size="xs" c="dimmed" className="vault-detail-label">
        {label}
      </Text>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Text size="sm" className={mono ? 'vault-detail-mono' : undefined} style={{ fontVariantNumeric: 'tabular-nums', flex: 1, minWidth: 0 }}>
          {value}
        </Text>
        {copy && (
          <ActionIcon variant="subtle" size="sm" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copyText(value, copy)}>
            <IconCopy size={16} stroke={1.8} />
          </ActionIcon>
        )}
      </Group>
    </div>
  );
}
