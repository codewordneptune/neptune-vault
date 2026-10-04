// Account creation and import: generate or enter a phrase,
// confirm it word by word, set a password.

import { Anchor, Button, Group, Paper, PasswordInput, Radio, Select, Stack, Text, TextInput, Title, SegmentedControl, UnstyledButton } from '@mantine/core';
import { IconChevronRight, IconCopy, IconFileUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { WALLET_NAME_MAX, WalletNameTakenError } from '../app/accounts';
import { showBlock, useApp } from '../app/AppContext';
import { nodeFor } from '../app/services';
import { PocNotice } from '../components/PocNotice';
import { NewPasswordFields, newPasswordOk } from '../components/NewPasswordFields';
import { PhraseField, phraseWords } from '../components/PhraseField';
import { Caution, ErrorLine, Info } from '../components/Notice';
import { NATIVE } from '../app/platform';
import { StartBlockPicker, type StartLookup } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { CLIPBOARD_RISK, FAST_SCAN } from '../app/words';
import { NETWORK_LABELS, NETWORK_OPTIONS } from '../util/network';
import type { NodeClient } from '../node/rpc';
import type { Network } from '../storage/db';
import { notifications } from '@mantine/notifications';
import { MAX_BACKUP_BYTES, parseBackupFile, WrongPasswordError } from '../storage/envelope';
import { Spoken } from '../components/Spoken';

type Step = 'welcome' | 'existing' | 'show' | 'confirm' | 'password' | 'import' | 'file';

// A newly generated phrase lives in this tab's session storage until the
// account exists, so a screenshot, app switch, tab discard or reload does
// not throw the user back to the start. It has no funds behind it yet, is
// invisible to other tabs and sites, and is wiped on completion or when the
// tab closes. An imported phrase is never stored: it usually has funds
// behind it, and no password protects anything at that point. It stays in
// this screen's memory, and a reload asks for the words again.
const DRAFT_KEY = 'neptune-vault.onboarding-draft';
interface Draft {
  phrase: string[];
  network: Network;
  imported: boolean;
  birthday: number | string;
  /** Imported with the fast restore (the node's coin index) rather than a scan from a block. */
  fast?: boolean;
}
function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    const draft = raw ? (JSON.parse(raw) as Draft) : null;
    // A draft written by an older version may hold an imported phrase: gone at first sight.
    if (draft?.imported) {
      sessionStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}
function saveDraft(draft: Draft | null) {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Session storage unavailable: onboarding still works, just without resume.
  }
}

