// Network, node URL with connectivity check, backup actions, lock (F20 to F22).

import { Alert, Button, Group, Paper, PasswordInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconDownload, IconEye, IconKey, IconLock } from '@tabler/icons-react';
import { useState } from 'react';

import { useApp } from '../app/AppContext';
import { WrongPasswordError } from '../storage/envelope';
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
          <Title order={3}>Security</Title>
          <Text size="sm" c="dimmed">
            The password encrypts your phrase on this device and is asked for on every unlock. Changing it does not change the phrase or the backup file's contents beyond the new wrapping.
          </Text>
          <ChangePassword />
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

function ChangePassword() {
  const { services, account } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const mismatch = again !== '' && again !== next;
  const tooShort = next !== '' && next.length < 8;

  const submit = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await services.accounts.changePassword(account.id, current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'The current password is wrong.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        {done && <Alert color="green" withCloseButton onClose={() => setDone(false)}>Password changed. Export a new backup file if you keep one; the old file still opens with the old password.</Alert>}
        {error && <Alert color="red" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
        <PasswordInput label="Current password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
        <PasswordInput label="New password (at least 8 characters)" value={next} onChange={(e) => setNext(e.currentTarget.value)} error={tooShort ? 'At least 8 characters' : undefined} autoComplete="new-password" />
        <PasswordInput label="Repeat new password" value={again} onChange={(e) => setAgain(e.currentTarget.value)} error={mismatch ? 'Passwords differ' : undefined} autoComplete="new-password" />
        <Button type="submit" variant="light" leftSection={<IconKey size={16} stroke={1.8} />} loading={busy} disabled={!account || !current || next.length < 8 || next !== again}>
          Change password
        </Button>
      </Stack>
    </form>
  );
}
