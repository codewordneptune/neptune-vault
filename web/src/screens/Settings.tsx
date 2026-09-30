// Settings: a short list, each row with its current value, and a page for
// each row with its explanations. Backup, lock and passkey, the node with
// its connectivity check and rescan, appearance, currency, about (with its
// pages: report a problem, privacy), removal.

import { Anchor, Button, Checkbox, Divider, Group, Kbd, Modal, Paper, PasswordInput, SegmentedControl, Select, Stack, Text, TextInput, Title, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconCopy, IconDownload, IconFingerprint } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { BACKGROUND_LOCK_CHOICES_MS, backgroundLockOf, LOCK_CHOICES_MS, lockTimeoutOf } from '../app/accounts';
import { showBlock, showNau, useApp } from '../app/AppContext';
import { NewPasswordFields, newPasswordOk } from '../components/NewPasswordFields';
import { Caution, Done, ErrorLine, Info } from '../components/Notice';
import { NATIVE } from '../app/platform';
import { installState, onInstallChange, promptInstall, type InstallState } from '../app/install';
import { LINKS } from '../app/links';
import { confirmsSends, DEFAULT_NODE_URLS, requestPersistentStorage, showsTestNetworks, walletName, type AccountRecord } from '../storage/db';
import { WrongPasswordError } from '../storage/envelope';
import { StartBlockPicker, type StartLookup } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { ContactsPanel } from './Contacts';
import { ReportProblem } from './Diagnostics';
import { PrivacyStatement } from './Privacy';
import { usePendingSends } from '../app/pending';
import { isCancellation } from '../app/passkey';
import { copyText } from '../util/clipboard';
import { CLIPBOARD_RISK, FAST_SCAN, INSTALL_BENEFITS, NOT_DURING_SEND } from '../app/words';
import { FIAT_CURRENCIES, FIAT_LABELS, isFiatCurrency } from '../util/fiat';
import { NETWORK_LABELS } from '../util/network';
import { formatDate, formatTime } from '../util/time';

// One inline form open at a time: opening one (a new password, a passkey,
// turning send confirmation off) closes any other, so the page shows one
// main button at a time, as every step elsewhere does.
type FormKey = 'password' | 'passkey' | 'confirm-sends';
const OpenFormContext = createContext<{ open: FormKey | null; setOpen: Dispatch<SetStateAction<FormKey | null>> }>({ open: null, setOpen: () => undefined });
function useOpenForm(key: FormKey): [boolean, (on: boolean) => void] {
  const { open, setOpen } = useContext(OpenFormContext);
  const set = useCallback((on: boolean) => setOpen((current) => (on ? key : current === key ? null : current)), [key, setOpen]);
  return [open === key, set];
}