export function Onboarding() {
  const { services, account, setAccount, switchNetwork, adoptNetwork, pauseSync, network: currentNetwork } = useApp();
  const navigate = useNavigate();
  // Adding a wallet next to an existing one: same steps, a way back to it.
  const location = useLocation();
  const adding = Boolean(account) && new URLSearchParams(location.search).has('add');
  const draft = loadDraft();
  const [step, setStep] = useState<Step>(draft ? (draft.imported ? 'password' : 'show') : 'welcome');
  // The network the new wallet goes on. Without Developer networks it is
  // Mainnet, and nobody is asked. With it, setup asks, starting on Mainnet,
  // or on the network picked in the wallet menu when that one has no wallet
  // yet (that is why setup is open). The app moves there once it is made.
  const developer = services.settings.developerNetworks === true;
  const [chosen, setChosen] = useState<Network>(draft?.network ?? (adding ? 'main' : currentNetwork));
  const network: Network = developer ? chosen : 'main';
  const shownNetwork = useRef(currentNetwork);
  useEffect(() => {
    if (shownNetwork.current === currentNetwork) return;
    shownNetwork.current = currentNetwork;
    if (!adding) setChosen(currentNetwork);
  }, [currentNetwork, adding]);
  // That network's node, which need not be the app's yet.
  const node = () => nodeFor(services.settings.nodeUrls[network], network);
  const [phrase, setPhrase] = useState<string[]>(draft?.phrase ?? []);
  const [imported, setImported] = useState(draft?.imported ?? false);
  const [birthday, setBirthday] = useState<number | string>(draft?.birthday ?? 1);
  // When an imported phrase first received a payment: not known (find
  // everything), a month (scan from its first block), or never (start at the
  // tip; 0 = unknown, resolved at first sync).
  const [when, setWhen] = useState<FirstFunds>('unknown');
  const [month, setMonth] = useState('');
  const [fast, setFast] = useState(draft?.fast ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Networks other than the app's that have a wallet on this device: after
  // a switch to an empty network, the way back.
  const [elsewhere, setElsewhere] = useState<Network[]>([]);
  useEffect(() => {
    void services.db.getAll('accounts').then((all) => setElsewhere([...new Set(all.map((a) => a.network))].filter((n) => n !== currentNetwork)));
  }, [services, currentNetwork]);
  // Adding a wallet beside others offers a name; this is the one it gets otherwise.
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    if (!adding) return;
    void services.accounts.nextName(network).then(setDefaultName, () => setDefaultName(null));
  }, [adding, services, network]);

  // A new step starts at its top, with focus on its heading: the steps swap
  // content in place, and the button that led here (often at the foot of a
  // long step) is gone. An error belongs to the step it was made on.
  const stepsRef = useRef<HTMLDivElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    setError(null);
    window.scrollTo(0, 0);
    stepsRef.current?.querySelector<HTMLElement>('.vault-step-title')?.focus({ preventScroll: true });
  }, [step]);

  // Confirmation: CHECKS random positions are blanked and their words go
  // into a shuffled bank; the user taps them back into place (as the desktop
  // wallet does). A wrong placement can be undone by tapping the slot.
  const [checks, setChecks] = useState<number[]>([]);
  const [slots, setSlots] = useState<Record<number, Chip>>({});
  const [bank, setBank] = useState<Chip[]>([]);
  // Where focus goes once the chips have changed: a chip by its place in the
  // phrase, Continue, or the first slot.
  const focusNext = useRef<number | 'continue' | 'slot' | null>(null);
  const chipRefs = useRef(new Map<number, HTMLButtonElement>());
  const continueRef = useRef<HTMLButtonElement>(null);
  // Each placement is said aloud, since a tapped word leaves the bank and
  // appears in a slot elsewhere on the screen.
  const [placed, setPlaced] = useState('');
  // Words go into the empty slots in order; this is the one that fills next.
  const nextSlot = checks.find((i) => slots[i] === undefined);

  const startCreate = async () => {
    setBusy(true);
    try {
      const words = await services.accounts.generatePhrase();
      setPhrase(words);
      setImported(false);
      saveDraft({ phrase: words, network, imported: false, birthday });
      setStep('show');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startConfirm = () => {
    const positions = new Set<number>();
    while (positions.size < CHECKS) positions.add(Math.floor(Math.random() * phrase.length));
    const sorted = [...positions].sort((a, b) => a - b);
    setChecks(sorted);
    setSlots({});
    setPlaced('');
    setBank(shuffle(sorted.map((i) => ({ word: phrase[i], at: i }))));
    setStep('confirm');
  };

  const pick = (bankIndex: number) => {
    const target = nextSlot;
    if (target === undefined) return;
    const chip = bank[bankIndex];
    const nextSlots = { ...slots, [target]: chip };
    const rest = bank.filter((_, i) => i !== bankIndex);
    setSlots(nextSlots);
    setBank(rest);
    // The chip is gone: focus goes to the one now in its place, or once all
    // are placed to Continue, or to the first slot when the order is wrong.
    const done = rest.length === 0;
    const right = done && checks.every((i) => nextSlots[i]?.word === phrase[i]);
    focusNext.current = done ? (right ? 'continue' : 'slot') : (rest[Math.min(bankIndex, rest.length - 1)]?.at ?? null);
    setPlaced(`Word ${target + 1}: ${chip.word}.${done ? (right ? ' All five words are in place. Continue is available.' : ' Some words are in the wrong place. Choose a word in the grid to take it out.') : ''}`);
  };

  const unpick = (position: number) => {
    const chip = slots[position];
    if (chip === undefined) return;
    const rest = { ...slots };
    delete rest[position];
    setSlots(rest);
    setBank([...bank, chip]);
    focusNext.current = chip.at;
    setPlaced(`Word ${position + 1} emptied`);
  };

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === 'continue') continueRef.current?.focus();
    else if (target === 'slot') stepsRef.current?.querySelector<HTMLElement>('.vault-word-slot')?.focus();
    else chipRefs.current.get(target)?.focus();
  }, [bank, slots]);

  const allPlaced = bank.length === 0 && checks.length > 0;
  const confirmed = allPlaced && checks.every((i) => slots[i]?.word === phrase[i]);

  const finish = async (password: string, name: string) => {
    setBusy(true);
    setError(null);
    setNameError(null);
    try {
      // The coin index finds everything whatever the date, so it is offered only when the date is not known.
      const fastRestore = imported && fast && when === 'unknown';
      const fromTip = when === 'never';
      // A start above the chain was refused on the seed phrase step, before the password was asked for.
      let height = imported && (fromTip || fastRestore) ? 0 : when === 'unknown' ? 1 : Number(birthday) || 1;
      if (!imported) {
        // A fresh account has nothing before the current tip. If the node
        // cannot be reached now, 0 marks the height as unknown and the first
        // successful sync starts at the tip it sees.
        try {
          height = Math.max(1, await node().probe());
        } catch {
          height = 0;
        }
      }
      await pauseSync();
      const record = await services.accounts.createAccount(phrase, password, network, height, { fastRestore, name: adding ? name : undefined });
      saveDraft(null);
      await services.accounts.markBackupConfirmed(record.id);
      await services.updateSettings({ currentAccountId: record.id, network: record.network });
      setAccount({ ...record, backupConfirmed: true });
      // Made on another network than the app was on: the app goes with it.
      if (record.network !== currentNetwork) adoptNetwork(record.network);
      navigate('/');
    } catch (e) {
      if (e instanceof WalletNameTakenError) setNameError(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File, password: string, fast: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // Looked at before it is read, and checked before the password is used on it.
      if (file.size > MAX_BACKUP_BYTES) throw new Error('This file is too large to be a Neptune Vault backup file.');
      const parsed = parseBackupFile(await file.text());
      await pauseSync();
      const record = await services.accounts.importFile(parsed, password, { fastRestore: fast });
      saveDraft(null);
      await services.updateSettings({ currentAccountId: record.id, network: record.network });
      setAccount(record);
      if (record.network !== currentNetwork) {
        adoptNetwork(record.network);
        notifications.show({ message: `Restored on ${NETWORK_LABELS[record.network]}. The app is now on ${NETWORK_LABELS[record.network]}.` });
      }
      // Files from before version 3 carry their contacts and their start
      // block unprotected: anyone who could write to where the file was
      // kept could have changed them. The restore cannot tell, so it says so.
      if (parsed.version < 3) {
        notifications.show({
          color: 'yellow',
          title: 'Restored from an older backup file',
          message: 'Its contacts and start block were not protected against changes. Check a contact\'s address before you pay them, and export a fresh backup file in Settings.',
          autoClose: false,
        });
      }
      navigate('/');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password. Use the password the backup file was exported with.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md" ref={stepsRef}>
      {step === 'welcome' && !adding && <PocNotice />}
      {step === 'welcome' && (
        <Paper>
          <Stack>
            {!adding && <span className="vault-eyebrow vault-welcome-name">Neptune Vault</span>}
            <Title order={2} tabIndex={-1} className="vault-step-title">{adding ? 'Add a wallet' : 'Set up your wallet'}</Title>
            <Text size="sm" c="dimmed">
              {adding ? 'Another wallet on this device, with its own seed phrase and password.' : 'Your keys stay on this device.'}
            </Text>
            {/* Two doors: a new wallet, or one that exists; which way to bring
                one back is asked behind the second door. */}
            <Button onClick={startCreate} loading={busy}>Create a new wallet</Button>
            {error && <ErrorLine>{error}</ErrorLine>}
            <Button variant="light" onClick={() => setStep('existing')}>I already have a wallet</Button>
            {/* Without Developer networks a wallet is added on Mainnet, even
                beside a test network's wallet (still in the menu, to reach
                it): said before it is made, as the app goes to Mainnet too. */}
            {adding && !developer && currentNetwork !== 'main' && (
              <Text size="sm" c="dimmed">
                Adds to Mainnet. To add on {NETWORK_LABELS[currentNetwork]}, turn on Developer networks in Settings, Advanced.
              </Text>
            )}
            {!adding && elsewhere.length > 0 && (
              <Info>
                Your {elsewhere.map((n) => NETWORK_LABELS[n]).join(' and ')} {elsewhere.length === 1 ? 'wallet is' : 'wallets are'} still on this device.
                <Group gap="sm" mt={4}>
                  {elsewhere.map((n) => (
                    <Button key={n} variant="light" size="compact-sm" className="vault-tap" onClick={() => void switchNetwork(n)}>
                      Switch to {NETWORK_LABELS[n]}
                    </Button>
                  ))}
                </Group>
              </Info>
            )}
            {draft && (
              <Button
                variant="subtle"
                onClick={() => {
                  saveDraft(null);
                  setPhrase([]);
                  // The button goes with the draft: focus moves to the first choice.
                  setTimeout(() => stepsRef.current?.querySelector<HTMLElement>('.mantine-Paper-root button')?.focus(), 0);
                }}
              >
                Discard the unfinished wallet
              </Button>
            )}
            {adding && (
              <Button variant="subtle" onClick={() => (location.key !== 'default' ? navigate(-1) : navigate('/'))}>
                Cancel
              </Button>
            )}
          </Stack>
        </Paper>
      )}
      {step === 'existing' && (
        <Paper>
          <Stack>
            <Title order={2} tabIndex={-1} className="vault-step-title">Restore your wallet</Title>
            <Text size="sm" c="dimmed">
              The seed phrase is the 18 words you wrote down; a backup file is the encrypted copy this app saves.
            </Text>
            <Button variant="light" onClick={() => setStep('import')}>With the seed phrase</Button>
            <Button variant="light" onClick={() => setStep('file')}>From a backup file</Button>
            <Button variant="subtle" onClick={() => setStep('welcome')}>Back</Button>
          </Stack>
        </Paper>
      )}
      {/* The network is asked only with Developer networks on (Settings,
          Advanced): other people never meet the question, and a first
          wallet goes on Mainnet. A quiet line under the card, open
          when it is not Mainnet, so a tester sees where the wallet will go.
          Nothing changes until the wallet is made: the open wallet, when
          adding one, stays open until then. */}
      {step === 'welcome' && developer && (
        <details className="vault-setting vault-setup-network" open={network !== 'main'}>
          <summary>
            <IconChevronRight size={16} className="vault-setting-chevron" aria-hidden />
            Network: {NETWORK_LABELS[network]}
          </summary>
          <div className="vault-setting-body">
            <Select
              aria-label="Network"
              data={NETWORK_OPTIONS}
              value={network}
              onChange={(v) => {
                if (v) setChosen(v as Network);
              }}
            />
          </div>
        </details>
      )}
      {/* Before a wallet exists there is no Settings to find these in.
          Report a problem is open without a wallet on purpose, for whoever
          cannot get started: it holds the details a report needs. */}
      {step === 'welcome' && !adding && (
        <Group gap={6} justify="center">
          <Anchor component="button" type="button" size="sm" className="vault-tap-link vault-inline-link" onClick={() => navigate('/privacy')}>
            Privacy statement
          </Anchor>
          <Text span size="sm" c="dimmed" aria-hidden>
            ·
          </Text>
          <Anchor component="button" type="button" size="sm" className="vault-tap-link vault-inline-link" onClick={() => navigate('/diagnostics')}>
            Report a problem
          </Anchor>
        </Group>
      )}

      {step === 'show' && (
        <Paper>
          <Stack>
            <Title order={2} tabIndex={-1} className="vault-step-title">
              <span className="vault-eyebrow vault-step-count">Step 1 of 3</span>{' '}
              Write down these 18 words
            </Title>
            <Text size="sm" c="dimmed">In order, on paper. Anyone with these words can spend your coins. {NATIVE ? 'If this device is lost, only what you write down brings the wallet back.' : 'Clearing the browser deletes everything except what you write down.'}</Text>
            <WordGrid words={phrase} />
            {/* The button, then what copying means, beneath it at every width
                (as a phone wraps it), not squeezed in beside it. */}
            <Stack gap={4} align="flex-start">
              <Button variant="subtle" size="compact-sm" className="vault-button-start" leftSection={<IconCopy size={16} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                Copy words
              </Button>
              <Text size="sm" c="dimmed">
                {CLIPBOARD_RISK}
              </Text>
            </Stack>
            <Button onClick={startConfirm}>I have written them down</Button>
            <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); setStep('welcome'); }}>
              Cancel
            </Button>
          </Stack>
        </Paper>
      )}

      {step === 'confirm' && (
        <Paper>
          <Stack>
            <Title order={2} tabIndex={-1} className="vault-step-title">
              <span className="vault-eyebrow vault-step-count">Step 2 of 3</span>{' '}
              Confirm your seed phrase
            </Title>
            <Text size="sm" c="dimmed">
              {nextSlot === undefined
                ? 'Tap a word in the grid to take it out again.'
                : Object.keys(slots).length === 0
                  ? `Tap the missing words in order, starting with word ${nextSlot + 1}.`
                  : `Next: word ${nextSlot + 1}.`}
            </Text>
            {/* Only the five missing places, by their numbers, with the words to
                tap right beneath them: the phrase is not shown a second time. */}
            <WordGrid
              words={phrase.map((w, i) => (checks.includes(i) ? (slots[i]?.word ?? '') : w))}
              blanks={checks}
              only={checks}
              next={nextSlot}
              onClear={unpick}
            />
            <div className="sr-only" aria-live="polite">
              {placed}
            </div>
            <Group gap="xs" justify="center" mih={44}>
              {bank.map((chip, i) => (
                <Button
                  key={chip.at}
                  ref={(el: HTMLButtonElement | null) => {
                    if (el) chipRefs.current.set(chip.at, el);
                    else chipRefs.current.delete(chip.at);
                  }}
                  variant="default"
                  className="vault-chip"
                  onClick={() => pick(i)}
                >
                  {chip.word}
                </Button>
              ))}
            </Group>
            {allPlaced && !confirmed && (
              <Caution>Some words are in the wrong place. Tap a word to take it out and try again.</Caution>
            )}
            {/* The step's one main button spans the card, as on every other step. */}
            <Button ref={continueRef} disabled={!confirmed} onClick={() => setStep('password')}>Continue</Button>
            <Button variant="subtle" onClick={() => setStep('show')}>Show the words again</Button>
          </Stack>
        </Paper>
      )}

      {step === 'password' && (
        <PasswordStep
          busy={busy}
          error={error}
          onSubmit={finish}
          stepLabel={imported ? 'Step 2 of 2' : 'Step 3 of 3'}
          actionLabel={imported ? 'Restore wallet' : 'Create wallet'}
          onBack={() => setStep(imported ? 'import' : 'confirm')}
          defaultName={adding ? defaultName : undefined}
          nameError={nameError}
          onNameEdit={() => setNameError(null)}
        />
      )}

      {step === 'import' && (
        <ImportStep
          birthday={birthday}
          setBirthday={setBirthday}
          when={when}
          setWhen={setWhen}
          month={month}
          setMonth={setMonth}
          fast={fast}
          setFast={setFast}
          node={node}
          network={network}
          initialText={imported ? phrase.join(' ') : ''}
          checkPhrase={(words) => services.core.phraseProblem(words)}
          onPhrase={(words) => {
            setPhrase(words);
            setImported(true);
            // Not saved anywhere: see the note on the draft above.
            saveDraft(null);
            setStep('password');
          }}
          onBack={() => setStep('existing')}
        />
      )}

      {step === 'file' && <FileStep busy={busy} error={error} onFile={importFile} onBack={() => setStep('existing')} onPicking={() => services.accounts.holdBackgroundLock()} />}
    </Stack>
  );
}

