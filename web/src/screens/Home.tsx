// Balance, sync status and history (F13, F14, R18).

import { Alert, Badge, Button, Group, Modal, Paper, Stack, Text, Title } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HistoryRecord } from '../storage/db';

import { formatNau, useApp } from '../app/AppContext';

export function Home() {
  const { balance, sync, history, utxos, syncNow, services, refresh, account } = useApp();
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

  const syncText =
    sync === null
      ? 'Not synced yet'
      : sync.phase === 'checking'
        ? 'Checking chain…'
        : sync.phase === 'scanning'
          ? `Scanning block ${sync.syncedHeight} of ${sync.tipHeight}`
          : sync.phase === 'done'
            ? `Synced to block ${sync.syncedHeight}`
            : `Sync failed: ${sync.message}`;

  return (
    <Stack gap="md">
      <Title order={2} className="sr-only">
        Home
      </Title>
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
          <span className="vault-eyebrow">Spendable balance</span>
          <div className="vault-balance">
            {formatNau(balance.spendableNau)}
            <small>NPT</small>
          </div>
          {balance.reservedNau > 0n && (
            <Text size="sm" c="dimmed">
              {formatNau(balance.reservedNau)} NPT is held by a pending send. It stays held until the network includes the transaction, usually within a few blocks; then the change comes back as spendable.
            </Text>
          )}
          <Group justify="space-between" mt="xs">
            <Text size="sm" c={sync?.phase === 'error' ? 'red' : 'dimmed'}>
              {syncText}
            </Text>
            <Button size="compact-sm" variant="subtle" leftSection={<IconRefresh size={16} stroke={1.8} />} onClick={() => void syncNow()}>
              Sync
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper>
        <Title order={3} mb="sm">
          History
        </Title>
        {history.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing yet. Share a receiving address to get started.
          </Text>
        ) : (
          <div>
            {history.map((h) => {
              const received = h.kind === 'received';
              return (
                <div className="vault-row" key={h.key}>
                  <Group gap="sm" wrap="nowrap">
                    <span className={`vault-row-icon${received ? '' : ' out'}`}>
                      {received ? <IconArrowDownLeft size={18} stroke={1.8} /> : <IconArrowUpRight size={18} stroke={1.8} />}
                    </span>
                    <div>
                      <Text size="sm" fw={500}>
                        {received ? 'Received' : 'Sent'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {new Date(h.timestampMs).toLocaleString()}
                        {h.height !== null && ` · block ${h.height}`}
                      </Text>
                    </div>
                  </Group>
                  <div style={{ textAlign: 'right' }}>
                    <Text size="sm" fw={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {received ? '+' : '−'}
                      {formatNau(BigInt(h.amountNau))}
                    </Text>
                    <Group gap={6} justify="flex-end">
                      <Badge size="xs" color={h.status === 'confirmed' ? 'green' : h.status === 'pending' ? 'yellow' : 'red'}>
                        {h.status}
                      </Badge>
                      {h.kind === 'sent' && h.status === 'pending' && (
                        <Button size="compact-xs" variant="subtle" onClick={() => setGivingUp(h)}>
                          Give up
                        </Button>
                      )}
                    </Group>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Paper>

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
