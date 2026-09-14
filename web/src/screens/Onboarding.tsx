// Account creation and import (F1 to F5): generate or enter a phrase,
// confirm it word by word, set a password.

import { Alert, Button, Group, NumberInput, Paper, PasswordInput, Select, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconCopy, IconFileUpload } from '@tabler/icons-react';
import { useRef } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { PocNotice } from '../components/PocNotice';
import { WordGrid } from '../components/WordGrid';
import { copyText } from '../util/clipboard';
import { NETWORK_OPTIONS } from '../util/network';
import type { Network } from '../storage/db';
import type { ExportFile } from '../storage/envelope';

type Step = 'welcome' | 'show' | 'confirm' | 'password' | 'import';

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
  const { services, setAccount, switchNetwork } = useApp();
  const navigate = useNavigate();
  const draft = loadDraft();
  const [step, setStep] = useState<Step>(draft ? (draft.imported ? 'password' : 'show') : 'welcome');
  const [network, setNetwork] = useState<Network>(draft?.network ?? services.settings.network);
  const [phrase, setPhrase] = useState<string[]>(draft?.phrase ?? []);
  const [imported, setImported] = useState(draft?.imported ?? false);
  const [birthday, setBirthday] = useState<number | string>(draft?.birthday ?? 1);
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
      let height = Number(birthday) || 1;
      if (imported) {
        // Refuse a start above the chain when the node can say where it is.
        try {
          const tip = await services.node().probe();
          if (height > tip) throw new Error(`The chain is only at block ${tip}; enter that or a lower block`);
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
      const record = await services.accounts.createAccount(phrase, password, network, height);
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

  const importFile = async (file: File, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as ExportFile;
      const record = await services.accounts.importFile(parsed, password);
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

      {step === 'welcome' && <PocNotice />}
      {step === 'welcome' && (
        <Paper>
          <Stack>
            <Title order={2}>Welcome</Title>
            <Text size="sm" c="dimmed">This wallet keeps your keys on this device only. Your seed phrase is the only backup.</Text>
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
            <Button onClick={startCreate} loading={busy}>Create a new account</Button>
            <Button variant="light" onClick={() => setStep('import')}>Import a phrase or backup file</Button>
            {draft && (
              <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); }}>
                Discard the unfinished account
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
              Start over
            </Button>
          </Stack>
        </Paper>
      )}

      {step === 'confirm' && (
        <Paper>
          <Stack>
            <span className="vault-eyebrow">Step 2 of 3</span>
            <Title order={2}>Confirm your phrase</Title>
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

      {step === 'password' && <PasswordStep busy={busy} onSubmit={finish} stepLabel={imported ? 'Step 2 of 2' : 'Step 3 of 3'} />}

      {step === 'import' && (
        <ImportStep
          busy={busy}
          birthday={birthday}
          setBirthday={setBirthday}
          onPhrase={(words) => {
            setPhrase(words);
            setImported(true);
            saveDraft({ phrase: words, network, imported: true, birthday });
            setStep('password');
          }}
          onFile={importFile}
          onBack={() => setStep('welcome')}
        />
      )}
    </Stack>
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

function PasswordStep({ busy, onSubmit, stepLabel }: { busy: boolean; onSubmit: (password: string) => void; stepLabel: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const ok = password.length >= 8 && password === again;
  // Length is the only signal worth showing; anything finer misleads.
  const strength = password.length === 0 ? null : password.length < 8 ? 'Too short' : password.length < 12 ? 'Weak' : password.length < 16 ? 'Good' : 'Strong';
  return (
    <Paper>
      <Stack>
        <span className="vault-eyebrow">{stepLabel}</span>
        <Title order={2}>Choose a password</Title>
        <Text size="sm" c="dimmed">
          It only protects the phrase stored on this device and is asked for on every unlock. It cannot be recovered, but the phrase can always restore the wallet, so a forgotten password costs a re-import, not your funds.
        </Text>
        <PasswordInput
          label="Password (at least 8 characters)"
          description={strength ? `Strength: ${strength}. Longer beats complicated.` : 'Longer beats complicated.'}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <PasswordInput label="Repeat" value={again} onChange={(e) => setAgain(e.currentTarget.value)} error={again && again !== password ? 'passwords differ' : undefined} />
        <Button disabled={!ok} loading={busy} onClick={() => onSubmit(password)}>Create wallet</Button>
      </Stack>
    </Paper>
  );
}

function ImportStep({
  busy,
  birthday,
  setBirthday,
  onPhrase,
  onFile,
  onBack,
}: {
  busy: boolean;
  birthday: number | string;
  setBirthday: (v: number | string) => void;
  onPhrase: (words: string[]) => void;
  onFile: (file: File, password: string) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filePassword, setFilePassword] = useState('');
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (
    <Paper>
      <Stack>
        <span className="vault-eyebrow">Step 1 of 2</span>
        <Title order={2}>Import</Title>
        <Textarea label="Seed phrase (18 words)" autosize minRows={3} value={text} onChange={(e) => setText(e.currentTarget.value)} />
        <NumberInput label="Scan from block height" description="The block your first funds arrived in, or 1 to scan everything (slow)." min={1} value={birthday} onChange={setBirthday} />
        <Button disabled={words.length !== 18} onClick={() => onPhrase(words.map((w) => w.toLowerCase()))}>Continue with this phrase</Button>
        <Text size="sm" c="dimmed">Or restore a backup file exported by this app:</Text>
        <input ref={fileInput} type="file" aria-label="Backup file" accept="application/json,.json" hidden onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <Group align="center">
          <Button variant="default" leftSection={<IconFileUpload size={16} stroke={1.8} />} onClick={() => fileInput.current?.click()}>
            Choose backup file
          </Button>
          <Text size="sm" c={file ? undefined : 'dimmed'} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file ? file.name : 'No file chosen'}
          </Text>
        </Group>
        <PasswordInput label="Backup file password" value={filePassword} onChange={(e) => setFilePassword(e.currentTarget.value)} />
        <Button variant="light" disabled={!file || !filePassword} loading={busy} onClick={() => file && onFile(file, filePassword)}>Restore from file</Button>
        <Button variant="subtle" onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}