// Restore from a backup file made by this app: the file carries the seed,
// the network, the start block and the contacts; its password opens it.
function FileStep({ busy, error, onFile, onBack, onPicking }: { busy: boolean; error: string | null; onFile: (file: File, password: string, fast: boolean) => void; onBack: () => void; onPicking: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [fast, setFast] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // A file dragged from the desktop onto this step is taken as if chosen.
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer.types).includes('Files');
  return (
    <Paper
      className={dragging ? 'vault-dropping' : undefined}
      onDragOver={(e) => {
        if (!carriesFiles(e) || busy) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped && !busy) setFile(dropped);
      }}
    >
      <Stack>
        <Title order={2} tabIndex={-1} className="vault-step-title">Restore from a backup file</Title>
        <input ref={fileInput} type="file" aria-label="Backup file" accept="application/json,.json" hidden onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <Group align="center">
          <Button
            variant="default"
            leftSection={<IconFileUpload size={16} />}
            onClick={() => {
              onPicking();
              fileInput.current?.click();
            }}
          >
            Choose backup file
          </Button>
          <Text size="sm" c={file ? undefined : 'dimmed'} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file ? (
              file.name
            ) : (
              <>
                <span className="vault-drop-hint">Or drop it here</span>
                <span className="vault-drop-none">No file chosen</span>
              </>
            )}
          </Text>
        </Group>
        <Stack gap={4}>
          <PasswordInput label="Backup file password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
          {/* The restored wallet keeps the file's password: said here, so an old password does not surprise at the next unlock. */}
          <Text size="sm" c="dimmed">
            It also unlocks the wallet after restoring.
          </Text>
        </Stack>
        {/* How to restore, as one line with its choice; Change opens the choice. */}
        {optionsOpen ? (
          <>
            <SegmentedControl
              aria-label="How to restore"
              fullWidth
              value={fast ? 'fast' : 'private'}
              onChange={(v) => setFast(v === 'fast')}
              data={[
                { value: 'fast', label: 'Fast restore' },
                { value: 'private', label: 'Private restore' },
              ]}
            />
            <Text size="sm" c="dimmed">
              {fast
                ? FAST_SCAN
                : 'Every block from the start block in the file is downloaded and scanned on this device. The node learns nothing about your coins.'}
            </Text>
          </>
        ) : (
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              {fast ? 'Restores in seconds. The node learns which payments are yours, but not the amounts.' : "Scans every block from the file's start on this device. The node learns nothing."}
            </Text>
            <UnstyledButton onClick={() => setOptionsOpen(true)} aria-expanded={false} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
              Change
            </UnstyledButton>
          </Stack>
        )}
        <Button disabled={!file || !password} loading={busy} onClick={() => file && onFile(file, password, fast)}>
          Restore wallet
        </Button>
        {error && <ErrorLine>{error}</ErrorLine>}
        <Button variant="subtle" disabled={busy} onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}

