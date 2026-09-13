import { Button, Divider, Paper, PasswordInput, Stack, Title } from '@mantine/core';
import { IconFingerprint } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/AppContext';
import { WrongPasswordError } from '../storage/envelope';

export function Unlock() {
  const { services, account } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const hasPasskey = Boolean(account?.passkey);

  const unlockWithPasskey = async () => {
    if (!account) return;
    setPasskeyBusy(true);
    setError(null);
    try {
      await services.accounts.unlockWithPasskey(account.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Offer the passkey straight away; the password field stays for fallback.
  useEffect(() => {
    if (hasPasskey) void unlockWithPasskey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);


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
          {hasPasskey && (
            <>
              <Button leftSection={<IconFingerprint size={18} stroke={1.8} />} loading={passkeyBusy} onClick={() => void unlockWithPasskey()}>
                Unlock with passkey
              </Button>
              <Divider label="or use the password" labelPosition="center" />
            </>
          )}
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
          <Button type="submit" variant={hasPasskey ? 'light' : 'filled'} loading={busy} disabled={!password}>
            Unlock
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