// Settings is a short list, each row with its current value; a row opens
// its page, where its explanations are, so each is read only by someone
// changing that setting. On a wide window the list and the open page sit
// side by side.
type SectionKey = 'backup' | 'security' | 'contacts' | 'name' | 'autolock' | 'appearance' | 'currency' | 'advanced' | 'about' | 'remove' | 'report' | 'privacy';
const SECTION_TITLES: Record<SectionKey, string> = {
  backup: 'Backup',
  security: 'Security',
  contacts: 'Contacts',
  name: 'Name',
  autolock: 'Auto-lock',
  appearance: 'Appearance',
  currency: 'Currency',
  advanced: 'Advanced',
  about: 'About',
  remove: 'Remove wallet',
  report: 'Report a problem',
  privacy: 'Privacy',
};
// Pages reached from About rather than from the list: their way back is to
// About, and on a wide window the list beside them marks About.
const ABOUT_PAGES: SectionKey[] = ['report', 'privacy'];
/** A node's address as the list shows it: its host, or a path on this site as written. */
function nodeHost(url: string): string {
  if (url.startsWith('/')) return url;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One item of a Settings page: its name, then its sentence and its own
 * button, 6 px apart, so each button is plainly the one its sentence
 * explains. Items are set apart by the list's hairline (global.css).
 */
function SettingItem({ name, children, id, className }: { name?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <div className={className ? `vault-setting-item ${className}` : 'vault-setting-item'} id={id}>
      {name && (
        <Text size="sm" fw={600}>
          {name}
        </Text>
      )}
      {children}
    </div>
  );
}

/** A row's label and its page's title; removal names the wallet it removes. */
const titleOf = (key: SectionKey, account: AccountRecord | null): string => (key === 'remove' && account ? `Remove ${walletName(account)}` : SECTION_TITLES[key]);
const isSection = (key: string | undefined): key is SectionKey => key !== undefined && Object.hasOwn(SECTION_TITLES, key);

// A page changed a value the list shows (the lock time, the currency): the
// list beside it on a wide window shows the new one.
const SettingsChangedContext = createContext<() => void>(() => undefined);

export function Settings() {
  const { services, account } = useApp();
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  // A page opened from elsewhere (Home's backup reminder or status line,
  // Send's contact picker or node notice) leads back there: the detour
  // returns to the task it interrupted.
  const from = (useLocation().state as { from?: string } | null)?.from;
  const cameFrom = from === 'send' ? 'Send' : from === 'home' ? 'Home' : null;
  // Side by side from here: a list of 320 px and a page of 600 px or so.
  // Read at once, so a wide window does not flash the phone's layout first.
  const wide = useMediaQuery('(min-width: 1100px)', undefined, { getInitialValueInEffect: false });
  const [, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  if (section !== undefined && !isSection(section)) return <Navigate to="/settings" replace />;
  const current: SectionKey | null = isSection(section) ? section : wide ? 'backup' : null;
  const aboutPage = current !== null && ABOUT_PAGES.includes(current);
  const list = <SettingsList current={aboutPage ? 'about' : current} lockMinutes={Math.round(lockTimeoutOf(services.settings.lockTimeoutMs) / 60_000)} currency={services.settings.fiatCurrency} />;
  if (!current) {
    return (
      <Stack gap="md">
        <Title order={2} className="sr-only">
          Settings
        </Title>
        {list}
      </Stack>
    );
  }
  const page = (
    <Stack gap="md" className="vault-settings-page">
      {cameFrom ? (
        <UnstyledButton onClick={() => navigate(-1)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-back-link">
          <IconChevronLeft size={16} stroke={1.8} aria-hidden />
          {cameFrom}
        </UnstyledButton>
      ) : aboutPage ? (
        <UnstyledButton component={Link} to="/settings/about" c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-back-link">
          <IconChevronLeft size={16} stroke={1.8} aria-hidden />
          About
        </UnstyledButton>
      ) : (
        !wide && (
          <UnstyledButton component={Link} to="/settings" c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-back-link">
            <IconChevronLeft size={16} stroke={1.8} aria-hidden />
            Settings
          </UnstyledButton>
        )
      )}
      <Title order={2}>
        <bdi>{titleOf(current, account)}</bdi>
      </Title>
      {/* A new page for each section, so what one page was doing is not carried to the next. */}
      <SettingsSections key={current} section={current} />
    </Stack>
  );
  return (
    <SettingsChangedContext.Provider value={changed}>
      {wide ? (
        <div className="vault-settings-split">
          {list}
          {page}
        </div>
      ) : (
        page
      )}
    </SettingsChangedContext.Provider>
  );
}

/**
 * The sections as rows, each with its current value, in two groups by
 * where they apply: the open wallet, named, since each wallet has its own
 * password, passkey, send confirmation, backup and contacts and wallets
 * are switched from the header; and the app, shared by every wallet on
 * this device, auto-lock included: it is how long the app stays open when
 * left alone, and only one wallet is ever open. Backup comes first (it carries the warning when nothing is
 * saved), expert rows come last, and removal stands alone, naming what goes.
 */
function SettingsList({ current, lockMinutes, currency }: { current: SectionKey | null; lockMinutes: number; currency: string | undefined }) {
  const { services, account } = useApp();
  const { colorScheme } = useMantineColorScheme();
  const [contacts, setContacts] = useState<number | null>(null);
  useEffect(() => {
    if (account) void services.contacts.list(account.id).then((list) => setContacts(list.length), () => setContacts(null));
  }, [services, account]);
  const backedUp = Boolean(account?.lastBackupAt || account?.backupConfirmed);
  const backup = account?.lastBackupAt ? `File saved ${formatDate(account.lastBackupAt)}` : account?.backupConfirmed ? 'Seed phrase written down' : 'Not backed up';
  // Every value is a current state: the node in use, not what the page holds.
  const nodeUrl = services.settings.nodeUrls[services.settings.network] ?? '';
  const node = !nodeUrl || nodeUrl === DEFAULT_NODE_URLS[services.settings.network] ? 'Default node' : nodeHost(nodeUrl);
  const row = (key: SectionKey, value: string, tone?: 'warn' | 'danger') => (
    <Link key={key} to={`/settings/${key}`} className={`vault-settings-row${current === key ? ' current' : ''}${tone === 'danger' ? ' danger' : ''}`} aria-current={current === key ? 'page' : undefined}>
      <span className="vault-settings-row-label">
        <bdi>{titleOf(key, account)}</bdi>
      </span>
      <span className={`vault-settings-row-value${tone === 'warn' ? ' warn' : ''}`}>{value}</span>
      <IconChevronRight size={16} stroke={1.8} aria-hidden className="vault-settings-row-chevron" />
    </Link>
  );
  return (
    <nav aria-label="Settings" className="vault-settings-list">
      {/* A named group, not a heading: the page's own title stays its first heading. */}
      {/* Group labels read as History's day headings do: the wallet's name as typed. */}
      <div role="group" aria-labelledby="settings-group-wallet" className="vault-settings-group">
        <div id="settings-group-wallet" className="vault-group-label vault-settings-group-label">
          <bdi>{account ? walletName(account) : 'This wallet'}</bdi>
        </div>
        <Paper p={0}>
          {row('backup', backup, backedUp ? undefined : 'warn')}
          {row('security', !account || confirmsSends(account) ? 'Asked before each send' : 'Sends without asking', !account || confirmsSends(account) ? undefined : 'warn')}
          {row('contacts', contacts === null ? '' : contacts === 0 ? 'None' : String(contacts))}
          {/* The name is the group's label just above: no value to repeat it. */}
          {row('name', '')}
        </Paper>
      </div>
      <div role="group" aria-labelledby="settings-group-app" className="vault-settings-group">
        <div id="settings-group-app" className="vault-group-label vault-settings-group-label">
          App
        </div>
        <Paper p={0}>
          {row('autolock', `After ${lockMinutes} min`)}
          {row('appearance', colorScheme === 'dark' ? 'Dark' : colorScheme === 'light' ? 'Light' : 'System')}
          {/* The code as it is written, in capitals, as the currency menu shows it ("Euro (EUR)"). */}
          {row('currency', currency ? currency.toUpperCase() : 'Off')}
          {row('advanced', node)}
          {row('about', `Version ${__APP_VERSION__}`)}
        </Paper>
      </div>
      <Paper p={0}>{row('remove', '', 'danger')}</Paper>
    </nav>
  );
}

function SettingsSections({ section }: { section: SectionKey }) {
  const { services, account, network, refresh, sendJob, sync, lastSyncedAt } = useApp();
  const sending = Boolean(sendJob && !sendJob.done);
  // A saved node shows in the list beside this page at once.
  const changed = useContext(SettingsChangedContext);
  // Testnet and Regtest are for developers and testers: offered in the
  // wallet menu once asked for here, or while the app is on one of them or
  // this device has a wallet on one (showsTestNetworks), so that wallet
  // stays reachable.
  const [testNets, setTestNets] = useState(services.settings.developerNetworks === true);
  const [allAccounts, setAllAccounts] = useState<AccountRecord[]>([]);
  useEffect(() => {
    void services.db.getAll('accounts').then(setAllAccounts, () => undefined);
  }, [services, account]);
  const testNetsShown = showsTestNetworks({ developerNetworks: testNets, network }, allAccounts);
  const testNetsWhy = testNets || !testNetsShown ? null : network !== 'main' ? `In the menu anyway while the app is on ${NETWORK_LABELS[network]}.` : 'In the menu anyway while this device has a wallet on one of them.';
  const toggleTestNets = (on: boolean) => {
    setTestNets(on);
    void services.updateSettings({ developerNetworks: on });
  };
  const lastBackup = account?.lastBackupAt ? formatDate(account.lastBackupAt) : null;
  const [nodeUrl, setNodeUrl] = useState(services.settings.nodeUrls[network] ?? '');
  const [probe, setProbe] = useState<{ ok: boolean; text: string; at?: number } | null>(services.settings.nodeProbe?.[network] ?? null);
  const [phrase, setPhrase] = useState<string[] | null>(null);
  // What the last export came to, shown under its button: a file saved, or not.
  const [message, setMessage] = useState<{ done: boolean; text: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Home's rescan hint links to /settings/advanced#rescan: the rescan is
  // brought into view, with focus on its button. After a frame, since the
  // app scrolls every new screen to its top once this screen has mounted.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== '#rescan') return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(hash.slice(1));
      target?.scrollIntoView({ block: 'start' });
      target?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash]);

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
      const { NodeClient, nodeNetworkLabel, nodeUrlProblem } = await import('../node/rpc');
      const problem = nodeUrlProblem(nodeUrl, network);
      if (problem) throw new Error(problem);
      const node = new NodeClient(nodeUrl.trim());
      const height = await node.probe();
      const theirs = await node.network();
      if (theirs !== null && !(theirs === network || (network === 'testnet' && theirs.startsWith('testnet')))) {
        throw new Error(`This node runs ${nodeNetworkLabel(theirs)}, and the wallet is on ${NETWORK_LABELS[network]}.`);
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
  // What the line under the URL says: the last test, or the last sync when
  // that is newer, so it does not go on saying "Connected" about a node
  // that has stopped answering since.
  const fromSync: { ok: boolean; text: string; at?: number } | null =
    dirty || !sync
      ? null
      : sync.phase === 'done'
        ? { ok: true, text: `Connected · block ${showBlock(sync.syncedHeight)}`, at: lastSyncedAt ?? undefined }
        : sync.phase === 'error' && sync.nodeDown
          ? { ok: false, text: sync.message ?? 'The node is not answering.' }
          : null;
  const shown = testing || !fromSync || (probe?.at && fromSync.at && probe.at > fromSync.at) ? probe : fromSync;
  // The way back after trying another node: it fills the field, and the
  // button then tests it before it is saved, like any other URL.
  const defaultUrl = DEFAULT_NODE_URLS[network];
  const offerDefault = Boolean(defaultUrl && savedUrl !== defaultUrl && nodeUrl.trim() !== defaultUrl);
  const saveAndTestNode = async () => {
    if (!(await testNode())) {
      setProbe((p) => (p ? { ...p, text: `Not saved. ${p.text}` } : p));
      return;
    }
    await services.updateSettings({
      nodeUrls: { ...services.settings.nodeUrls, [network]: nodeUrl.trim() },
      nodeProbe: { ...services.settings.nodeProbe, [network]: { ok: true, text: 'Connected when it was saved', at: Date.now() } },
    });
    changed();
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
    const today = new Date();
    const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const fileName = `neptune-vault-${account.network}-${slug}-${localDate}.json`;
    const text = JSON.stringify(file, null, 2);
    if (NATIVE) {
      // The system's Save dialog: the person chooses where it goes, and hears where it went.
      try {
        const { saveFile } = await import('../backend/native/appClient');
        const saved = await saveFile(fileName, text);
        if (!saved) {
          setMessage({ done: false, text: 'Not saved. Export it again when you are ready.' });
          return;
        }
        // Only a file that was written counts as a backup: the dialog says so, unlike a browser download.
        await services.accounts.markBackedUp(account.id, file.exportedAt);
        await refresh();
        setMessage({ done: true, text: `Backup file saved to ${saved}. It is encrypted with your password.` });
      } catch (e) {
        setMessage(null);
        setExportError((e as Error).message);
      }
      return;
    }
    await services.accounts.markBackedUp(account.id, file.exportedAt);
    await refresh();
    setMessage({ done: true, text: 'Backup file ready, encrypted with your password. If you cancelled saving it, export it again.' });
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
  const [openForm, setOpenForm] = useState<FormKey | null>(null);
  const openFormValue = useMemo(() => ({ open: openForm, setOpen: setOpenForm }), [openForm]);
  const requestPersistent = async () => {
    const granted = await requestPersistentStorage();
    services.persistent = granted;
    setPersistent(granted);
    setPersistAsked(true);
  };

  return (
    <OpenFormContext.Provider value={openFormValue}>
      {section === 'contacts' && <ContactsPanel />}
      {section === 'name' && <WalletCard />}
      {section === 'backup' && (
        <Paper>
          {/* The answer to "am I backed up?" first: the two backups, each
              with its state and its one button; then, in a browser, the one
              thing that can still lose the wallet. */}
          <div className="vault-setting-items">
            <SettingItem name="Seed phrase">
              <Text size="sm" c="dimmed">
                {account?.backupConfirmed ? 'Confirmed at setup. Brings back your coins.' : 'Not confirmed yet. Brings back your coins.'}
              </Text>
              <Button variant="light" onClick={togglePhrase} disabled={!account} aria-label={phrase ? 'Hide seed phrase' : 'Show seed phrase'}>
                {phrase ? 'Hide' : 'Show'}
              </Button>
              {phrase && (
                <Stack gap="xs" mt="xs" w="100%">
                  <WordGrid words={phrase} />
                  {/* The button, then what copying means, beneath it, as on the setup step. */}
                  <Stack gap={4} align="flex-start">
                    <Button variant="subtle" size="compact-sm" className="vault-button-start" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                      Copy words
                    </Button>
                    <Text size="sm" c="dimmed">
                      {CLIPBOARD_RISK}
                    </Text>
                  </Stack>
                  <Text size="sm" c="dimmed" aria-live="off">
                    Hidden again in {Math.max(0, phraseLeft)} s, or when you leave this screen.
                  </Text>
                  <Button variant="subtle" size="compact-sm" className="vault-button-start" onClick={() => setPhraseLeft((n) => n + PHRASE_SECONDS)}>
                    Keep showing
                  </Button>
                  <div className="sr-only" role="status">
                    {phraseLeft <= 20 && phraseLeft > 0 ? 'The seed phrase hides in 20 seconds. Keep showing adds a minute.' : ''}
                  </div>
                </Stack>
              )}
            </SettingItem>
            <SettingItem name="Backup file">
              <Text size="sm" c="dimmed">
                {lastBackup ? `Saved ${lastBackup}.` : 'None saved yet.'} Also brings back contacts and address names.
              </Text>
              <Button variant="light" leftSection={<IconDownload size={16} stroke={1.8} />} onClick={askExport} disabled={!account} aria-label="Export backup file">
                Export
              </Button>
              {message &&
                (message.done ? (
                  <Done onClose={() => setMessage(null)} focusOnMount>
                    {message.text}
                  </Done>
                ) : (
                  <Info onClose={() => setMessage(null)} focusOnMount>
                    {message.text}
                  </Info>
                ))}
              {exportError && <ErrorLine onClose={() => setExportError(null)}>Could not make the backup file: {exportError}</ErrorLine>}
            </SettingItem>
            {!NATIVE && (
              <SettingItem>
                {persistent ? (
                  <Text size="sm" c="dimmed">
                    The browser keeps this wallet's data; clearing site data still deletes it.
                  </Text>
                ) : (
                  <Caution>
                    <span>The browser may delete this wallet when space runs low; installing the app usually stops that.</span>
                    <Group mt={4} gap="sm" align="center">
                      {installState().kind === 'promptable' ? (
                        <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => void promptInstall()}>
                          Install app
                        </Button>
                      ) : (
                        <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => void requestPersistent()}>
                          Ask again
                        </Button>
                      )}
                      {persistAsked && (
                        <Text size="sm" c="dimmed">
                          Still not granted.
                        </Text>
                      )}
                    </Group>
                  </Caution>
                )}
              </SettingItem>
            )}
          </div>
            <Modal opened={exportAsking} onClose={() => setExportAsking(false)} title="Export backup file">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void exportBackup();
                }}
              >
                <Stack>
                  <Text size="sm">The file restores this wallet, its contacts and its address names. It is encrypted with this password, which you will need to open it, and any change to it is detected. Keep it somewhere safe.</Text>
                  <PasswordInput label="Password" value={exportPassword} onChange={(e) => setExportPassword(e.currentTarget.value)} error={exportPasswordError} errorProps={{ role: 'alert' }} autoComplete="current-password" data-autofocus />
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
                  <PasswordInput label="Password" value={revealPassword} onChange={(e) => setRevealPassword(e.currentTarget.value)} error={revealError} errorProps={{ role: 'alert' }} autoComplete="current-password" data-autofocus />
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
        </Paper>
      )}
      {/* Named items, the everyday one first: unlocking, then the password,
          then what each send asks for. */}
      {section === 'security' && (
        <Paper>
          <div className="vault-setting-items">
            <PasskeyCard />
            <ChangePassword />
            <ConfirmSendsSetting />
          </div>
        </Paper>
      )}
      {section === 'autolock' && (
        <Paper>
          <Stack>
            <AutoLockSetting />
            {/* Not during a send: a lock takes the keys the send is using, and it would end without a word. */}
            <Stack gap={4} align="flex-start">
              <Button variant="light" onClick={() => void services.accounts.lock()} disabled={sending}>
                Lock wallet
              </Button>
              {sending && (
                <Text size="sm" c="dimmed">
                  {NOT_DURING_SEND}
                </Text>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}
      {/* Two named items. The node: its address, how it answers, and a
          button only when there is something to do (an edit to test and save,
          a failure to try again); Home's Sync checks a node that answers.
          Networks are switched in the wallet menu. Then the rescan. */}
      {section === 'advanced' && (
        <Paper>
          <div className="vault-setting-items">
            <SettingItem name="Node">
              <TextInput
                w="100%"
                label="Node URL"
                description={testNetsShown ? `Used on ${NETWORK_LABELS[network]}; each network has its own.` : undefined}
                value={nodeUrl}
                onChange={(e) => setNodeUrl(e.currentTarget.value)}
                placeholder="https://…"
              />
              {/* Always there, so what the test says as it runs and ends is announced. */}
              <Text size="sm" c={shown && !shown.ok ? 'var(--v-danger-text)' : 'dimmed'} role="status" className={shown?.text ? undefined : 'sr-only'}>
                {shown?.text}
                {shown?.at && shown.text !== 'Testing…' ? ` · checked ${formatTime(shown.at)}` : ''}
              </Text>
              {(dirty || testing || (shown && !shown.ok) || offerDefault) && (
                <Group>
                  {(dirty || testing || (shown && !shown.ok)) && (
                    <Button variant={dirty ? 'filled' : 'light'} onClick={() => void (dirty ? saveAndTestNode() : testNode())} loading={testing}>
                      {dirty ? 'Test and save' : 'Try again'}
                    </Button>
                  )}
                  {offerDefault && (
                    <Anchor component="button" type="button" size="sm" className="vault-tap-link" onClick={() => setNodeUrl(defaultUrl)}>
                      Use the default node
                    </Anchor>
                  )}
                </Group>
              )}
              <Checkbox
                mt="xs"
                label="Developer networks"
                description={`Adds Testnet and Regtest to the wallet menu, for developers and testers.${testNetsWhy ? ` ${testNetsWhy}` : ''}`}
                checked={testNets}
                onChange={(e) => toggleTestNets(e.currentTarget.checked)}
              />
            </SettingItem>
            <RescanCard />
          </div>
        </Paper>
      )}
      {section === 'appearance' && (
        <Paper>
          <Stack>
            <AppearanceCard />
          </Stack>
        </Paper>
      )}
      {section === 'currency' && (
        <Paper>
          <Stack>
            <FiatCard />
          </Stack>
        </Paper>
      )}
      {section === 'about' && (
        <Paper>
          <Stack>
            <Text size="sm" c="dimmed">
              {NATIVE ? 'A Neptune Cash wallet' : 'A Neptune Cash wallet that runs in your browser'}. Your keys stay on this device, and only the node set in Advanced learns about your wallet.
            </Text>
            <Group gap="md" style={{ rowGap: 24 }}>
              {/* A page of Settings, with the details a report needs and where to send it. */}
              <Anchor component={Link} to="/settings/report" size="sm" className="vault-tap-link">
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
              <Anchor component={Link} to="/settings/privacy" size="sm" className="vault-tap-link">
                Privacy
              </Anchor>
            </Group>
            <Text size="xs" c="dimmed">
              Version {__APP_VERSION__} ({__APP_COMMIT__}), built {formatDate(Date.parse(__APP_BUILT_AT__))}.
            </Text>
            {!NATIVE && <InstallCard />}
            {NATIVE && <Shortcuts />}
          </Stack>
        </Paper>
      )}
      {section === 'remove' && <RemoveWalletCard />}
      {section === 'report' && <ReportProblem />}
      {section === 'privacy' && <PrivacyStatement />}
    </OpenFormContext.Provider>
  );
}

// How long the wallet may sit idle before it locks, and how soon it locks
// once the app goes to the background: at once unless the person chooses a
// short grace, for copying an address into another app and coming back.
function AutoLockSetting() {
  const { services } = useApp();
  const changed = useContext(SettingsChangedContext);
  const [ms, setMs] = useState(lockTimeoutOf(services.settings.lockTimeoutMs));
  const [background, setBackground] = useState(backgroundLockOf(services.settings.backgroundLockMs));
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
          void services.updateSettings({ lockTimeoutMs: next }).then(changed);
        }}
      />
      <Select
        label={NATIVE ? 'When the window is minimized' : 'When the app goes to the background'}
        data={BACKGROUND_LOCK_CHOICES_MS.map((choice) => ({ value: String(choice), label: choice === 0 ? 'Lock at once' : choice < 60_000 ? `Lock after ${choice / 1000} seconds` : `Lock after ${choice / 60_000} minutes` }))}
        value={String(background)}
        allowDeselect={false}
        onChange={(v) => {
          if (!v) return;
          const next = Number(v);
          setBackground(next);
          services.accounts.setBackgroundLock(next);
          void services.updateSettings({ backgroundLockMs: next });
        }}
      />
      <Text size="sm" c="dimmed">
        {background === 0
          ? 'Locking at once is the safest. A short wait lets you copy an address into another app and come back without unlocking again.'
          : 'While it waits, anyone who picks up the unlocked device can use the wallet. A send still asks for the password or passkey unless you turned that off.'}
      </Text>
    </Stack>
  );
}

