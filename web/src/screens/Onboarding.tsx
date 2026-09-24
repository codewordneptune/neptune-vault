// Account creation and import: generate or enter a phrase,
// confirm it word by word, set a password.

import { Alert, Button, Group, Paper, PasswordInput, Radio, Select, Stack, Text, Textarea, Title, SegmentedControl } from '@mantine/core';
import { IconChevronRight, IconCopy, IconFileUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { showBlock, useApp } from '../app/AppContext';
import { PocNotice } from '../components/PocNotice';
import { NewPasswordFields, newPasswordOk } from '../components/NewPasswordFields';
import { Caution } from '../components/Notice';
import { NATIVE } from '../app/platform';
import { StartBlockPicker, type StartLookup } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { NETWORK_LABELS, NETWORK_OPTIONS } from '../util/network';
import type { NodeClient } from '../node/rpc';
import type { Network } from '../storage/db';
import { notifications } from '@mantine/notifications';
import { MAX_BACKUP_BYTES, parseBackupFile, WrongPasswordError } from '../storage/envelope';

type Step = 'welcome' | 'show' | 'confirm' | 'password' | 'import' | 'file';

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
  const { services, account, setAccount, switchNetwork, pauseSync, network: currentNetwork } = useApp();
  const navigate = useNavigate();
  // Adding a wallet next to an existing one: same steps, a way back to it.
  const adding = Boolean(account) && new URLSearchParams(useLocation().search).has('add');
  const draft = loadDraft();
  const [step, setStep] = useState<Step>(draft ? (draft.imported ? 'password' : 'show') : 'welcome');
  // The network is the app's: a switch made from the header menu must reach
  // the wallet being made here, or it would be saved on the wrong network.
  const [network, setNetwork] = useState<Network>(draft?.network ?? currentNetwork);
  useEffect(() => {
    setNetwork(currentNetwork);
  }, [currentNetwork]);
  const [phrase, setPhrase] = useState<string[]>(draft?.phrase ?? []);
  const [imported, setImported] = useState(draft?.imported ?? false);
  const [birthday, setBirthday] = useState<number | string>(draft?.birthday ?? 1);
  // When an imported phrase first received funds: not known (find everything),
  // a month (scan from its first block), or never (start at the tip; 0 =
  // unknown, resolved at first sync).
  const [when, setWhen] = useState<FirstFunds>('unknown');
  const [month, setMonth] = useState('');
  const [fast, setFast] = useState(draft?.fast ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const [slots, setSlots] = useState<Record<number, string>>({});
  const [bank, setBank] = useState<string[]>([]);
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
    setBank(shuffle(sorted.map((i) => phrase[i])));
    setStep('confirm');
  };

  const pick = (bankIndex: number) => {
    const target = nextSlot;
    if (target === undefined) return;
    setSlots({ ...slots, [target]: bank[bankIndex] });
    setBank(bank.filter((_, i) => i !== bankIndex));
    setPlaced(`Word ${target + 1}: ${bank[bankIndex]}`);
  };

  const unpick = (position: number) => {
    const word = slots[position];
    if (word === undefined) return;
    const rest = { ...slots };
    delete rest[position];
    setSlots(rest);
    setBank([...bank, word]);
    setPlaced(`Word ${position + 1} emptied`);
  };

  const allPlaced = bank.length === 0 && checks.length > 0;
  const confirmed = allPlaced && checks.every((i) => slots[i] === phrase[i]);

  const finish = async (password: string) => {
    setBusy(true);
    setError(null);
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
          height = Math.max(1, await services.node().probe());
        } catch {
          height = 0;
        }
      }
      await pauseSync();
      const record = await services.accounts.createAccount(phrase, password, network, height, { fastRestore });
      saveDraft(null);
      await services.accounts.markBackupConfirmed(record.id);
      await services.updateSettings({ currentAccountId: record.id });
      setAccount({ ...record, backupConfirmed: true });
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
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
      // Files from before version 3 carry their contacts and their start
      // block unprotected: anyone who could write to where the file was
      // kept could have changed them. The restore cannot tell, so it says so.
      if (parsed.version < 3) {
        notifications.show({
          color: 'yellow',
          title: 'Restored from an older backup format',
          message: 'Its contacts and start block were not protected against changes. Check a contact\'s address before you pay them, and export a fresh backup file in Settings.',
          autoClose: false,
        });
      }
      navigate('/');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Wrong password. Use the password the backup was exported with.' : (e as Error).message);
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
            <Title order={2} tabIndex={-1} className="vault-step-title">{adding ? 'Add a wallet' : 'Set up your wallet'}</Title>
            <Text size="sm" c="dimmed">
              {adding
                ? 'Another seed phrase, with its own password and its own backup. The wallet you have stays on this device; the header menu switches between them.'
                : 'Your keys stay on this device. The seed phrase restores the wallet anywhere, and a backup file is an encrypted copy of it.'}
            </Text>
            <Button onClick={startCreate} loading={busy}>Create a new wallet</Button>
            {error && <Alert color="red">{error}</Alert>}
            <Button variant="light" onClick={() => setStep('import')}>Restore with a seed phrase</Button>
            <Button variant="light" onClick={() => setStep('file')}>Restore from a backup file</Button>
            {/* Adding a wallet goes to the network that is open. Choosing another
                here would lock the open wallet at once, with no question asked;
                the header menu asks first, so that is where to switch. */}
            {adding ? (
              <Text size="sm" c="dimmed">
                Adds to {NETWORK_LABELS[network]}. To add on another network, switch network from the header first.
              </Text>
            ) : (
              /* Most people want Mainnet and should not meet the question first.
                 Off Mainnet it is open, so a tester sees where the wallet will go.
                 Named for what it holds, and stating it: a fact to a newcomer, a
                 choice to a tester. Its contents sit under its words, not beside them. */
              <details className="vault-setting" open={network !== 'main'}>
                <summary>
                  <IconChevronRight size={14} stroke={2} className="vault-setting-chevron" aria-hidden />
                  Network: {NETWORK_LABELS[network]}
                </summary>
                <div className="vault-setting-body">
                  <Select
                    aria-label="Network"
                    data={NETWORK_OPTIONS}
                    value={network}
                    onChange={(v) => {
                      if (!v) return;
                      setNetwork(v as Network);
                      void switchNetwork(v as Network);
                    }}
                  />
                </div>
              </details>
            )}
            {draft && (
              <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); }}>
                Discard the unfinished wallet
              </Button>
            )}
            {adding && (
              <Button variant="subtle" onClick={() => navigate('/settings')}>
                Cancel
              </Button>
            )}
          </Stack>
        </Paper>
      )}

      {step === 'show' && (
        <Paper>
          <Stack>
            <span className="vault-eyebrow">Step 1 of 3</span>
            <Title order={2} tabIndex={-1} className="vault-step-title">Write down these 18 words</Title>
            <Text size="sm" c="dimmed">In order, on paper. Anyone with these words can spend your funds. {NATIVE ? 'If this device is lost, only what you write down brings the wallet back.' : 'Clearing the browser deletes everything except what you write down.'}</Text>
            <WordGrid words={phrase} />
            {/* The button, then what copying means, beneath it at every width
                (as a phone wraps it), not squeezed in beside it. */}
            <Stack gap={4} align="flex-start">
              <Button variant="subtle" size="compact-sm" className="vault-button-start" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                Copy words
              </Button>
              <Text size="sm" c="dimmed">
                Other apps can read the clipboard; paste into a password manager, then clear it.
              </Text>
            </Stack>
            <Button onClick={startConfirm}>I have written them down</Button>
            <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); setStep('welcome'); }}>
              Cancel
            </Button>
            <Text size="sm" c="dimmed" ta="center">
              If you cancel, the words above will not be used.
            </Text>
          </Stack>
        </Paper>
      )}

      {step === 'confirm' && (
        <Paper>
          <Stack>
            <span className="vault-eyebrow">Step 2 of 3</span>
            <Title order={2} tabIndex={-1} className="vault-step-title">Confirm your seed phrase</Title>
            <Text size="sm" c="dimmed">
              {nextSlot === undefined
                ? 'Tap a word in the grid to take it out again.'
                : Object.keys(slots).length === 0
                  ? `Tap the missing words in order, starting with word ${nextSlot + 1}.`
                  : `Next: word ${nextSlot + 1}.`}
            </Text>
            <WordGrid
              words={phrase.map((w, i) => (checks.includes(i) ? (slots[i] ?? '') : w))}
              blanks={checks}
              next={nextSlot}
              onClear={unpick}
            />
            <div className="sr-only" aria-live="polite">
              {placed}
            </div>
            <Group gap="xs" justify="center" mih={44}>
              {bank.map((w, i) => (
                <Button key={`${w}-${i}`} variant="default" className="vault-chip" onClick={() => pick(i)}>
                  {w}
                </Button>
              ))}
            </Group>
            {allPlaced && !confirmed && (
              <Caution>Some words are in the wrong place. Tap a word to take it out and try again.</Caution>
            )}
            <Group>
              <Button variant="subtle" onClick={() => setStep('show')}>Show the words again</Button>
              <Button disabled={!confirmed} onClick={() => setStep('password')}>Continue</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      {step === 'password' && (
        <PasswordStep busy={busy} error={error} onSubmit={finish} stepLabel={imported ? 'Step 2 of 2' : 'Step 3 of 3'} actionLabel={imported ? 'Restore wallet' : 'Create wallet'} onBack={() => setStep(imported ? 'import' : 'confirm')} />
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
          node={() => services.node()}
          initialText={imported ? phrase.join(' ') : ''}
          checkPhrase={(words) => services.core.phraseProblem(words)}
          onPhrase={(words) => {
            setPhrase(words);
            setImported(true);
            // Not saved anywhere: see the note on the draft above.
            saveDraft(null);
            setStep('password');
          }}
          onBack={() => setStep('welcome')}
        />
      )}

      {step === 'file' && <FileStep busy={busy} error={error} onFile={importFile} onBack={() => setStep('welcome')} />}
    </Stack>
  );
}

