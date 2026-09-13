// Network, node URL with connectivity check, backup actions, lock (F20 to F22).

import { Alert, Button, Group, Paper, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconDownload, IconEye, IconLock } from '@tabler/icons-react';
import { useState } from 'react';

import { useApp } from '../app/AppContext';
import { WordGrid } from '../components/WordGrid';
import { NETWORK_OPTIONS } from '../util/network';
import type { Network } from '../storage/db';

export function Settings() {
  const { services, account, network, switchNetwork } = useApp();
  const [nodeUrl, setNodeUrl] = useState(services.settings.nodeUrls[network] ?? '');
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const changeNetwork = async (value: string | null) => {
    if (!value) return;
    const next = value as Network;
    setNodeUrl(services.settings.nodeUrls[next] ?? '');
    await switchNetwork(next);
  };

  const saveNode = async () => {
    await services.updateSettings({ nodeUrls: { ...services.settings.nodeUrls, [network]: nodeUrl.trim() } });
    setMessage('Node URL saved.');
  };

  const testNode = async () => {
    setProbe({ ok: true, text: 'Testing…' });
    try {
      const { NodeClient } = await import('../node/rpc');
      const height = await new NodeClient(nodeUrl.trim()).probe();
      setProbe({ ok: true, text: `Reachable, tip height ${height}` });
    } catch (e) {
      setProbe({ ok: false, text: (e as Error).message });
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
      <Title order={2} className="sr-only">
        Settings
      </Title>
      {message && <Alert color="green" onClose={() => setMessage(null)} withCloseButton>{message}</Alert>}
      <Paper>
        <Stack>
          <Title order={3}>Network and node</Title>
          <Select label="Network" data={NETWORK_OPTIONS} value={network} onChange={(v) => void changeNetwork(v)} />
          <TextInput label="Node URL" value={nodeUrl} onChange={(e) => setNodeUrl(e.currentTarget.value)} placeholder="https://…" />
          <Group>
            <Button onClick={() => void saveNode()}>Save</Button>
            <Button variant="light" onClick={() => void testNode()}>Test connection</Button>
          </Group>
          {probe && (
            <Text size="sm" c={probe.ok ? 'dimmed' : 'red'}>
              {probe.text}
            </Text>
          )}
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3}>Backup</Title>
          <Text size="sm" c="dimmed">
            Persistent storage {services.persistent ? 'granted' : 'not granted'}. Clearing the browser's site data deletes this wallet; keep the phrase or a backup file.
          </Text>
          <Group>
            <Button leftSection={<IconDownload size={16} stroke={1.8} />} onClick={() => void exportBackup()} disabled={!account}>Export backup file</Button>
            <Button variant="light" leftSection={<IconEye size={16} stroke={1.8} />} onClick={() => void showPhrase()} disabled={!account}>Show seed phrase</Button>
          </Group>
          {phrase && <WordGrid words={phrase} />}
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3}>Session</Title>
          <Text size="sm" c="dimmed">Locks after 5 minutes idle and when the app goes to the background.</Text>
          <Button variant="light" leftSection={<IconLock size={16} stroke={1.8} />} onClick={() => void services.accounts.lock()}>Lock now</Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
