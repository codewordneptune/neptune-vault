// Account creation and import (F1 to F5): generate or enter a phrase,
// confirm it word by word, set a password.

import { Alert, Button, Checkbox, Group, Paper, PasswordInput, Select, Stack, Text, Textarea, Title, SegmentedControl } from '@mantine/core';
import { IconCopy, IconFileUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { showBlock, useApp } from '../app/AppContext';
import { PocNotice } from '../components/PocNotice';
import { StartBlockPicker } from '../components/StartBlockPicker';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { NETWORK_OPTIONS } from '../util/network';
import type { NodeClient } from '../node/rpc';
import type { Network } from '../storage/db';
import type { ExportFile } from '../storage/envelope';

type Step = 'welcome' | 'show' | 'confirm' | 'password' | 'import' | 'file';

// The draft phrase lives in this tab's session storage until the account
// exists, so a screenshot, app switch, tab discard or reload does not throw
// the user back to the start. It has no funds behind it yet, is invisible to
// other tabs and sites, and is wiped on completion or when the tab closes.
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
    return raw ? (JSON.parse(raw) as Draft) : null;
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
  // An imported phrase that never received funds starts at the tip (0 = unknown, resolved at first sync).
  const [fromTip, setFromTip] = useState(false);
  const [fast, setFast] = useState(draft?.fast ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Confirmation: CHECKS random positions are blanked and their words go
  // into a shuffled bank; the user taps them back into place (as the desktop
  // wallet does). A wrong placement can be undone by tapping the slot.
  const [checks, setChecks] = useState<number[]>([]);
  const [slots, setSlots] = useState<Record<number, string>>({});
  const [bank, setBank] = useState<string[]>([]);

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
    setBank(shuffle(sorted.map((i) => phrase[i])));
    setStep('confirm');
  };

  const pick = (bankIndex: number) => {
    const target = checks.find((i) => slots[i] === undefined);
    if (target === undefined) return;
    setSlots({ ...slots, [target]: bank[bankIndex] });
    setBank(bank.filter((_, i) => i !== bankIndex));
  };

  const unpick = (position: number) => {
    const word = slots[position];
    if (word === undefined) return;
    const rest = { ...slots };
    delete rest[position];
    setSlots(rest);
    setBank([...bank, word]);
  };

  const allPlaced = bank.length === 0 && checks.length > 0;
  const confirmed = allPlaced && checks.every((i) => slots[i] === phrase[i]);

  const finish = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      const fastRestore = imported && fast;
      let height = imported && (fromTip || fastRestore) ? 0 : Number(birthday) || 1;
      if (imported && !fromTip && !fastRestore) {
        // Refuse a start above the chain when the node can say where it is.
        try {
          const tip = await services.node().probe();
          if (height > tip) throw new Error(`The chain is only at block ${showBlock(tip)}; enter that or a lower block`);
        } catch (e) {
          if ((e as Error).message.startsWith('The chain is only')) throw e;
          // Node unreachable: the sync clamps the height on first contact.
        }
      }
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
      const parsed = JSON.parse(await file.text()) as ExportFile;
      await pauseSync();
      const record = await services.accounts.importFile(parsed, password, { fastRestore: fast });
      saveDraft(null);
      await services.updateSettings({ currentAccountId: record.id, network: record.network });
      setAccount(record);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      {error && <Alert color="red">{error}</Alert>}

      {step === 'welcome' && !adding && <PocNotice />}
      {step === 'welcome' && (
        <Paper>
          <Stack>
            <Title order={2}>{adding ? 'Add a wallet' : 'Set up your wallet'}</Title>
            <Text size="sm" c="dimmed">
              {adding
                ? 'Another seed phrase, with its own password and its own backup. The wallet you have stays on this device; the header menu switches between them.'
                : 'This wallet keeps your keys on this device only. Your seed phrase is the only backup.'}
            </Text>
            <Select
              label="Network"
              data={NETWORK_OPTIONS}
              value={network}
              onChange={(v) => {
                if (!v) return;
                setNetwork(v as Network);
                void switchNetwork(v as Network);
              }}
            />
            <Button onClick={startCreate} loading={busy}>With a new seed phrase</Button>
            <Button variant="light" onClick={() => setStep('import')}>With a seed phrase you have</Button>
            <Button variant="light" onClick={() => setStep('file')}>From a backup file</Button>
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
            <Title order={2}>Write down these 18 words</Title>
            <Text size="sm" c="dimmed">In order, on paper. Anyone with these words can spend your funds. Clearing the browser deletes everything except what you write down.</Text>
            <WordGrid words={phrase} />
            <Group justify="space-between" align="center">
              <Button variant="subtle" size="compact-sm" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(phrase.join(' '), 'Seed phrase copied')}>
                Copy words
              </Button>
              <Text size="xs" c="dimmed">
                Other apps can read the clipboard; paste into a password manager, then clear it.
              </Text>
            </Group>
            <Button onClick={startConfirm}>I have written them down</Button>
            <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); setStep('welcome'); }}>
              Cancel
            </Button>
            <Text size="xs" c="dimmed" ta="center">
              If you cancel, the words above will not be used.
            </Text>
          </Stack>
        </Paper>
      )}

      {step === 'confirm' && (
        <Paper>
          <Stack>
            <span className="vault-eyebrow">Step 2 of 3</span>
            <Title order={2}>Confirm your seed phrase</Title>
            <Text size="sm" c="dimmed">Tap the words below to put them back in their places.</Text>
            <WordGrid
              words={phrase.map((w, i) => (checks.includes(i) ? (slots[i] ?? '') : w))}
              blanks={checks}
              onClear={unpick}
            />
            <Group gap="xs" justify="center" mih={44}>
              {bank.map((w, i) => (
                <Button key={`${w}-${i}`} variant="default" className="vault-chip" onClick={() => pick(i)}>
                  {w}
                </Button>
              ))}
            </Group>
            {allPlaced && !confirmed && (
              <Alert color="yellow">Some words are in the wrong place. Tap a word to take it out and try again.</Alert>
            )}
            <Group>
              <Button variant="subtle" onClick={() => setStep('show')}>Show the words again</Button>
              <Button disabled={!confirmed} onClick={() => setStep('password')}>Continue</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      {step === 'password' && (
        <PasswordStep busy={busy} onSubmit={finish} stepLabel={imported ? 'Step 2 of 2' : 'Step 3 of 3'} onBack={() => setStep(imported ? 'import' : 'confirm')} />
      )}

      {step === 'import' && (
        <ImportStep
          birthday={birthday}
          setBirthday={setBirthday}
          fromTip={fromTip}
          setFromTip={setFromTip}
          fast={fast}
          setFast={setFast}
          node={() => services.node()}
          initialText={imported ? phrase.join(' ') : ''}
          checkPhrase={(words) => services.core.phraseProblem(words)}
          onPhrase={(words) => {
            setPhrase(words);
            setImported(true);
            saveDraft({ phrase: words, network, imported: true, birthday, fast });
            setStep('password');
          }}
          onBack={() => setStep('welcome')}
        />
      )}

      {step === 'file' && <FileStep busy={busy} onFile={importFile} onBack={() => setStep('welcome')} />}
    </Stack>
  );
}