// Restore from a backup file made by this app: the file carries the seed,
// the network, the start block and the contacts; its password opens it.
function FileStep({ busy, error, onFile, onBack }: { busy: boolean; error: string | null; onFile: (file: File, password: string, fast: boolean) => void; onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [fast, setFast] = useState(true);
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
        <Title order={2} tabIndex={-1} className="vault-step-title">Restore a backup file</Title>
        <Text size="sm" c="dimmed">Restores the wallet with its network, start block and contacts. It opens with the password it was saved under.</Text>
        <input ref={fileInput} type="file" aria-label="Backup file" accept="application/json,.json" hidden onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <Group align="center">
          <Button variant="default" leftSection={<IconFileUpload size={16} stroke={1.8} />} onClick={() => fileInput.current?.click()}>
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
        <PasswordInput label="Backup file password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
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
            ? "Takes seconds: only the blocks holding your payments are fetched. The node learns which coins are yours, not the amounts."
            : 'Every block from the start block in the file is downloaded and scanned on this device. The node learns nothing about your coins.'}
        </Text>
        <Button disabled={!file || !password} loading={busy} onClick={() => file && onFile(file, password, fast)}>
          Restore
        </Button>
        {error && <Alert color="red">{error}</Alert>}
        <Button variant="subtle" disabled={busy} onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
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

function PasswordStep({ busy, error, onSubmit, stepLabel, actionLabel, onBack }: { busy: boolean; error: string | null; onSubmit: (password: string) => void; stepLabel: string; actionLabel: string; onBack: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const ok = newPasswordOk(password, again);
  return (
    <Paper>
      <Stack>
        <span className="vault-eyebrow">{stepLabel}</span>
        <Title order={2} tabIndex={-1} className="vault-step-title">Choose a password</Title>
        <Text size="sm" c="dimmed">
          Asked on every unlock, and it cannot be recovered. Forgetting it is not fatal: your seed phrase restores the wallet.
        </Text>
        <NewPasswordFields password={password} onPassword={setPassword} again={again} onAgain={setAgain} />
        <Button disabled={!ok} loading={busy} onClick={() => onSubmit(password)}>{actionLabel}</Button>
        {error && <Alert color="red">{error}</Alert>}
        <Button variant="subtle" disabled={busy} onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}

/** When an imported seed phrase first received funds, as far as the person knows. */
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
  const words = text.trim().split(/\s+/).filter(Boolean);

  // How the month lookup stands: Continue waits for it.
  const [lookup, setLookup] = useState<StartLookup>('idle');
  // A start above the chain, found before the password step rather than after it.
  const [startError, setStartError] = useState<string | null>(null);
  // A month, or a block typed instead, before the scan has somewhere to start.
  const startKnown = when !== 'month' || (lookup !== 'looking' && (lookup === 'found' || Number(birthday) > 1));

  const continueWithPhrase = async () => {
    const lower = words.map((w) => w.toLowerCase());
    setChecking(true);
    try {
      const problem = await checkPhrase(lower);
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
      onPhrase(lower);
    } catch (e) {
      setPhraseError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Paper>
      <Stack>
        <span className="vault-eyebrow">Step 1 of 2</span>
        <Title order={2} tabIndex={-1} className="vault-step-title">Import a seed phrase</Title>
        <Textarea
          label="Seed phrase (18 words)"
          description={words.length === 0 ? undefined : words.length > 18 ? '18 words needed, you have ' + words.length : words.length + ' of 18 words'}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          autosize
          minRows={3}
          value={text}
          error={phraseError ?? undefined}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setPhraseError(null);
          }}
        />
        {/* The question people can answer, instead of a block number. */}
        <Radio.Group label="When did this wallet first receive funds?" value={when} onChange={(v) => setWhen(v as FirstFunds)}>
          <Stack gap="xs" mt="xs">
            <Radio value="unknown" label="I don't know: find everything" />
            <Radio value="month" label="I know roughly when" />
            <Radio value="never" label="Never: this seed phrase is new" />
          </Stack>
        </Radio.Group>
        {when === 'unknown' && (
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
                ? "Takes seconds: only the blocks holding your payments are fetched. The node learns which coins are yours, not the amounts."
                : 'Every block from the first is downloaded and scanned on this device: about 8 to 10 GB on Mainnet. The node learns nothing about your coins.'}
            </Text>
          </>
        )}
        {when === 'month' && (
          <StartBlockPicker
            value={birthday}
            onChange={(v) => {
              setBirthday(v);
              setStartError(null);
            }}
            node={node}
            month={month}
            onMonthChange={setMonth}
            onLookup={setLookup}
            error={startError}
          />
        )}
        {when === 'never' && (
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
