import { Alert, Button, Paper, PasswordInput, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';

import { useApp } from '../app/AppContext';
import { abbreviateAddress } from '../util/address';
import { networkLabel } from '../util/network';
import { WrongPasswordError } from '../storage/envelope';

export function Unlock() {
  const { services, account } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The unlock screen doubles as a quick way to grab the main address.
  const copyAddress = async () => {
    if (!account) return;
    await navigator.clipboard.writeText(account.address0);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const unlock = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await services.accounts.unlock(account.id, password);
      setPassword('');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
      >
        <Stack>
          <Title order={2}>Welcome back</Title>
          <Text size="sm" c="dimmed">
            Enter your password to unlock your {networkLabel(account?.network)} wallet.
          </Text>
          {account && (
            <UnstyledButton onClick={() => void copyAddress()} aria-label="Copy the main address" fz="xs" c="dimmed">
              <Text component="span" size="xs" c="dimmed">
                Address{' '}
              </Text>
              <Text component="span" size="xs" ff="monospace" c="dimmed">
                {abbreviateAddress(account.address0)}
              </Text>
              {copied ? <IconCheck size={13} style={{ marginLeft: 6, verticalAlign: -2 }} /> : <IconCopy size={13} style={{ marginLeft: 6, verticalAlign: -2 }} />}
            </UnstyledButton>
          )}
          {error && <Alert color="red">{error}</Alert>}
          <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoFocus />
          <Button type="submit" loading={busy} disabled={!password}>
            Unlock
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
