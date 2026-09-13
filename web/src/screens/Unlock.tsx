import { Alert, Button, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';

import { useApp } from '../app/AppContext';
import { abbreviateAddress } from '../util/address';
import { WrongPasswordError } from '../storage/envelope';

export function Unlock() {
  const { services, account } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <Title order={2}>Unlock</Title>
          <Text size="sm" c="dimmed">
            {account?.network} account, {account ? abbreviateAddress(account.address0) : ''}
          </Text>
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