// Each send asks for the password or passkey before it goes out, so an
// unlocked device left alone cannot be emptied. On unless turned off, for
// each wallet. Turning it off is proven the same way, or whoever holds the
// unlocked device could turn it off and then send: the box stays ticked
// until then, as in a phone's settings. Turning it on needs nothing.
function ConfirmSendsSetting() {
  const { services, account, refresh } = useApp();
  const on = confirmsSends(account);
  const [asking, setAsking] = useOpenForm('confirm-sends');
  const boxRef = useRef<HTMLInputElement>(null);
  // Proven or not, focus goes back to the box, which says which it was.
  const close = useCallback(() => {
    setAsking(false);
    boxRef.current?.focus();
  }, [setAsking]);
  return (
    <SettingItem>
      <Checkbox
        ref={boxRef}
        label="Confirm each send with the password or passkey"
        description={on ? 'Asked on the review, before anything leaves this wallet.' : 'Sends from this wallet go out as soon as they are ready. Anyone with the unlocked device can send.'}
        checked={on}
        onChange={(e) => {
          if (!account) return;
          if (!e.currentTarget.checked) setAsking(true);
          else void services.accounts.enableSendConfirmation(account.id).then(() => refresh());
        }}
      />
      {asking && <ConfirmSendsOff onClose={close} />}
    </SettingItem>
  );
}

