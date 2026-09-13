// Balance, sync status and history (F13, F14, R18).

import { Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconRefresh } from '@tabler/icons-react';

import { formatNau, useApp } from '../app/AppContext';

export function Home() {
  const { balance, sync, history, syncNow, services, refresh, account } = useApp();

  const forget = async (txid: string) => {
    if (!account) return;
    await services.sendService(account.id).forget(txid);
    await refresh();
  };

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
      <Paper>
        <Stack gap="xs">
          <span className="vault-eyebrow">Spendable balance</span>
          <div className="vault-balance">
            {formatNau(balance.spendableNau)}
            <small>NPT</small>
          </div>
          {balance.reservedNau > 0n && (
            <Text size="sm" c="dimmed">
              {formatNau(balance.reservedNau)} NPT reserved by pending sends
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
                        <Button size="compact-xs" variant="subtle" onClick={() => void forget(h.txid)}>
                          forget
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
    </Stack>
  );
}