/** A word of the phrase in the confirmation bank, with its place in the phrase: what keeps its chip the same chip. */
interface Chip {
  word: string;
  at: number;
}

const CHECKS = 5;

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function PasswordStep({
  busy,
  error,
  onSubmit,
  stepLabel,
  actionLabel,
  onBack,
  defaultName,
  nameError,
  onNameEdit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (password: string, name: string) => void;
  stepLabel: string;
  actionLabel: string;
  onBack: () => void;
  /** When adding a wallet beside others: the name it gets if none is typed, and the field to type one. */
  defaultName?: string | null;
  nameError?: string | null;
  onNameEdit?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [name, setName] = useState('');
  const ok = newPasswordOk(password, again);
  return (
    <Paper>
      <Stack>
        <Title order={2} tabIndex={-1} className="vault-step-title">
          <span className="vault-eyebrow vault-step-count">{stepLabel}</span>{' '}
          Choose a password
        </Title>
        <Text size="sm" c="dimmed">
          You will use it to unlock this wallet. If you forget it, your seed phrase can set a new one.
        </Text>
        {/* A second wallet is told apart by its name; the first needs none yet. */}
        {defaultName !== undefined && (
          <TextInput
            label="Wallet name (optional)"
            placeholder={defaultName ?? undefined}
            description={defaultName ? `Left empty, it is called ${defaultName}. You can rename it in Settings.` : undefined}
            maxLength={WALLET_NAME_MAX}
            value={name}
            error={nameError}
            errorProps={{ role: 'alert' }}
            onChange={(e) => {
              setName(e.currentTarget.value);
              onNameEdit?.();
            }}
          />
        )}
        <NewPasswordFields password={password} onPassword={setPassword} again={again} onAgain={setAgain} />
        <Button disabled={!ok} loading={busy} onClick={() => onSubmit(password, name)}>{actionLabel}</Button>
        {error && <ErrorLine>{error}</ErrorLine>}
        <Button variant="subtle" disabled={busy} onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}

/** When an imported seed phrase first received a payment, as far as the person knows. */
type FirstFunds = 'unknown' | 'month' | 'never';

function ImportStep({
  birthday,
  setBirthday,
  when,
  setWhen,
  month,
  setMonth,
  fast,
  setFast,
  node,
  network,
  initialText,
  checkPhrase,
  onPhrase,
  onBack,
}: {
  birthday: number | string;
  setBirthday: (v: number | string) => void;
  when: FirstFunds;
  setWhen: (v: FirstFunds) => void;
  /** The month chosen, as YYYY-MM, or ''. */
  month: string;
  setMonth: (v: string) => void;
  fast: boolean;
  setFast: (v: boolean) => void;
  node: () => NodeClient;
  /** The network the wallet is restored on. */
  network: Network;
  /** The phrase typed before, when coming back from the password step. */
  initialText: string;
  /** Why the words cannot be a phrase, or null; asked before the step advances. */
  checkPhrase: (words: string[]) => Promise<string | null>;
  onPhrase: (words: string[]) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const words = phraseWords(text);

  // How to restore, folded until asked for, and said in one line meanwhile.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const monthName = /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T00:00:00`).toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : null;
  const restoreSummary =
    when === 'unknown'
      ? fast
        ? 'Finds all your payments in seconds. The node learns which payments are yours, but not the amounts.'
        : 'Finds all your payments by scanning every block on this device, about 8 to 10 GB on Mainnet. The node learns nothing.'
      : when === 'month'
        ? `Looks for payments from ${monthName ?? (Number(birthday) > 1 ? `block ${showBlock(Number(birthday))}` : 'the date you choose')}.`
        : 'Starts now: this seed phrase has never received a payment.';
  // How the month lookup stands: Continue waits for it.
  const [lookup, setLookup] = useState<StartLookup>('idle');
  // A start above the chain, found before the password step rather than after it.
  const [startError, setStartError] = useState<string | null>(null);
  // A month, or a block typed instead, before the scan has somewhere to start.
  const startKnown = when !== 'month' || (lookup !== 'looking' && (lookup === 'found' || Number(birthday) > 1));

  const continueWithPhrase = async () => {
    setChecking(true);
    try {
      const problem = await checkPhrase(words);
      if (problem) {
        setPhraseError(problem);
        return;
      }
      if (when === 'month') {
        try {
          const tip = await node().probe();
          if ((Number(birthday) || 1) > tip) {
            setStartError(`The chain is only at block ${showBlock(tip)}; enter that or a lower block.`);
            return;
          }
        } catch {
          // Node unreachable: the sync clamps the height on first contact.
        }
      }
      onPhrase(words);
    } catch (e) {
      setPhraseError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Paper>
      <Stack>
        <Title order={2} tabIndex={-1} className="vault-step-title">
          <span className="vault-eyebrow vault-step-count">Step 1 of 2</span>{' '}
          Restore with a seed phrase
        </Title>
        <PhraseField text={text} onText={setText} error={phraseError} onError={setPhraseError} checkPhrase={checkPhrase} />
        {/* How to restore, as one line with its current choice: most people
            restore everything, fast, and need decide nothing. Change opens
            the question people can answer, instead of a block number. */}
        {!optionsOpen && (
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              <Spoken text={restoreSummary} />
            </Text>
            <UnstyledButton onClick={() => setOptionsOpen(true)} aria-expanded={false} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
              Change
            </UnstyledButton>
          </Stack>
        )}
        {optionsOpen && (
        <Radio.Group label="When did this wallet first receive a payment?" value={when} onChange={(v) => setWhen(v as FirstFunds)}>
          <Stack gap="xs" mt="xs">
            <Radio value="unknown" label="I don't know: find everything" />
            <Radio value="month" label="I know roughly when" />
            <Radio value="never" label="Never: this seed phrase is new" />
          </Stack>
        </Radio.Group>
        )}
        {optionsOpen && when === 'unknown' && (
          <>
            <SegmentedControl
              aria-label="How to find everything"
              fullWidth
              value={fast ? 'fast' : 'private'}
              onChange={(v) => setFast(v === 'fast')}
              data={[
                { value: 'fast', label: 'Fast restore' },
                { value: 'private', label: 'Private restore' },
              ]}
            />
            <Text size="sm" c="dimmed">
              {fast
                ? FAST_SCAN
                : 'Every block from the first is downloaded and scanned on this device: about 8 to 10 GB on Mainnet. The node learns nothing about your coins.'}
            </Text>
          </>
        )}
        {optionsOpen && when === 'month' && (
          <StartBlockPicker
            value={birthday}
            onChange={(v) => {
              setBirthday(v);
              setStartError(null);
            }}
            node={node}
            network={network}
            month={month}
            onMonthChange={setMonth}
            onLookup={setLookup}
            error={startError}
          />
        )}
        {optionsOpen && when === 'never' && (
          <Text size="sm" c="dimmed">
            The wallet starts at the current block. Anything paid to this seed phrase before now would not show.
          </Text>
        )}
        <Button disabled={words.length !== 18 || !startKnown} loading={checking} onClick={() => void continueWithPhrase()}>Continue with this seed phrase</Button>
        <Button variant="subtle" onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}
