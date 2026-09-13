// Account creation and import (F1 to F5): generate or enter a phrase,
// confirm it word by word, set a password.

import { Alert, Button, Group, NumberInput, Paper, PasswordInput, Select, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
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
  const { services, setAccount } = useApp();
  const navigate = useNavigate();
  const draft = loadDraft();
  const [step, setStep] = useState<Step>(draft ? (draft.imported ? 'password' : 'show') : 'welcome');
  const [network, setNetwork] = useState<Network>(draft?.network ?? services.settings.network);
  const [phrase, setPhrase] = useState<string[]>(draft?.phrase ?? []);
  const [imported, setImported] = useState(draft?.imported ?? false);
  const [birthday, setBirthday] = useState<number | string>(draft?.birthday ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Confirmation: three random positions the user must type.
  const [checks, setChecks] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});

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
    while (positions.size < 3) positions.add(Math.floor(Math.random() * phrase.length));
    setChecks([...positions].sort((a, b) => a - b));
    setAnswers({});
    setStep('confirm');
  };

  const confirmed = checks.every((i) => (answers[i] ?? '').trim().toLowerCase() === phrase[i]);

  const finish = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      let height = Number(birthday) || 1;
      if (!imported) {
        // A fresh account has nothing before the current tip.
        try {
          height = Math.max(1, await services.node().probe());
        } catch {
          height = 1;
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

      {step === 'welcome' && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={3}>Welcome</Title>
            <Text>This wallet keeps your keys on this device only. Your seed phrase is the only backup.</Text>
            <Select
              label="Network"
              data={['main', 'testnet', 'regtest']}
              value={network}
              onChange={(v) => {
                if (!v) return;
                setNetwork(v as Network);
                void services.updateSettings({ network: v as Network });
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
        <Paper withBorder p="md">
          <Stack>
            <Title order={3}>Write down these 18 words</Title>
            <Text size="sm">In order, on paper. Anyone with these words can spend your funds. Clearing the browser deletes everything except what you write down.</Text>
            <SimpleGrid cols={3} spacing="xs">
              {phrase.map((w, i) => (
                <Text key={i} ff="monospace" size="sm">
                  {i + 1}. {w}
                </Text>
              ))}
            </SimpleGrid>
            <Button onClick={startConfirm}>I have written them down</Button>
            <Button variant="subtle" onClick={() => { saveDraft(null); setPhrase([]); setStep('welcome'); }}>
              Start over
            </Button>
          </Stack>
        </Paper>
      )}

      {step === 'confirm' && (
        <Paper withBorder p="md">
          <Stack>
            <Title order={3}>Confirm your phrase</Title>
            {checks.map((i) => (
              <Textarea
                key={i}
                label={`Word ${i + 1}`}
                autosize
                minRows={1}
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [i]: e.currentTarget.value })}
                error={(answers[i] ?? '') !== '' && (answers[i] ?? '').trim().toLowerCase() !== phrase[i] ? 'does not match' : undefined}
              />
            ))}
            <Group>
              <Button variant="subtle" onClick={() => setStep('show')}>Show the words again</Button>
              <Button disabled={!confirmed} onClick={() => setStep('password')}>Continue</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      {step === 'password' && <PasswordStep busy={busy} onSubmit={finish} />}

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

function PasswordStep({ busy, onSubmit }: { busy: boolean; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const ok = password.length >= 8 && password === again;
  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={3}>Choose a password</Title>
        <Text size="sm">It encrypts your phrase on this device and is asked for on every unlock. It cannot be recovered.</Text>
        <PasswordInput label="Password (at least 8 characters)" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
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
  const [filePassword, setFilePassword] = useState('');
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={3}>Import</Title>
        <Textarea label="Seed phrase (18 words)" autosize minRows={3} value={text} onChange={(e) => setText(e.currentTarget.value)} />
        <NumberInput label="Scan from block height" description="The block your first funds arrived in, or 1 to scan everything (slow)." min={1} value={birthday} onChange={setBirthday} />
        <Button disabled={words.length !== 18} onClick={() => onPhrase(words.map((w) => w.toLowerCase()))}>Continue with this phrase</Button>
        <Text size="sm" c="dimmed">Or restore a backup file exported by this app:</Text>
        <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        <PasswordInput label="Backup file password" value={filePassword} onChange={(e) => setFilePassword(e.currentTarget.value)} />
        <Button variant="light" disabled={!file || !filePassword} loading={busy} onClick={() => file && onFile(file, filePassword)}>Restore from file</Button>
        <Button variant="subtle" onClick={onBack}>Back</Button>
      </Stack>
    </Paper>
  );
}
