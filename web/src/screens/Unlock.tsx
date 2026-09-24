import { Badge, Button, Divider, Menu, Paper, PasswordInput, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconFingerprint } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

// The passkey sheet opens by itself once per page load; after that the
// button is there for a retry, and the password field for the fallback.
let promptedThisLoad = false;

/** A cancelled or timed-out system sheet is not an error to show. Settings asks the same when a passkey is set up. */
export function isCancellation(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  const message = (e as Error).message ?? '';
  return name === 'NotAllowedError' || name === 'AbortError' || /cancel/i.test(message);
}

import { useApp } from '../app/AppContext';
import { Logo } from '../components/Logo';
import { byCreation, walletName, type AccountRecord } from '../storage/db';
import { UnlockCancelledError } from '../app/accounts';
import { WrongPasswordError } from '../storage/envelope';
import { NETWORK_LABELS } from '../util/network';

export function Unlock() {
  const { services, account, switchAccount } = useApp();
  // The other wallets on this network, for "Not this wallet?".
  const [others, setOthers] = useState<AccountRecord[]>([]);
  useEffect(() => {
    if (!account) return;
    void services.db.getAll('accounts').then((all) => setOthers(byCreation(all).filter((a) => a.network === account.network && a.id !== account.id)));
  }, [services, account]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // A passkey that failed is said under its button: it is not the password field's error.
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const hasPasskey = Boolean(account?.passkey);

  const unlockWithPasskey = async () => {
    if (!account) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await services.accounts.unlockWithPasskey(account.id);
    } catch (e) {
      if (!isCancellation(e) && !(e instanceof UnlockCancelledError)) setPasskeyError((e as Error).message);
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
      // Overtaken by a lock (another wallet picked, or the app hidden): the screen that follows says enough.
      if (!(e instanceof UnlockCancelledError)) setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
      // What was typed stays, selected: retyping replaces it, and one slip can
      // be fixed where it is instead of typing the whole password again.
      inputRef.current?.focus();
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vault-lock">
      <Paper className="vault-lock-card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <Stack>
            <Stack gap={6} align="center">
              <Logo size={40} />
              <Text size="sm" c="dimmed">
                Welcome back
              </Text>
              {account && (
                <Title order={2} ta="center" className="vault-lock-name">
                  {walletName(account)}
                </Title>
              )}
              {account && (
                <Badge variant="light" color="gray" radius="sm" className="vault-tag">
                  {NETWORK_LABELS[account.network]}
                </Badge>
              )}
            </Stack>
            {hasPasskey && (
              <>
                <Button leftSection={<IconFingerprint size={18} stroke={1.8} />} loading={passkeyBusy} onClick={() => void unlockWithPasskey()}>
                  Unlock with passkey
                </Button>
                {passkeyError && (
                  <Text size="sm" c="var(--v-danger-text)" role="alert">
                    {passkeyError}
                  </Text>
                )}
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
            {others.length > 0 && (
              <Menu position="bottom" width={240} radius="md" shadow="md">
                <Menu.Target>
                  <UnstyledButton className="vault-lock-other">Not this wallet?</UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Other wallets on {account ? NETWORK_LABELS[account.network] : ''}</Menu.Label>
                  {others.map((a) => (
                    <Menu.Item key={a.id} onClick={() => void switchAccount(a.id)}>
                      {walletName(a)}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            )}
          </Stack>
        </form>
      </Paper>
    </div>
  );
}
