import { Badge, Button, Divider, Group, Menu, Paper, PasswordInput, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFingerprint } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

// The passkey sheet opens by itself once per page load; after that the
// button is there for a retry, and the password field for the fallback.
let promptedThisLoad = false;

import { useApp } from '../app/AppContext';
import { NewPasswordFields, newPasswordOk } from '../components/NewPasswordFields';
import { ErrorLine } from '../components/Notice';
import { PhraseField, phraseWords } from '../components/PhraseField';
import { Sheet } from '../components/Sheet';
import { isCancellation } from '../app/passkey';
import { NATIVE } from '../app/platform';
import { byCreation, walletName, type AccountRecord } from '../storage/db';
import { UnlockCancelledError } from '../app/accounts';
import { WrongPasswordError, WrongPhraseError } from '../storage/envelope';
import { NETWORK_LABELS } from '../util/network';

export function Unlock() {
  const { services, account, switchAccount, sendJob } = useApp();
  // During a send the wallet stays as it is: another is not offered.
  const sending = Boolean(sendJob && !sendJob.done);
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
  const [forgot, setForgot] = useState(false);

  const unlockWithPasskey = async () => {
    if (!account) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    const asked = Date.now();
    try {
      await services.accounts.unlockWithPasskey(account.id);
      // It works again: the sheet may open by itself again.
      const quiet = services.settings.passkeyQuiet ?? [];
      if (quiet.includes(account.id)) void services.updateSettings({ passkeyQuiet: quiet.filter((id) => id !== account.id) });
    } catch (e) {
      if (isCancellation(e) && Date.now() - asked < 1500) {
        // Refused before anyone could have answered: the device did not offer
        // the passkey (it was removed from it), which looks like a cancel.
        setPasskeyError('This device did not offer the passkey. Unlock with the password, then turn passkey unlock off in Settings, or set it up again.');
        const quiet = services.settings.passkeyQuiet ?? [];
        if (!quiet.includes(account.id)) void services.updateSettings({ passkeyQuiet: [...quiet, account.id] });
      } else if (!isCancellation(e) && !(e instanceof UnlockCancelledError)) setPasskeyError((e as Error).message);
      inputRef.current?.focus();
    } finally {
      setPasskeyBusy(false);
    }
  };

  useEffect(() => {
    if (hasPasskey && !promptedThisLoad && !(services.settings.passkeyQuiet ?? []).includes(account?.id ?? '')) {
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
              <Text size="sm" c="dimmed">
                Welcome back
              </Text>
              {account && (
                <Title order={2} ta="center" className="vault-lock-name">
                  <bdi>{walletName(account)}</bdi>
                </Title>
              )}
              {/* Mainnet goes without saying; a test network is named, in its own colour. */}
              {account && account.network !== 'main' && (
                <Badge variant="light" color="yellow" radius="sm" className="vault-tag vault-test-tag">
                  {NETWORK_LABELS[account.network]}
                </Badge>
              )}
            </Stack>
            {hasPasskey && (
              <>
                <Button leftSection={<IconFingerprint size={16} />} loading={passkeyBusy} onClick={() => void unlockWithPasskey()}>
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
              // Said as it appears: after Enter, focus is already in the field, and moving it there again says nothing.
              errorProps={{ role: 'alert' }}
              autoComplete="current-password"
              autoFocus={!hasPasskey}
            />
            <Button type="submit" variant={hasPasskey ? 'light' : 'filled'} loading={busy} disabled={!password}>
              Unlock
            </Button>
            <Stack gap={4}>
              {account && (
                <UnstyledButton className="vault-lock-other" onClick={() => setForgot(true)}>
                  Forgot the password?
                </UnstyledButton>
              )}
              {others.length > 0 && !sending && (
                <Menu position="bottom" width={240}>
                  <Menu.Target>
                    <UnstyledButton className="vault-lock-other">Not this wallet?</UnstyledButton>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>{account && account.network !== 'main' ? `Other wallets on ${NETWORK_LABELS[account.network]}` : 'Other wallets'}</Menu.Label>
                    {others.map((a) => (
                      <Menu.Item key={a.id} onClick={() => void switchAccount(a.id)}>
                        <bdi>{walletName(a)}</bdi>
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}
            </Stack>
          </Stack>
        </form>
      </Paper>
      {account && <ForgotPassword key={account.id} account={account} opened={forgot} onClose={() => setForgot(false)} />}
    </div>
  );
}

// For a forgotten password: the seed phrase proves the wallet is this
// person's, and a new password replaces the old one. The wallet's data, its
// passkey and its settings stay as they are.
function ForgotPassword({ account, opened, onClose }: { account: AccountRecord; opened: boolean; onClose: () => void }) {
  const { services } = useApp();
  // Read from the database, not taken from the record on screen: that may
  // be from before the unlock that wrapped the content key under the phrase.
  const [canReset, setCanReset] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void services.db.get('accounts', account.id).then(
      (record) => live && setCanReset(Boolean(record?.seedUnlock)),
      () => live && setCanReset(true),
    );
    return () => {
      live = false;
    };
  }, [services, account.id, opened]);
  const [step, setStep] = useState<'phrase' | 'password'>('phrase');
  const [text, setText] = useState('');
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = phraseWords(text);

  // Closing forgets what was typed, the words above all.
  const close = () => {
    onClose();
    setStep('phrase');
    setText('');
    setPhraseError(null);
    setPassword('');
    setAgain('');
    setError(null);
  };

  const checkPhrase = async () => {
    setBusy(true);
    try {
      const problem = await services.core.phraseProblem(words);
      if (problem) {
        setPhraseError(problem);
        return;
      }
      await services.accounts.checkSeedPhrase(account.id, words);
      setStep('password');
    } catch (e) {
      setPhraseError(e instanceof WrongPhraseError ? "These words are not this wallet's seed phrase." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await services.accounts.resetPassword(account.id, words, password);
      notifications.show({ message: 'Password changed. An older backup file still opens with the old password, so export a new one if you keep one.', autoClose: 10_000 });
      close();
    } catch (e) {
      // Overtaken by a lock after the new password was set: it stays set, and the wallet locked.
      if (e instanceof UnlockCancelledError) {
        notifications.show({ message: 'Password changed. Unlock with the new one.', autoClose: 10_000 });
        close();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet opened={opened} onClose={close} title={canReset === false ? 'Forgot the password?' : 'Set a new password'}>
      {canReset === false && (
        <Stack>
          <Text size="sm">This wallet was last unlocked by an older version of the app, so its seed phrase cannot unlock it here.</Text>
          {account.passkey && <Text size="sm">Unlock it with the passkey instead. From then on, the seed phrase can set a new password here.</Text>}
          <Text size="sm">Your money is not lost: restore the seed phrase {NATIVE ? 'in the web app or on another device' : 'in another browser or on another device'} to reach it.</Text>
          <Button onClick={close}>Close</Button>
        </Stack>
      )}
      {canReset && step === 'phrase' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void checkPhrase();
          }}
        >
          <Stack>
            <Text size="sm" c="dimmed">
              Enter this wallet's seed phrase to choose a new password. Everything else stays as it is.
            </Text>
            <PhraseField text={text} onText={setText} error={phraseError} onError={setPhraseError} checkPhrase={(w) => services.core.phraseProblem(w)} autoFocus />
            <Group grow>
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={words.length !== 18}>
                Continue
              </Button>
            </Group>
          </Stack>
        </form>
      )}
      {canReset && step === 'password' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <Stack>
            <Text size="sm" c="dimmed">
              Seed phrase confirmed. Choose a new password for this wallet.
            </Text>
            <NewPasswordFields password={password} onPassword={setPassword} again={again} onAgain={setAgain} label="New password (at least 8 characters)" repeatLabel="Repeat new password" autoFocus />
            <Group grow>
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!newPasswordOk(password, again)}>
                Save
              </Button>
            </Group>
            {error && <ErrorLine onClose={() => setError(null)}>{error}</ErrorLine>}
          </Stack>
        </form>
      )}
    </Sheet>
  );
}