/**
 * The proof for turning send confirmation off: the passkey where one is set
 * up (its sheet opens by itself, as for a send), the password otherwise and
 * as the fallback.
 */
function ConfirmSendsOff({ onClose }: { onClose: () => void }) {
  const { services, account, refresh } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasPasskey = Boolean(account?.passkey) && supported === true;
  useEffect(() => {
    void services.accounts.passkeySupported().then(setSupported, () => setSupported(false));
  }, [services]);

  const withPasskey = useCallback(async () => {
    if (!account) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await services.accounts.disableSendConfirmationWithPasskey(account.id);
      await refresh();
      onClose();
    } catch (e) {
      // Closing the system sheet is a choice: the password is there instead.
      if (!isCancellation(e)) setPasskeyError((e as Error).message);
      inputRef.current?.focus();
    } finally {
      setPasskeyBusy(false);
    }
  }, [services, account, refresh, onClose]);

  // Once it is known whether a passkey can answer: its sheet opens by
  // itself, the person having just asked; otherwise the field takes focus.
  const started = useRef(false);
  useEffect(() => {
    if (supported === null || started.current) return;
    started.current = true;
    if (hasPasskey) void withPasskey();
    else inputRef.current?.focus();
  }, [supported, hasPasskey, withPasskey]);

  const withPassword = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await services.accounts.disableSendConfirmation(account.id, password);
      setPassword('');
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
      inputRef.current?.focus();
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Turn off send confirmation"
      onSubmit={(e) => {
        e.preventDefault();
        void withPassword();
      }}
    >
      <Stack gap="sm" pl={32} pt="xs">
        {hasPasskey && (
          <>
            <Button leftSection={<IconFingerprint size={16} stroke={1.8} />} loading={passkeyBusy} onClick={() => void withPasskey()}>
              Turn off with passkey
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
          errorProps={{ role: 'alert' }}
          autoComplete="current-password"
        />
        <Group grow>
          <Button variant="default" onClick={onClose}>
            Keep it on
          </Button>
          <Button type="submit" variant={hasPasskey ? 'light' : 'filled'} loading={busy} disabled={!password}>
            Turn off
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function ChangePassword() {
  const { services, account } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A wrong current password is said at that field; anything else under the buttons.
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useOpenForm('password');
  // The button goes while the form is open: focus goes into the form, and
  // back to the button after; not when another form opening closed this
  // one, since focus is in that form by then.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (wasOpen.current && !open && lost) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const submit = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    setCurrentError(null);
    setDone(false);
    try {
      await services.accounts.changePassword(account.id, current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
      setOpen(false);
    } catch (e) {
      if (e instanceof WrongPasswordError) setCurrentError('Wrong password. Try again.');
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <SettingItem name="Password">
        <Button ref={buttonRef} variant="light" disabled={!account} aria-label="Change password" onClick={() => { setDone(false); setOpen(true); }}>
          Change
        </Button>
        {done && <Done onClose={() => setDone(false)} focusOnMount>Password changed. An older backup file still opens with the old password, so export a new one if you keep one.</Done>}
      </SettingItem>
    );
  }

  return (
    <SettingItem name="Password">
    <form
      style={{ width: '100%' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <PasswordInput
          autoFocus
          label="Current password"
          value={current}
          onChange={(e) => {
            setCurrent(e.currentTarget.value);
            setCurrentError(null);
          }}
          error={currentError}
          errorProps={{ role: 'alert' }}
          autoComplete="current-password"
        />
        <NewPasswordFields password={next} onPassword={setNext} again={again} onAgain={setAgain} label="New password (at least 8 characters)" repeatLabel="Repeat new password" />
        <Group grow>
          <Button variant="default" onClick={() => { setOpen(false); setError(null); setCurrentError(null); setCurrent(''); setNext(''); setAgain(''); }}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!account || !current || !newPasswordOk(next, again)}>
            Save new password
          </Button>
        </Group>
        {error && <ErrorLine onClose={() => setError(null)}>{error}</ErrorLine>}
      </Stack>
    </form>
    </SettingItem>
  );
}

// The desktop app's keyboard shortcuts, which nothing else mentions. They
// are the ones App.tsx listens for, in the desktop app only (in a browser
// these keys are the browser's), and only while a wallet is open.
function Shortcuts() {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';
  const rows: [string, string][] = [
    ['1', 'Home'],
    ['2', 'Send'],
    ['3', 'Receive'],
    ['4', 'Settings'],
    ['N', 'New send'],
    ['L', 'Lock wallet'],
    ['+', 'Larger text'],
    ['-', 'Smaller text'],
    ['0', 'Text size as it was'],
  ];
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Keyboard shortcuts, while the wallet is unlocked
      </Text>
      <dl className="vault-shortcuts">
        {rows.map(([key, what]) => (
          <div key={key}>
            <dt>
              <Kbd>{mod}</Kbd> + <Kbd>{key}</Kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Stack>
  );
}

// Light, dark, or whatever the device says. The library remembers a manual
// choice in this browser's storage; "System" is the default and follows the
// device, so nothing changes unless a person asks.
function AppearanceCard() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  // Narrow by the text's own measure (enlarged text counts): the choices stack.
  const stacked = useMediaQuery('(max-width: 22em)');
  // The page's title names it: the control needs no label of its own on screen.
  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        orientation={stacked ? 'vertical' : 'horizontal'}
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
  const changed = useContext(SettingsChangedContext);
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
          void services.updateSettings({ fiatCurrency: isFiatCurrency(next) ? next : undefined }).then(changed);
        }}
        data={[{ value: 'off', label: 'Off' }, ...FIAT_CURRENCIES.map((c) => ({ value: c, label: FIAT_LABELS[c] }))]}
      />
      {/* What it shows and what it costs, in a sentence; which service is asked when, in Privacy. */}
      <Text size="sm" c="dimmed">
        Shows a rough estimate under your balance. While it is on, the app asks CoinGecko or CoinPaprika for the NPT price every 10 minutes: they see this device's network address, not your wallet.
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
          {INSTALL_BENEFITS}
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
  const [open, setOpen] = useOpenForm('passkey');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set up just now, on this visit: said under where the button was.
  const [justEnabled, setJustEnabled] = useState(false);
  const enabled = Boolean(account?.passkey);
  // Whichever button is showing takes the focus when the one pressed has gone.
  const actionRef = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    actionRef.current?.focus();
  }, [open, enabled]);

  useEffect(() => {
    void services.accounts.passkeySupported().then(setSupported);
  }, [services]);

  const enable = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    setPasswordError(null);
    try {
      await services.accounts.enablePasskey(account.id, password);
      setPassword('');
      setOpen(false);
      setJustEnabled(true);
      moved.current = true;
      await refresh();
    } catch (e) {
      // Closing the system sheet is a choice, not a failure, as on the lock screen.
      if (e instanceof WrongPasswordError) setPasswordError('Wrong password. Try again.');
      else if (!isCancellation(e)) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!account) return;
    setJustEnabled(false);
    moved.current = true;
    await services.accounts.disablePasskey(account.id);
    await refresh();
  };

  // Where the passkey is kept is said in Privacy; here, what it does.
  if (supported === false && !enabled) {
    return (
      <SettingItem name="Passkey unlock">
        <Text size="sm" c="dimmed">
          {NATIVE ? 'Not available in this app. The password unlocks it.' : 'Not available here: it needs a device with a screen lock and a browser that supports passkeys.'}
        </Text>
      </SettingItem>
    );
  }
  if (enabled) {
    return (
      <SettingItem name="Passkey unlock">
        <Text size="sm" c="dimmed">
          On. The password still works, and backup files still use it.
        </Text>
        <Button ref={actionRef} variant="light" aria-label="Turn off passkey unlock" onClick={() => void disable()}>
          Turn off
        </Button>
        {justEnabled && <Done onClose={() => setJustEnabled(false)} focusOnMount>Passkey set up. Next time, unlock with your fingerprint, face or device PIN.</Done>}
      </SettingItem>
    );
  }
  if (!open) {
    return (
      <SettingItem name="Passkey unlock">
        <Text size="sm" c="dimmed">
          Unlock with your fingerprint, face or device PIN.
        </Text>
        <Button ref={actionRef} variant="light" aria-label="Set up passkey unlock" disabled={!account || supported === null} onClick={() => setOpen(true)}>
          Set up
        </Button>
      </SettingItem>
    );
  }
  return (
    <SettingItem name="Passkey unlock">
    <form
      style={{ width: '100%' }}
      onSubmit={(e) => {
        e.preventDefault();
        void enable();
      }}
    >
      <Stack>
        <PasswordInput
          label="Your password"
          description="Needed once, to connect the passkey to this wallet."
          value={password}
          onChange={(e) => {
            setPassword(e.currentTarget.value);
            setPasswordError(null);
          }}
          error={passwordError}
          errorProps={{ role: 'alert' }}
          autoComplete="current-password"
          autoFocus
        />
        <Group grow>
          <Button variant="default" onClick={() => { moved.current = true; setOpen(false); setPassword(''); setError(null); setPasswordError(null); }}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!password}>
            Create passkey
          </Button>
        </Group>
        {error && <ErrorLine onClose={() => setError(null)}>{error}</ErrorLine>}
      </Stack>
    </form>
    </SettingItem>
  );
}

