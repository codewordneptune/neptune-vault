import { Button, Paper, PasswordInput, Stack, Title } from '@mantine/core';
import { useRef, useState } from 'react';

import { useApp } from '../app/AppContext';
import { WrongPasswordError } from '../storage/envelope';

export function Unlock() {
  const { services, account } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);


  const unlock = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await services.accounts.unlock(account.id, password);
      setPassword('');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
      setPassword('');
      inputRef.current?.focus();
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
          <PasswordInput
            ref={inputRef}
            label="Password"
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
              setError(null);
            }}
            error={error}
            autoFocus
          />
          <Button type="submit" loading={busy} disabled={!password}>
            Unlock
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
