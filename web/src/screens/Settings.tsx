// Network, node URL with connectivity check, backup actions, lock.

import { Alert, Anchor, Button, Checkbox, Group, Modal, Paper, PasswordInput, SegmentedControl, Select, Stack, Text, TextInput, Title, useMantineColorScheme } from '@mantine/core';
import { IconCopy, IconDeviceMobile, IconDownload, IconInfoCircle, IconLock, IconPlugConnected, IconShieldCheck, IconWallet } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { LOCK_CHOICES_MS, lockTimeoutOf } from '../app/accounts';
import { showBlock, useApp } from '../app/AppContext';
import { Caution } from '../components/Notice';
import { NATIVE } from '../app/platform';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { LINKS } from '../app/links';
import { requestPersistentStorage, walletName } from '../storage/db';
import { WrongPasswordError } from '../storage/envelope';
import { StartBlockPicker } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { FIAT_CURRENCIES, FIAT_LABELS, isFiatCurrency } from '../util/fiat';
import { NETWORK_LABELS, NETWORK_OPTIONS } from '../util/network';
import { formatDate, formatDateTime, formatTime } from '../util/time';
import type { Network } from '../storage/db';

export function Settings() {
  const { services, account, network, switchNetwork, refresh, sendJob } = useApp();
  const sending = Boolean(sendJob && !sendJob.done);
  // The same confirmation the header menu gives: switching locks and hides this wallet.
  const [pendingNetwork, setPendingNetwork] = useState<Network | null>(null);
  const navigate = useNavigate();
  const lastBackup = account?.lastBackupAt ? formatDateTime(account.lastBackupAt) : null;
  const [nodeUrl, setNodeUrl] = useState(services.settings.nodeUrls[network] ?? '');
  const [probe, setProbe] = useState<{ ok: boolean; text: string; at?: number } | null>(services.settings.nodeProbe?.[network] ?? null);
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const changeNetwork = async (value: string | null) => {
    if (!value || value === network) return;
    const next = value as Network;
    if (account) {
      setPendingNetwork(next);
      return;
    }
    setNodeUrl(services.settings.nodeUrls[next] ?? '');
    setProbe(services.settings.nodeProbe?.[next] ?? null);
    await switchNetwork(next);
  };
  const confirmNetwork = async () => {
    const next = pendingNetwork;
    setPendingNetwork(null);
    if (!next) return;
    setNodeUrl(services.settings.nodeUrls[next] ?? '');
    setProbe(services.settings.nodeProbe?.[next] ?? null);
    await switchNetwork(next);
  };

  // Saving is explicit; the test result is kept per network.
  const [testing, setTesting] = useState(false);
  // A node URL is looked at, then asked two things: whether it answers,
  // and which network it runs. Only a URL that passes is ever saved, since
  // a saved URL is used at once, by the sync, for this wallet.
  const testNode = async (): Promise<boolean> => {
    setTesting(true);
    setProbe({ ok: true, text: 'Testing…' });
    let result: { ok: boolean; text: string; at: number };
    try {
      const { NodeClient, nodeUrlProblem } = await import('../node/rpc');
      const problem = nodeUrlProblem(nodeUrl, network);
      if (problem) throw new Error(problem);
      const node = new NodeClient(nodeUrl.trim());
      const height = await node.probe();
      const theirs = await node.network();
      if (theirs !== null && !(theirs === network || (network === 'testnet' && theirs.startsWith('testnet')))) {
        throw new Error(`This node runs the ${theirs} network, and the wallet is on ${NETWORK_LABELS[network]}.`);
      }
      result = { ok: true, text: `Connected · block ${showBlock(height)}`, at: Date.now() };
    } catch (e) {
      result = { ok: false, text: (e as Error).message, at: Date.now() };
    }
    setProbe(result);
    setTesting(false);
    // Remembered for the next visit only when it is about the node in use:
    // a failed try of some other URL says nothing about that one.
    if (nodeUrl.trim() === (services.settings.nodeUrls[network] ?? '')) await services.updateSettings({ nodeProbe: { ...services.settings.nodeProbe, [network]: result } });
    return result.ok;
  };

  const savedUrl = services.settings.nodeUrls[network] ?? '';
  const dirty = nodeUrl.trim() !== savedUrl;
  const saveAndTestNode = async () => {
    if (!(await testNode())) {
      setProbe((p) => (p ? { ...p, text: `Not saved. ${p.text}` } : p));
      return;
    }
    await services.updateSettings({
      nodeUrls: { ...services.settings.nodeUrls, [network]: nodeUrl.trim() },
      nodeProbe: { ...services.settings.nodeProbe, [network]: { ok: true, text: 'Connected when it was saved', at: Date.now() } },
    });
  };

  // The backup file's contacts are encrypted and the rest of it is sealed
  // against changes, under a key only the password opens: so the export
  // asks for it, unlocked or not.
  const [exportAsking, setExportAsking] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordError, setExportPasswordError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const askExport = () => {
    setExportPassword('');
    setExportPasswordError(null);
    setExportAsking(true);
  };
  const exportBackup = async () => {
    if (!account) return;
    let file;
    setExporting(true);
    try {
      file = await services.accounts.exportFile(account.id, exportPassword);
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        setExportPasswordError('Wrong password. Try again.');
        return;
      }
      setExportAsking(false);
      setMessage(null);
      setExportError((e as Error).message);
      return;
    } finally {
      setExportPassword('');
      setExporting(false);
    }
    setExportAsking(false);
    setExportError(null);
    const slug = walletName(account).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fileName = `neptune-vault-${account.network}-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
    const text = JSON.stringify(file, null, 2);
    if (NATIVE) {
      // The system's Save dialog: the person chooses where it goes, and hears where it went.
      try {
        const { saveFile } = await import('../backend/native/appClient');
        const saved = await saveFile(fileName, text);
        if (!saved) {
          setMessage('Not saved. Export it again when you are ready.');
          return;
        }
        // Only a file that was written counts as a backup: the dialog says so, unlike a browser download.
        await services.accounts.markBackedUp(account.id, file.exportedAt);
        await refresh();
        setMessage(`Backup file saved to ${saved}. It is encrypted with your password.`);
      } catch (e) {
        setMessage(null);
        setExportError((e as Error).message);
      }
      return;
    }
    await services.accounts.markBackedUp(account.id, file.exportedAt);
    await refresh();
    setMessage(`Backup file ready, encrypted with your password. If you cancelled saving it, export it again.`);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Showing the phrase asks for the password again: an unlocked wallet may
  // be in someone else's hand, and the phrase is the whole wallet, for good.
  // It is dropped from this screen on hide, after a minute at most, and as
  // soon as the app goes to the background or this screen is left.
  const PHRASE_SECONDS = 60;
  const [phraseLeft, setPhraseLeft] = useState(PHRASE_SECONDS);
  const [asking, setAsking] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const togglePhrase = () => {
    if (phrase) {
      setPhrase(null);
      return;
    }
    setRevealPassword('');
    setRevealError(null);
    setAsking(true);
  };
  const reveal = async () => {
    if (!account) return;
    setRevealing(true);
    setRevealError(null);
    try {
      setPhrase(await services.accounts.revealPhrase(account.id, revealPassword));
      setAsking(false);
    } catch (e) {
      setRevealError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
    } finally {
      setRevealPassword('');
      setRevealing(false);
    }
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
      {exportError && <Alert color="red" onClose={() => setExportError(null)} withCloseButton>Could not make the backup file: {exportError}</Alert>}
      <WalletCard />
      <Paper>
        <Stack>
          <Title order={3} className="vault-section-title">
            <IconShieldCheck size={18} stroke={1.8} aria-hidden />
            Backup
          </Title>
          <Text size="sm">
            The backup file and the seed phrase below are for {account ? walletName(account) : 'this wallet'} only. Each wallet on this device has its own.
          </Text>
          {NATIVE ? null : persistent ? (
            <Text size="sm" c="dimmed">
              The browser will not delete this wallet's data on its own. Clearing site data still does, so keep your seed phrase or a backup file.
            </Text>
          ) : (
            <Caution title="The browser may delete this wallet">
              When space runs low, the browser may delete this wallet's data. Installing the app usually prevents that. Your seed phrase or a backup file restores everything.
              <Group mt={4} gap="sm" align="center">
                {installState().kind === 'promptable' && (
                  <Button variant="light" onClick={() => void promptInstall()}>
                    Install app
                  </Button>
                )}
                <Button variant="light" onClick={() => void requestPersistent()}>
                  Request again
                </Button>
                {persistAsked && (
                  <Text size="sm" c="dimmed">
                    Still not granted.
                  </Text>
                )}
              </Group>
            </Caution>
          )}
          <Text size="sm" c="dimmed">
            {lastBackup ? `Last backup file of ${account ? walletName(account) : 'this wallet'}: ${lastBackup}` : `No backup file of ${account ? walletName(account) : 'this wallet'} saved yet.`}
          </Text>
          <Group>
            <Button variant="light" leftSection={<IconDownload size={16} stroke={1.8} />} onClick={askExport} disabled={!account}>Export backup file</Button>
            <Button variant="light" onClick={togglePhrase} disabled={!account}>
              {phrase ? 'Hide seed phrase' : 'Show seed phrase'}
            </Button>
          </Group>
          <Modal opened={exportAsking} onClose={() => setExportAsking(false)} title="Export backup file">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void exportBackup();
              }}
            >
              <Stack>
                <Text size="sm">The file restores this wallet and its contacts. It is encrypted with this password, which you will need to open it, and any change to it is detected. Keep it somewhere safe.</Text>
                <PasswordInput label="Password" value={exportPassword} onChange={(e) => setExportPassword(e.currentTarget.value)} error={exportPasswordError} autoComplete="current-password" data-autofocus />
                <Group grow>
                  <Button variant="default" onClick={() => setExportAsking(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={exporting} disabled={exportPassword === ''}>
                    Export
                  </Button>
                </Group>
              </Stack>
            </form>
          </Modal>
          <Modal opened={asking} onClose={() => setAsking(false)} title="Show the seed phrase">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void reveal();
              }}
            >
              <Stack>
                <Text size="sm">Anyone who sees these words can take everything in this wallet, from anywhere, for good. Make sure nobody is watching the screen.</Text>
                <PasswordInput label="Password" value={revealPassword} onChange={(e) => setRevealPassword(e.currentTarget.value)} error={revealError} autoComplete="current-password" data-autofocus />
                <Group grow>
                  <Button variant="default" onClick={() => setAsking(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={revealing} disabled={revealPassword === ''}>
                    Show
                  </Button>
                </Group>
              </Stack>
            </form>
          </Modal>
          {phrase && (
            <Stack gap="xs">
              <WordGrid words={phrase} />
              {/* The button, then what copying means, beneath it, as on the setup step. */}
              <Stack gap={4} align="flex-start">
                <Button variant="subtle" size="compact-sm" className="vault-button-start" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                  Copy words
                </Button>
                <Text size="sm" c="dimmed">
                  Other apps can read the clipboard; clear it afterwards.
                </Text>
              </Stack>
              <Text size="sm" c="dimmed" aria-live="off">
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
          <AutoLockSetting />
          <ChangePassword />
          <PasskeyCard />
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
          <Select label="Network" data={NETWORK_OPTIONS} value={network} onChange={(v) => void changeNetwork(v)} disabled={sending} description={sending ? 'Not while a send is running.' : undefined} />
          <Modal opened={pendingNetwork !== null} onClose={() => setPendingNetwork(null)} title={pendingNetwork ? `Switch to ${NETWORK_LABELS[pendingNetwork]}?` : ''}>
            <Stack>
              <Text size="sm">Your {NETWORK_LABELS[network]} wallet stays on this device, so you can switch back any time. Switching locks the app.</Text>
              <Group grow>
                <Button variant="default" onClick={() => setPendingNetwork(null)}>
                  Cancel
                </Button>
                <Button onClick={() => void confirmNetwork()}>Switch</Button>
              </Group>
            </Stack>
          </Modal>
          <TextInput label="Node URL" description={`Used on ${NETWORK_LABELS[network]}; each network has its own.`} value={nodeUrl} onChange={(e) => setNodeUrl(e.currentTarget.value)} placeholder="https://…" />
          {probe && (
            <Text size="sm" c={probe.ok ? 'dimmed' : 'red'}>
              {probe.text}
              {probe.at && probe.text !== 'Testing…' ? ` · checked ${formatTime(probe.at)}` : ''}
            </Text>
          )}
          <Group>
            <Button onClick={() => void saveAndTestNode()} disabled={!dirty} loading={testing && dirty}>
              Test and save
            </Button>
            <Button variant="light" onClick={() => void testNode()} disabled={dirty} loading={testing && !dirty}>
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
          <AppearanceCard />
          <FiatCard />
          {!NATIVE && <InstallCard />}
          <Text size="sm" c="dimmed">
            Device and app details to include when you report a problem.
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
            {NATIVE ? 'A Neptune Cash wallet' : 'A Neptune Cash wallet that runs in your browser'}. Keys never leave this device, and it talks only to the node you choose. Early version, not audited: use only amounts you can afford to lose.
          </Text>
          <Group gap="md">
            <Anchor href={LINKS.issues} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Report a problem
            </Anchor>
            <Anchor href={LINKS.telegram} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Ask in Telegram
            </Anchor>
            <Anchor href={LINKS.forum} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              Forum
            </Anchor>
            <Anchor href={LINKS.neptune} target="_blank" rel="noreferrer" size="sm" className="vault-tap-link">
              About Neptune Cash
            </Anchor>
            <Anchor component="button" type="button" size="sm" className="vault-tap-link" onClick={() => navigate('/privacy')}>
              Privacy
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            Version {__APP_VERSION__} ({__APP_COMMIT__}), built {formatDate(Date.parse(__APP_BUILT_AT__))}.
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}

// How long the wallet may sit idle before it locks. It locks on going to the
// background whatever is chosen, which the line under the choice says.
function AutoLockSetting() {
  const { services } = useApp();
  const [ms, setMs] = useState(lockTimeoutOf(services.settings.lockTimeoutMs));
  return (
    <Stack gap={6}>
      <Select
        label="Lock after"
        data={LOCK_CHOICES_MS.map((choice) => ({ value: String(choice), label: `${choice / 60_000} ${choice === 60_000 ? 'minute' : 'minutes'} idle` }))}
        value={String(ms)}
        allowDeselect={false}
        onChange={(v) => {
          if (!v) return;
          const next = Number(v);
          setMs(next);
          services.accounts.setLockTimeout(next);
          void services.updateSettings({ lockTimeoutMs: next });
        }}
      />
      <Text size="sm" c="dimmed">
        {NATIVE ? 'It also locks when you minimize the window.' : 'It also locks whenever the app goes to the background.'}
      </Text>
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
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Stack>
        {done && <Alert color="green" withCloseButton onClose={() => setDone(false)}>Password changed. An older backup file still opens with the old password, so export a new one if you keep one.</Alert>}
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

// Light, dark, or whatever the device says. The library remembers a manual
// choice in this browser's storage; "System" is the default and follows the
// device, so nothing changes unless a person asks.
function AppearanceCard() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Appearance
      </Text>
      <SegmentedControl
        fullWidth
        aria-label="Appearance"
        value={colorScheme}
        onChange={(v) => setColorScheme(v as 'auto' | 'light' | 'dark')}
        data={[
          { value: 'auto', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    </Stack>
  );
}

// The balance in an ordinary currency, off unless asked for: turning it on
// means asking a price site, which learns this device's address and that it
// runs a Neptune Cash wallet. The sentence under the choice says so, and
// that the figure is rough.
function FiatCard() {
  const { services } = useApp();
  const [currency, setCurrency] = useState<string>(services.settings.fiatCurrency ?? 'off');
  return (
    <Stack gap="xs">
      <Select
        label="Value in another currency"
        allowDeselect={false}
        value={currency}
        onChange={(v) => {
          const next = v ?? 'off';
          setCurrency(next);
          void services.updateSettings({ fiatCurrency: isFiatCurrency(next) ? next : undefined });
        }}
        data={[{ value: 'off', label: 'Off' }, ...FIAT_CURRENCIES.map((c) => ({ value: c, label: FIAT_LABELS[c] }))]}
      />
      <Text size="sm" c="dimmed">
        Shows an estimate under your balance. While it is on and the app is open, the app asks CoinGecko (or CoinPaprika, when CoinGecko does not answer) for the NPT price every 10 minutes. They see this device's network address and that it runs a Neptune Cash wallet, and nothing about your wallet. NPT trades in small volumes, so the price can move a lot: treat the figure as a rough guide.
      </Text>
    </Stack>
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
          An installed app keeps its storage, works full screen and opens from its own icon.
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
          <Text size="sm" c="dimmed">
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
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
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
        {NATIVE ? 'Passkey unlock is not available in this app. The password unlocks it.' : 'Passkey unlock is not available here. It needs a device with a screen lock and a browser that supports passkeys.'}
      </Text>
    );
  }
  if (enabled) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Passkey unlock is on. The password still works, and backup files still use it.
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
          Unlock with your fingerprint, face or device PIN. The passkey never leaves this device.
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
        <PasswordInput label="Confirm your password" description="Needed once, to connect the passkey to this wallet." value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" data-autofocus />
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
  const [nameError, setNameError] = useState<string | null>(null);
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
      setNameError(null);
      await refresh();
    } catch (e) {
      setNameError((e as Error).message);
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
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
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
          error={nameError}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setNameError(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <Group>
          <Button variant="light" onClick={() => navigate('/contacts')}>
            Contacts
          </Button>
          <Button variant="light" disabled={sending} onClick={() => navigate('/onboarding?add=1')}>
            Add another wallet
          </Button>
          <Button variant="subtle" color="red" className="vault-danger" disabled={sending} onClick={() => setRemoving(true)}>
            Remove from this device
          </Button>
        </Group>
        <Modal opened={removing} onClose={() => setRemoving(false)} title={`Remove ${walletName(account)} from this device?`}>
          <Stack>
            <Text size="sm">
              This device forgets the wallet, its history and its contacts. The coins stay on the chain, and only the seed phrase or a backup file brings them back.
            </Text>
            <Checkbox label="I have this wallet's seed phrase or a backup file" checked={haveBackup} onChange={(e) => setHaveBackup(e.currentTarget.checked)} />
            <PasswordInput label="This wallet's password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} error={error} autoComplete="current-password" />
            <Group grow>
              <Button variant="default" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button color="red" loading={busy} disabled={!haveBackup || !password} onClick={() => void remove()}>
                Remove
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Paper>
  );
}

function RescanCard() {
  const { services, account, utxos, rescan: rescanFrom } = useApp();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number | string>(account?.birthdayHeight ?? 1);
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const from = account.birthdayHeight === 0 ? 'the current tip (not set yet)' : `block ${showBlock(account.birthdayHeight)}`;
  // After a fast restore nothing was left out: the index was asked about the
  // whole chain. Saying which blocks "were not scanned" read as a gap where
  // coins might hide. The first payment's block comes from the coins
  // themselves, so the sentence stays true as later payments arrive.
  const firstPayment = utxos.length > 0 ? Math.min(...utxos.map((u) => u.confirmedHeight)) : null;
  const restoredOn = account.restoredAt ? formatDate(account.restoredAt) : '';
  const how = account.restoredAt
    ? firstPayment !== null
      ? `Restored on ${restoredOn} with a fast restore, which checks the whole chain. First payment: block ${showBlock(firstPayment)}.`
      : `Restored on ${restoredOn} with a fast restore, which checks the whole chain. No payments to this wallet found.`
    : `Scanned from ${from}. Payments before that block are not found, so rescan from an earlier block if you expect some.`;

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
    } catch (e) {
      setRescanError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        {how}
      </Text>
      <Group>
        <Button variant="light" onClick={() => { setHeight(account.birthdayHeight || 1); setOpen(true); }}>
          Rescan
        </Button>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Rescan">
        <Stack>
          <Text size="sm">
            Sends made from this device will lose their recipient and fee, because the chain does not carry them. Your funds are not affected.
          </Text>
          <SegmentedControl
            fullWidth
            aria-label="How to rescan"
            value={fast ? 'fast' : 'private'}
            onChange={(v) => setFast(v === 'fast')}
            data={[
              { value: 'fast', label: 'Fast rescan' },
              { value: 'private', label: 'Private rescan' },
            ]}
          />
          {fast ? (
            <Text size="sm" c="dimmed">
              Takes seconds: only the blocks holding your payments are fetched. The node learns which coins are yours, not the amounts.
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                The node learns nothing about your coins. Every block from the one you choose is downloaded and scanned here, so an earlier block takes longer.
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