// This wallet's name, on this device. Adding another wallet is in the
// wallet menu in the header, where wallets are switched.
function WalletCard() {
  const { services, account, refresh } = useApp();
  const [name, setName] = useState(account ? walletName(account) : '');
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    setName(account ? walletName(account) : '');
  }, [account?.id, account?.name]);
  if (!account) return null;

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

  return (
    <Paper>
      <Stack>
        <TextInput
          label="Wallet name"
          description="Only on this device."
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
      </Stack>
    </Paper>
  );
}

// Removal from this device, on a page of its own at the foot of Settings,
// away from everyday buttons. The page is the decision: what the wallet
// holds, so the stakes are in front of the person, what is forgotten and
// what stays on the chain, a check that a backup exists, the password and
// the red button, with no dialog saying it all again. Afterwards a notice
// says what happened: the next screen is another lock screen, or setup.
function RemoveWalletCard() {
  const { services, account, balance, loaded, removeAccount, sendJob } = useApp();
  // What Home shows, with pending sends counted as gone.
  const { balanceNau, ready } = usePendingSends();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [haveBackup, setHaveBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const sending = Boolean(sendJob && !sendJob.done);
  const name = walletName(account);
  // Everything the wallet owns: Home's balance, plus what is time-locked.
  const holds = balanceNau + balance.lockedNau;

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await services.accounts.verifyPassword(account.id, password);
      await removeAccount(account.id);
      notifications.show({ message: `${name} was removed from this device.` });
      navigate('/');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <Stack>
          {loaded && ready && (
            <Text size="sm" fw={600}>
              {/* Shown even with amounts hidden: it is what the decision is about. */}
              {name} holds {showNau(holds)} NPT.
            </Text>
          )}
          <Text size="sm">
            This device forgets the wallet, its history and its contacts. The coins stay on the chain, and only the seed phrase or a backup file brings them back.
          </Text>
          <Checkbox label="I have this wallet's seed phrase or a backup file" checked={haveBackup} onChange={(e) => setHaveBackup(e.currentTarget.checked)} />
          <PasswordInput label="This wallet's password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} error={error} errorProps={{ role: 'alert' }} autoComplete="current-password" />
          <Stack gap={4} align="flex-start">
            <Button type="submit" color="red" loading={busy} disabled={sending || !haveBackup || !password}>
              Remove from this device
            </Button>
            {sending && (
              <Text size="sm" c="dimmed">
                {NOT_DURING_SEND}
              </Text>
            )}
          </Stack>
        </Stack>
      </form>
    </Paper>
  );
}

