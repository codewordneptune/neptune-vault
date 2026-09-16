import { Button, Divider, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { IconFingerprint } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

// The passkey sheet opens by itself once per page load; after that the
// button is there for a retry, and the password field for the fallback.
let promptedThisLoad = false;

/** A cancelled or timed-out system sheet is not an error to show. */
function isCancellation(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  const message = (e as Error).message ?? '';
  return name === 'NotAllowedError' || name === 'AbortError' || /cancel/i.test(message);
}

import { useApp } from '../app/AppContext';
import { walletName } from '../storage/db';
import { WrongPasswordError } from '../storage/envelope';
import { NETWORK_LABELS } from '../util/network';

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
      if (!isCancellation(e)) setError((e as Error).message);
      inputRef.current?.focus();
    } finally {
      setPasskeyBusy(false);
    }
  };

  useEffect(() => {
    if (hasPasskey && !promptedThisLoad) {
      promptedThisLoad = true;
      void unlockWithPasskey();
    }
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
          {account && (
            <Text size="sm" c="dimmed">
              {walletName(account)} · {NETWORK_LABELS[account.network]}
            </Text>
          )}
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
            autoFocus={!hasPasskey}
          />
          <Button type="submit" variant={hasPasskey ? 'light' : 'filled'} loading={busy} disabled={!password}>
            Unlock
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