// Restore from a backup file made by this app: the file carries the seed,
// the network, the start block and the contacts; its password opens it.
function FileStep({ busy, onFile, onBack }: { busy: boolean; onFile: (file: File, password: string, fast: boolean) => void; onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [fast, setFast] = useState(true);
  return (
    <Paper>
      <Stack>
        <Title order={2}>Restore a backup file</Title>
        <Text size="sm" c="dimmed">A file exported by this app, opened with the password it was saved under. It brings back the seed phrase, the network, the start block and your contacts.</Text>
        <input ref={fileInput} type="file" aria-label="Backup file" accept="application/json,.json" hidden onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <Group align="center">
          <Button variant="default" leftSection={<IconFileUpload size={16} stroke={1.8} />} onClick={() => fileInput.current?.click()}>
            Choose backup file
          </Button>
          <Text size="sm" c={file ? undefined : 'dimmed'} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file ? file.name : 'No file chosen'}
          </Text>
        </Group>
        <PasswordInput label="Backup file password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
        <SegmentedControl
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
            ? "The node's coin index says which blocks hold payments to you, and only those are fetched: seconds, not hours. The node learns which coins are yours, though not the amounts."
            : 'Every block from the start block in the file is downloaded and scanned on this device. The node learns nothing about your coins.'}
        </Text>
        <Button disabled={!file || !password} loading={busy} onClick={() => file && onFile(file, password, fast)}>
          Restore
        </Button>
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

function PasswordStep({ busy, onSubmit, stepLabel, onBack }: { busy: boolean; onSubmit: (password: string) => void; stepLabel: string; onBack: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const ok = password.length >= 8 && password === again;
  // Length is the only signal worth showing; anything finer misleads. The
  // word is coloured, not a bar: four words say as much as the app knows.
  const level = password.length === 0 ? null : password.length < 8 ? 'short' : password.length < 12 ? 'weak' : password.length < 16 ? 'good' : 'strong';
  const strengthWord = { short: 'Too short', weak: 'Weak', good: 'Good', strong: 'Strong' } as const;
  const strengthColour = level === 'short' ? 'red' : level === 'weak' ? 'yellow' : 'green';
  return (
    <Paper>
      <Stack>
        <span className="vault-eyebrow">{stepLabel}</span>
        <Title order={2}>Choose a password</Title>
        <Text size="sm" c="dimmed">
          It only protects the seed phrase stored on this device and is asked for on every unlock. It cannot be recovered, but the seed phrase can always restore the wallet, so a forgotten password costs a re-import, not your funds.
        </Text>
        <PasswordInput
          label="Password (at least 8 characters)"
          description={
            level ? (
              <>
                Strength:{' '}
                <Text span inherit fw={600} c={strengthColour}>
                  {strengthWord[level]}
                </Text>
              </>
            ) : (
              'Longer beats complicated.'
            )
          }
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <PasswordInput label="Repeat" value={again} onChange={(e) => setAgain(e.currentTarget.value)} error={again && again !== password ? 'Passwords differ' : undefined} />
        <Button disabled={!ok} loading={busy} onClick={() => onSubmit(password)}>Create wallet</Button>
        <Button variant="subtle" disabled={busy} onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}

function ImportStep({
  birthday,
  setBirthday,
  fromTip,
  setFromTip,
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
  fromTip: boolean;
  setFromTip: (v: boolean) => void;
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
  const continueWithPhrase = async () => {
    const lower = words.map((w) => w.toLowerCase());
    setChecking(true);
    try {
      const problem = await checkPhrase(lower);
      if (problem) setPhraseError(problem);
      else onPhrase(lower);
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
        <Title order={2}>Import a seed phrase</Title>
        <Textarea
          label="Seed phrase (18 words)"
          description={words.length ? words.length + ' of 18 words' : undefined}
          autosize
          minRows={3}
          value={text}
          error={phraseError ?? undefined}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setPhraseError(null);
          }}
        />
        <SegmentedControl
          fullWidth
          value={fast ? 'fast' : 'private'}
          onChange={(v) => setFast(v === 'fast')}
          data={[
            { value: 'fast', label: 'Fast restore' },
            { value: 'private', label: 'Private restore' },
          ]}
        />
        {fast ? (
          <Text size="sm" c="dimmed">
            The node's coin index says which blocks hold payments to you, and only those are fetched: seconds, not hours. The node learns which coins are yours, though not the amounts.
          </Text>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              Every block from the one you choose is downloaded and scanned on this device. The node learns nothing about your coins.
            </Text>
            <StartBlockPicker
              value={birthday}
              onChange={setBirthday}
              node={node}
              disabled={fromTip}
              description="The block your first funds arrived in, or earlier. From block 1 on Mainnet the scan downloads about 8 to 10 GB; a later block saves most of it."
            />
            <Checkbox label="This seed phrase has never received funds: start from the current block" checked={fromTip} onChange={(e) => setFromTip(e.currentTarget.checked)} />
          </>
        )}
        <Button disabled={words.length !== 18} loading={checking} onClick={() => void continueWithPhrase()}>Continue with this seed phrase</Button>
        <Button variant="subtle" onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}