function RescanCard() {
  const { services, account, utxos, history, sendJob, rescan: rescanFrom } = useApp();
  const sending = Boolean(sendJob && !sendJob.done);
  // This device's sends still waiting for a block: a rescan keeps them, with their coins held.
  const waiting = history.filter((h) => h.kind === 'sent' && h.status === 'pending' && h.key.includes(':sent:')).length;
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number | string>(account?.birthdayHeight ?? 1);
  const [busy, setBusy] = useState(false);
  // A start above the chain is the block field's problem; anything else
  // that stops the rescan is shown under its button, in either mode.
  const [startError, setStartError] = useState<string | null>(null);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<StartLookup>('idle');
  const [started, setStarted] = useState(false);
  const [fast, setFast] = useState(true);
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
      ? `Found through the node's coin index on ${restoredOn}, which checks the whole chain. First payment: block ${showBlock(firstPayment)}.`
      : `Found through the node's coin index on ${restoredOn}, which checks the whole chain. No payments to this wallet found.`
    : `${walletName(account)} was scanned from ${from}.`;

  const rescan = async (fast: boolean) => {
    setBusy(true);
    setStartError(null);
    setRescanError(null);
    try {
      // The wallet is emptied before it is rebuilt, so the node is asked
      // first whether it can rebuild it: a node that is down, or has no coin
      // index for a fast rescan, changes nothing.
      const node = services.node();
      let tip: number;
      try {
        tip = await node.probe();
      } catch {
        setRescanError('The node is not answering, so nothing was changed. Try again when it does.');
        return;
      }
      if (fast) {
        let indexed: boolean;
        try {
          indexed = await node.hasCoinIndex();
        } catch {
          setRescanError('The node is not answering, so nothing was changed. Try again when it does.');
          return;
        }
        if (!indexed) {
          setRescanError('This node cannot do a fast rescan, so nothing was changed. Choose Private rescan, or another node.');
          return;
        }
      } else if (Number(height) > tip) {
        setStartError(`The chain is only at block ${showBlock(tip)}; enter that or a lower block.`);
        return;
      }
      await rescanFrom(fast ? 0 : Number(height) || 0, fast);
      setOpen(false);
      setStarted(true);
    } catch (e) {
      setRescanError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingItem name="Rescan" id="rescan" className="vault-anchored">
      <Text size="sm" c="dimmed">
        {how}
      </Text>
      <Group>
        <Button
          variant="light"
          disabled={sending}
          onClick={() => {
            setHeight(account.birthdayHeight || 1);
            setStartError(null);
            setRescanError(null);
            setStarted(false);
            setOpen(true);
          }}
        >
          Rescan
        </Button>
        {sending && (
          <Text size="sm" c="dimmed">
            {NOT_DURING_SEND}
          </Text>
        )}
      </Group>
      {started && (
        <Done onClose={() => setStarted(false)} focusOnMount>Rescan started. The balance and history fill in again as it runs.</Done>
      )}
      <Modal opened={open} onClose={() => setOpen(false)} title="Rescan">
        <Stack>
          <Text size="sm">
            Sends made from this device that have confirmed lose their recipient and fee, because the chain does not carry them. Your coins are not affected.
            {waiting > 0 && ` ${waiting === 1 ? '1 send is' : `${waiting} sends are`} still pending: kept, with the coins held for ${waiting === 1 ? 'it' : 'them'}.`}
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
              {FAST_SCAN}
            </Text>
          ) : (
            <>
              {/* The same question as a private restore: the month, with the block number behind a disclosure. */}
              <Text size="sm" c="dimmed">
                When did this wallet first receive a payment? Every block from then is downloaded and scanned here, so an earlier month takes longer.
              </Text>
              <StartBlockPicker
                value={height}
                onChange={(v) => {
                  setHeight(v);
                  setStartError(null);
                }}
                node={() => services.node()}
                onLookup={setLookup}
                error={startError}
              />
            </>
          )}
          <Group grow>
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void rescan(fast)} disabled={!fast && (!Number(height) || lookup === 'looking')}>
              Rescan
            </Button>
          </Group>
          {rescanError && <ErrorLine>Could not start the rescan: {rescanError}</ErrorLine>}
        </Stack>
      </Modal>
    </SettingItem>
  );
}
