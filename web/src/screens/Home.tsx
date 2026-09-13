// Balance, sync status and history (F13, F14, R18).

import { Badge, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';

import { formatNau, useApp } from '../app/AppContext';

export function Home() {
  const { balance, sync, history, syncNow, services, refresh, account } = useApp();

  const forget = async (txid: string) => {
    if (!account) return;
    await services.sendService(account.id).forget(txid);
    await refresh();
  };

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">Spendable balance</Text>
          <Title order={1}>{formatNau(balance.spendableNau)} NPT</Title>
          {balance.reservedNau > 0n && (
            <Text size="sm" c="dimmed">
              {formatNau(balance.reservedNau)} NPT reserved by pending sends
            </Text>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Group justify="space-between">
          <Text size="sm">
            {sync === null && 'Not synced yet'}
            {sync?.phase === 'checking' && 'Checking chain…'}
            {sync?.phase === 'scanning' && `Scanning block ${sync.syncedHeight} of ${sync.tipHeight}`}
            {sync?.phase === 'done' && `Synced to block ${sync.syncedHeight}`}
            {sync?.phase === 'error' && `Sync failed: ${sync.message}`}
          </Text>
          <Button size="xs" variant="light" onClick={() => void syncNow()}>
            Sync now
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md">
        <Title order={4} mb="sm">
          History
        </Title>
        {history.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing yet.
          </Text>
        ) : (
          <Table verticalSpacing="xs">
            <Table.Tbody>
              {history.map((h) => (
                <Table.Tr key={h.key}>
                  <Table.Td>
                    <Text size="sm">{h.kind === 'received' ? 'Received' : 'Sent'}</Text>
                    <Text size="xs" c="dimmed">
                      {new Date(h.timestampMs).toLocaleString()}
                      {h.height !== null && ` · block ${h.height}`}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm">
                      {h.kind === 'received' ? '+' : '-'}
                      {formatNau(BigInt(h.amountNau))}
                    </Text>
                    <Badge size="xs" color={h.status === 'confirmed' ? 'teal' : h.status === 'pending' ? 'yellow' : 'red'} variant="light">
                      {h.status}
                    </Badge>
                    {h.kind === 'sent' && h.status === 'pending' && (
                      <Button size="compact-xs" variant="subtle" ml="xs" onClick={() => void forget(h.txid)}>
                        forget
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
