// Network, node URL with connectivity check, backup actions, lock (F20 to F22).

import { Alert, Anchor, Button, Checkbox, Group, Modal, Paper, PasswordInput, SegmentedControl, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconDeviceMobile, IconDownload, IconInfoCircle, IconLock, IconPlugConnected, IconShieldCheck, IconWallet } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { showBlock, useApp } from '../app/AppContext';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { LINKS } from '../app/links';
import { requestPersistentStorage, walletName } from '../storage/db';
import { WrongPasswordError } from '../storage/envelope';
import { StartBlockPicker } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { NETWORK_OPTIONS } from '../util/network';
import type { Network } from '../storage/db';

export function Settings() {
  const { services, account, network, switchNetwork, refresh } = useApp();
  const navigate = useNavigate();
  const lastBackup = account?.lastBackupAt ? new Date(account.lastBackupAt).toLocaleString() : 'never';
  const [nodeUrl, setNodeUrl] = useState(services.settings.nodeUrls[network] ?? '');
  const [probe, setProbe] = useState<{ ok: boolean; text: string; at?: number } | null>(services.settings.nodeProbe?.[network] ?? null);
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const changeNetwork = async (value: string | null) => {
    if (!value) return;
    const next = value as Network;
    setNodeUrl(services.settings.nodeUrls[next] ?? '');
    setProbe(services.settings.nodeProbe?.[next] ?? null);
    await switchNetwork(next);
  };

  // Saving is explicit; the test result is kept per network.
  const testNode = async () => {
    setProbe({ ok: true, text: 'Testing…' });
    let result: { ok: boolean; text: string; at: number };
    try {
      const { NodeClient } = await import('../node/rpc');
      const height = await new NodeClient(nodeUrl.trim()).probe();
      result = { ok: true, text: `Reachable, tip height ${showBlock(height)}`, at: Date.now() };
    } catch (e) {
      result = { ok: false, text: (e as Error).message, at: Date.now() };
    }
    setProbe(result);
    await services.updateSettings({ nodeProbe: { ...services.settings.nodeProbe, [network]: result } });
  };

  const savedUrl = services.settings.nodeUrls[network] ?? '';
  const dirty = nodeUrl.trim() !== savedUrl;
  const saveAndTestNode = async () => {
    await services.updateSettings({ nodeUrls: { ...services.settings.nodeUrls, [network]: nodeUrl.trim() } });
    await testNode();
  };

  const exportBackup = async () => {
    if (!account) return;
    const file = await services.accounts.exportFile(account.id);
    await services.accounts.markBackedUp(account.id, file.exportedAt);
    await refresh();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = walletName(account).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    a.download = `neptune-vault-${account.network}-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The phrase lives only in the worker while unlocked; it is fetched on
  // show and dropped from this screen on hide, after a minute at most, and
  // as soon as the app goes to the background or this screen is left.
  const PHRASE_SECONDS = 60;
  const [phraseLeft, setPhraseLeft] = useState(PHRASE_SECONDS);
  const togglePhrase = async () => {
    setPhrase(phrase ? null : await services.core.phrase());
  };
  useEffect(() => {
    if (!phrase) return;
    setPhraseLeft(PHRASE_SECONDS);
    const tick = setInterval(() => setPhraseLeft((n) => n - 1), 1000);
    const onVisibility = () => {
      if (document.hidden) setPhrase(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phrase]);
  useEffect(() => {
    if (phrase && phraseLeft <= 0) setPhrase(null);
  }, [phrase, phraseLeft]);

  // Without persistent storage the browser may evict the wallet's data when
  // space runs low. The first request happens at start-up; this one is the
  // person's, which browsers weigh more.
  const [persistent, setPersistent] = useState(services.persistent);
  const [persistAsked, setPersistAsked] = useState(false);
  const requestPersistent = async () => {
    const granted = await requestPersistentStorage();
    services.persistent = granted;
    setPersistent(granted);
    setPersistAsked(true);
  };

  return (
    <Stack gap="md">
      <Title order={2} className="sr-only">
        Settings
      </Title>
      {message && <Alert color="green" onClose={() => setMessage(null)} withCloseButton>{message}</Alert>}
      <WalletCard />
      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconShieldCheck size={18} stroke={1.8} aria-hidden />
            Backup
          </Title>
          {persistent ? (
            <Text size="sm" c="dimmed">
              Persistent storage is granted, so the browser will not evict this wallet's data on its own. Clearing the browser's site data still deletes it; keep the phrase or a backup file.
            </Text>
          ) : (
            <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="The browser may evict this wallet">
              <Text size="sm">
                The browser has not granted persistent storage, so it can delete this wallet's data when space runs low, without asking. Browsers grant it on their own once the app is installed or has been opened regularly. A backup file or the phrase restores everything.
              </Text>
              <Group mt="xs" gap="sm" align="center">
                <Button size="sm" variant="default" className="vault-tap" onClick={() => void requestPersistent()}>
                  Request again
                </Button>
                {persistAsked && (
                  <Text size="xs" c="dimmed">
                    Still not granted.
                  </Text>
                )}
              </Group>
            </Alert>
          )}
          <Text size="sm" c={account?.lastBackupAt ? 'dimmed' : 'yellow'}>
            Last backup file: {lastBackup}
          </Text>
          <Group>
            <Button leftSection={<IconDownload size={16} stroke={1.8} />} onClick={() => void exportBackup()} disabled={!account}>Export backup file</Button>
            <Button variant="light" onClick={() => void togglePhrase()} disabled={!account}>
              {phrase ? 'Hide seed phrase' : 'Show seed phrase'}
            </Button>
          </Group>
          {phrase && (
            <Stack gap="xs">
              <WordGrid words={phrase} />
              <Group justify="space-between" align="center">
                <Button variant="subtle" size="compact-sm" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                  Copy words
                </Button>
                <Text size="xs" c="dimmed">
                  Other apps can read the clipboard; clear it afterwards.
                </Text>
              </Group>
              <Text size="xs" c="dimmed" aria-live="off">
                Hidden again in {Math.max(0, phraseLeft)} s, or when you leave this screen.
              </Text>
            </Stack>
          )}
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconLock size={18} stroke={1.8} aria-hidden />
            Security
          </Title>
          <Text size="sm" c="dimmed">
            The password encrypts your phrase on this device and is asked for on every unlock. Changing it does not change the phrase or the backup file's contents beyond the new wrapping.
          </Text>
          <ChangePassword />
          <PasskeyCard />
          <Text size="sm" c="dimmed">
            Locks after 5 minutes idle and when the app goes to the background.
          </Text>
          <Group>
            <Button variant="light" onClick={() => void services.accounts.lock()}>
              Lock now
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconPlugConnected size={18} stroke={1.8} aria-hidden />
            Network and node
          </Title>
          <Select label="Network" data={NETWORK_OPTIONS} value={network} onChange={(v) => void changeNetwork(v)} />
          <TextInput label="Node URL" value={nodeUrl} onChange={(e) => setNodeUrl(e.currentTarget.value)} placeholder="https://…" />
          {probe && (
            <Text size="sm" c={probe.ok ? 'dimmed' : 'red'}>
              {probe.text}
              {probe.at && probe.text !== 'Testing…' ? ` · checked ${new Date(probe.at).toLocaleTimeString()}` : ''}
            </Text>
          )}
          <Group>
            <Button onClick={() => void saveAndTestNode()} disabled={!dirty}>
              Save and test
            </Button>
            <Button variant="light" onClick={() => void testNode()} disabled={dirty}>
              Test
            </Button>
          </Group>
          <RescanCard />
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconDeviceMobile size={18} stroke={1.8} aria-hidden />
            App
          </Title>
          <InstallCard />
          <Text size="sm" c="dimmed">
            Diagnostics show cores, threads and the install state, useful when reporting a problem.
          </Text>
          <Group>
            <Button variant="light" onClick={() => navigate('/diagnostics')}>
              Diagnostics
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconInfoCircle size={18} stroke={1.8} aria-hidden />
            About
          </Title>
          <Text size="sm" c="dimmed">
            Neptune Vault is a wallet for Neptune Cash that runs entirely in your browser: keys never leave this device, and the app talks only to the node you choose. It is a proof of concept and not recommended for production use: no audit, breaking changes ahead, use only with amounts you can afford to lose.
          </Text>
          <Group gap="md">
            <Anchor href={LINKS.issues} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Report a problem
            </Anchor>
            <Anchor href={LINKS.project} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Community
            </Anchor>
            <Anchor href={LINKS.neptune} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              About Neptune Cash
            </Anchor>
            <Anchor component="button" type="button" size="sm" className="vault-tap-link" onClick={() => navigate('/privacy')}>
              Privacy
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            Version {__APP_VERSION__} ({__APP_COMMIT__}), built {new Date(__APP_BUILT_AT__).toLocaleDateString()}. Quote the version when reporting a problem.
          </Text>
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
  const [open, setOpen] = useState(false);
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
      setOpen(false);
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'The current password is wrong.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Stack>
        {done && <Alert color="green" withCloseButton onClose={() => setDone(false)}>Password changed. Export a new backup file if you keep one; the old file still opens with the old password.</Alert>}
        <Group>
          <Button variant="light" disabled={!account} onClick={() => { setDone(false); setOpen(true); }}>
            Change password
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        {error && <Alert color="red" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
        <PasswordInput label="Current password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
        <PasswordInput label="New password (at least 8 characters)" value={next} onChange={(e) => setNext(e.currentTarget.value)} error={tooShort ? 'At least 8 characters' : undefined} autoComplete="new-password" />
        <PasswordInput label="Repeat new password" value={again} onChange={(e) => setAgain(e.currentTarget.value)} error={mismatch ? 'Passwords differ' : undefined} autoComplete="new-password" />
        <Group grow>
          <Button variant="default" onClick={() => { setOpen(false); setError(null); setCurrent(''); setNext(''); setAgain(''); }}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!account || !current || next.length < 8 || next !== again}>
            Save new password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function InstallCard() {
  const [state, setState] = useState<InstallState>(installState());
  const [declined, setDeclined] = useState(false);
  useEffect(() => onInstallChange(() => setState(installState())), []);

  if (state.kind === 'installed') {
    return (
      <Text size="sm" c="dimmed">
        Installed as an app on this device.
      </Text>
    );
  }
  if (state.kind === 'promptable') {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Install to the home screen for a full-screen app with its own icon. It keeps working offline for everything except talking to the node.
        </Text>
        <Group>
          <Button
            variant="light"
           
            onClick={() => void promptInstall().then((ok) => setDeclined(!ok))}
          >
            Install app
          </Button>
        </Group>
        {declined && (
          <Text size="xs" c="dimmed">
            Not installed. The option is also in the browser menu whenever you want it.
          </Text>
        )}
      </Stack>
    );
  }
  if (state.kind === 'ios-share') {
    return (
      <Text size="sm" c="dimmed">
        To install on iPhone or iPad: tap Share in Safari, then "Add to Home Screen".
      </Text>
    );
  }
  return (
    <Text size="sm" c="dimmed">
      To install: open the browser menu and choose "Install app" or "Add to Home screen".
    </Text>
  );
}

function PasskeyCard() {
  const { services, account, refresh } = useApp();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = Boolean(account?.passkey);

  useEffect(() => {
    void services.accounts.passkeySupported().then(setSupported);
  }, [services]);

  const enable = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await services.accounts.enablePasskey(account.id, password);
      setPassword('');
      setOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'The password is wrong.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!account) return;
    await services.accounts.disablePasskey(account.id);
    await refresh();
  };

  if (supported === false && !enabled) {
    return (
      <Text size="sm" c="dimmed">
        Passkey unlock needs a device with a screen lock and a browser that supports passkeys; this one does not offer it.
      </Text>
    );
  }
  if (enabled) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Passkey unlock is on: the wallet opens with your fingerprint, face or device PIN. The password still works and is what a backup file needs.
        </Text>
        <Group>
          <Button variant="light" onClick={() => void disable()}>
            Turn off passkey unlock
          </Button>
        </Group>
      </Stack>
    );
  }
  if (!open) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Unlock with your fingerprint, face or device PIN instead of typing the password. The passkey stays on this device.
        </Text>
        <Group>
          <Button variant="light" disabled={!account || supported === null} onClick={() => setOpen(true)}>
            Set up passkey unlock
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void enable();
      }}
    >
      <Stack>
        {error && <Alert color="red" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
        <PasswordInput label="Confirm your password" description="Needed once, to let the passkey protect the same key." value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" autoFocus />
        <Group grow>
          <Button variant="default" onClick={() => { setOpen(false); setPassword(''); setError(null); }}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!password}>
            Create passkey
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

// This wallet's name, another wallet, and removal from this device.
function WalletCard() {
  const { services, account, refresh, removeAccount, sendJob } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState(account ? walletName(account) : '');
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState('');
  const [haveBackup, setHaveBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(account ? walletName(account) : '');
  }, [account?.id, account?.name]);
  if (!account) return null;
  const sending = Boolean(sendJob && !sendJob.done);

  const save = async () => {
    if (name.trim() === walletName(account)) return;
    try {
      await services.accounts.rename(account.id, name);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await services.accounts.verifyPassword(account.id, password);
      await removeAccount(account.id);
      setRemoving(false);
      navigate('/');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper>
      <Stack>
        <Title order={3} className="vault-section-title">
          <IconWallet size={18} stroke={1.8} aria-hidden />
          Wallet
        </Title>
        <TextInput
          label="Name on this device"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <Group>
          <Button variant="light" disabled={sending} onClick={() => navigate('/onboarding?add=1')}>
            Add another wallet
          </Button>
          <Button variant="subtle" color="red" disabled={sending} onClick={() => setRemoving(true)}>
            Remove from this device
          </Button>
        </Group>
        <Modal opened={removing} onClose={() => setRemoving(false)} title={`Remove ${walletName(account)} from this device?`}>
          <Stack>
            <Text size="sm">
              Its coins stay on the chain. Only the seed phrase, or a backup file, brings them back: this device will hold nothing of this wallet afterwards, including its history and contacts.
            </Text>
            <Checkbox label="I have this wallet's seed phrase or a backup file" checked={haveBackup} onChange={(e) => setHaveBackup(e.currentTarget.checked)} />
            <PasswordInput label="This wallet's password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} error={error} autoComplete="current-password" />
            <Group grow>
              <Button variant="default" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button color="red" loading={busy} disabled={!haveBackup || !password} onClick={() => void remove()}>
                Remove wallet
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Paper>
  );
}

function RescanCard() {
  const { services, account, rescan: rescanFrom } = useApp();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number | string>(account?.birthdayHeight ?? 1);
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const from = account.birthdayHeight === 0 ? 'the current tip (not set yet)' : `block ${showBlock(account.birthdayHeight)}`;

  const [rescanError, setRescanError] = useState<string | null>(null);
  const [fast, setFast] = useState(true);
  const rescan = async (fast: boolean) => {
    setBusy(true);
    setRescanError(null);
    try {
      if (!fast) {
        try {
          const tip = await services.node().probe();
          if (Number(height) > tip) {
            setRescanError(`The chain is only at block ${showBlock(tip)}; enter that or a lower block.`);
            return;
          }
        } catch {
          // Node unreachable: the sync clamps the height on first contact.
        }
      }
      await rescanFrom(fast ? 0 : Number(height) || 0, fast);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Scanning from {from}. Funds sent before that block are not seen; set an earlier block to find them.
      </Text>
      <Group>
        <Button variant="light" onClick={() => { setHeight(account.birthdayHeight || 1); setOpen(true); }}>
          Rescan
        </Button>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Rescan">
        <Stack>
          <Text size="sm">
            The local history and balance are rebuilt from the chain. Your funds are not affected. Sends made from this device lose their recipient and fee details, which the chain does not carry.
          </Text>
          <SegmentedControl
            fullWidth
            value={fast ? 'fast' : 'private'}
            onChange={(v) => setFast(v === 'fast')}
            data={[
              { value: 'fast', label: 'Fast rescan' },
              { value: 'private', label: 'Private rescan' },
            ]}
          />
          {fast ? (
            <Text size="sm" c="dimmed">
              The node's coin index says which blocks hold payments to you, and only those are fetched: seconds. The node learns which coins are yours, though not the amounts.
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                Every block from the one you choose is downloaded and scanned here. The node learns nothing about your coins; older blocks take longer.
              </Text>
              <StartBlockPicker value={height} onChange={setHeight} node={() => services.node()} error={rescanError} />
            </>
          )}
          <Button loading={busy} onClick={() => void rescan(fast)} disabled={!fast && !Number(height)}>
            Rescan
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
