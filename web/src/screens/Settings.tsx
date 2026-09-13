// Network, node URL with connectivity check, backup actions, lock (F20 to F22).

import { Alert, Button, Group, Paper, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import { useApp } from '../app/AppContext';
import type { Network } from '../storage/db';

export function Settings() {
  const { services, account, setAccount } = useApp();
  const [network, setNetwork] = useState<Network>(services.settings.network);
  const [nodeUrl, setNodeUrl] = useState(services.settings.nodeUrls[network] ?? '');
  const [probe, setProbe] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const changeNetwork = async (value: string | null) => {
    if (!value) return;
    const next = value as Network;
    setNetwork(next);
    setNodeUrl(services.settings.nodeUrls[next] ?? '');
    await services.updateSettings({ network: next, currentAccountId: null });
    await services.accounts.lock();
    const all = await services.db.getAllFromIndex('accounts', 'byNetwork', next);
    setAccount(all[0] ?? null);
  };

  const saveNode = async () => {
    await services.updateSettings({ nodeUrls: { ...services.settings.nodeUrls, [network]: nodeUrl.trim() } });
    setMessage('Node URL saved.');
  };

  const testNode = async () => {
    setProbe('testing…');
    try {
      const { NodeClient } = await import('../node/rpc');
      const height = await new NodeClient(nodeUrl.trim()).probe();
      setProbe(`Reachable, tip height ${height}`);
    } catch (e) {
      setProbe(`Failed: ${(e as Error).message}. The node must send CORS headers for a browser to reach it.`);
    }
  };

  const exportBackup = async () => {
    if (!account) return;
    const file = await services.accounts.exportFile(account.id);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neptune-vault-${account.network}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showPhrase = async () => {
    // The phrase is only in the worker; ask it back via the account record's
    // envelope by re-deriving is not possible without the password, so the
    // worker exposes it directly while unlocked.
    setPhrase(await services.core.phrase());
  };

  return (
    <Stack gap="md">
      {message && <Alert color="teal" onClose={() => setMessage(null)} withCloseButton>{message}</Alert>}
      <Paper withBorder p="md">
        <Stack>
          <Title order={4}>Network and node</Title>
          <Select label="Network" data={['main', 'testnet', 'regtest']} value={network} onChange={(v) => void changeNetwork(v)} />
          <TextInput label="Node URL" value={nodeUrl} onChange={(e) => setNodeUrl(e.currentTarget.value)} placeholder="https://…" />
          <Group>
            <Button size="xs" onClick={() => void saveNode()}>Save</Button>
            <Button size="xs" variant="light" onClick={() => void testNode()}>Test connection</Button>
          </Group>
          {probe && <Text size="sm">{probe}</Text>}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack>
          <Title order={4}>Backup</Title>
          <Text size="sm" c="dimmed">
            Persistent storage {services.persistent ? 'granted' : 'not granted'}. Clearing the browser's site data deletes this wallet; keep the phrase or a backup file.
          </Text>
          <Group>
            <Button size="xs" onClick={() => void exportBackup()} disabled={!account}>Export backup file</Button>
            <Button size="xs" variant="light" onClick={() => void showPhrase()} disabled={!account}>Show seed phrase</Button>
          </Group>
          {phrase && (
            <SimpleGrid cols={3} spacing="xs">
              {phrase.map((w, i) => (
                <Text key={i} ff="monospace" size="sm">{i + 1}. {w}</Text>
              ))}
            </SimpleGrid>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack>
          <Title order={4}>Session</Title>
          <Text size="sm" c="dimmed">Locks after 5 minutes idle and when the app goes to the background.</Text>
          <Button size="xs" color="red" variant="light" onClick={() => void services.accounts.lock()}>Lock now</Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
