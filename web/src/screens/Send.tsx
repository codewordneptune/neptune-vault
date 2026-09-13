// Send screen (F15 to F18, R23): one recipient, amount, fee; validation
// before proving; per-sub-proof progress with a wake lock; cancel.

import { Alert, Button, Group, Paper, Progress, SegmentedControl, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import { formatNau, useApp } from '../app/AppContext';
import { RequiresLustrationError, type SendProgress } from '../app/send';
import { networkLabel } from '../util/network';

// Fee presets (R19). Every level clears the default proof-upgrader floor of
// about 0.017 NPT; the spread is for when upgraders or composers have
// transactions to choose between.
const FEE_PRESETS: { value: string; label: string; fee: string }[] = [
  { value: 'low', label: 'Low', fee: '0.1' },
  { value: 'medium', label: 'Medium', fee: '0.3' },
  { value: 'high', label: 'High', fee: '0.5' },
  { value: 'custom', label: 'Custom', fee: '' },
];
const DEFAULT_PRESET = 'medium';
const DEFAULT_FEE = FEE_PRESETS.find((p) => p.value === DEFAULT_PRESET)!.fee;

export function Send() {
  const { services, account, balance, refresh } = useApp();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState(DEFAULT_FEE);
  const [feePreset, setFeePreset] = useState(DEFAULT_PRESET);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<{ txid: string; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  useEffect(() => () => void wakeLock.current?.release(), []);

  // Field checks run on blur and again on submit. A value in nau, or the
  // message explaining why there is none.
  const parsePositive = async (text: string, what: string): Promise<{ nau: bigint } | { message: string }> => {
    if (text.trim() === '') return { message: `Enter the ${what}` };
    if (text.trim().startsWith('-')) return { message: `The ${what} must be greater than zero` };
    let nau: bigint;
    try {
      nau = BigInt(await services.core.parseAmount(text));
    } catch {
      return { message: `The ${what} must be a number, such as 1.5` };
    }
    if (nau <= 0n) return { message: `The ${what} must be greater than zero` };
    return { nau };
  };

  const checkRecipient = async (): Promise<boolean> => {
    const text = recipient.trim();
    if (text === '') {
      setRecipientError('Enter the recipient address');
      return false;
    }
    const ok = await services.core.isValidAddress(text, services.networkName());
    setRecipientError(ok ? null : `Not a valid ${networkLabel(services.settings.network)} address`);
    return ok;
  };

  const checkAmounts = async (): Promise<boolean> => {
    const a = await parsePositive(amount, 'amount');
    const f = await parsePositive(fee, 'fee');
    let amountMessage = 'message' in a ? a.message : null;
    const feeMessage = 'message' in f ? f.message : null;
    if ('nau' in a && 'nau' in f && a.nau + f.nau > balance.spendableNau) {
      amountMessage = `Amount plus fee exceeds the spendable balance of ${formatNau(balance.spendableNau)} NPT`;
    }
    setAmountError(amountMessage);
    setFeeError(feeMessage);
    return amountMessage === null && feeMessage === null;
  };

  const validate = async (): Promise<boolean> => {
    const [okAddress, okAmounts] = await Promise.all([checkRecipient(), checkAmounts()]);
    return okAddress && okAmounts;
  };

  const send = async (acceptLustration: boolean) => {
    if (!account || !(await validate())) return;
    setError(null);
    setResult(null);
    setAskLustration(false);
    try {
      wakeLock.current = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      wakeLock.current = null;
    }
    try {
      const outcome = await services.sendService(account.id).send(
        { recipient: recipient.trim(), amount: amount.trim(), fee: fee.trim() || '0', accept_lustration: acceptLustration },
        setProgress,
      );
      setResult({ txid: outcome.txid, seconds: outcome.proving.seconds });
      setRecipient('');
      setAmount('');
      await refresh();
    } catch (e) {
      if (e instanceof RequiresLustrationError) setAskLustration(true);
      else setError((e as Error).message);
    } finally {
      setProgress(null);
      await wakeLock.current?.release();
      wakeLock.current = null;
    }
  };

  const cancel = () => {
    services.prover.cancel();
    setProgress(null);
    setError('Cancelled.');
  };

  const proving = progress?.stage === 'proving';
  const p = progress?.proving;

  return (
    <Paper>
      <Stack>
        <Title order={2}>Send</Title>
        {result && (
          <Alert color="green" title="Submitted">
            Transaction {result.txid.slice(0, 16)}… is pending. Proof took {result.seconds.toFixed(0)} s.
          </Alert>
        )}
        {error && <Alert color="red">{error}</Alert>}
        {askLustration && (
          <Alert color="yellow" title="Lustration required">
            <Text size="sm">The chain currently requires lustration announcements for these inputs. Continue?</Text>
            <Group mt="xs">
              <Button onClick={() => void send(true)}>Continue</Button>
              <Button variant="subtle" onClick={() => setAskLustration(false)}>Cancel</Button>
            </Group>
          </Alert>
        )}

        {progress ? (
          <Stack>
            <Text>
              {progress.stage === 'planning' && 'Choosing inputs…'}
              {progress.stage === 'membership-proofs' && 'Fetching membership proofs…'}
              {progress.stage === 'building' && 'Building the transaction…'}
              {proving && (p ? `Proving ${Math.min(p.index + 1, p.total)} of ${p.total}${p.name ? `: ${p.name}` : ''}` : 'Starting the prover…')}
              {progress.stage === 'submitting' && 'Submitting to the node…'}
            </Text>
            {proving && p && <Progress value={(100 * p.index) / p.total} animated />}
            {proving && p && (
              <Text size="xs" c="dimmed">
                {p.elapsedSeconds.toFixed(0)} s so far, {p.threads || 'single'} threads{p.memoryMb ? `, ${p.memoryMb.toFixed(0)} MB` : ''}. Keep the app open.
              </Text>
            )}
            {proving && (
              <Button variant="light" color="red" onClick={cancel}>
                Cancel
              </Button>
            )}
          </Stack>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(false);
            }}
          >
            <Stack>
              <TextInput
                label="Recipient address"
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.currentTarget.value);
                  setRecipientError(null);
                }}
                onBlur={() => void checkRecipient()}
                error={recipientError}
              />
              <TextInput
                label="Amount (NPT)"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.currentTarget.value);
                  setAmountError(null);
                }}
                onBlur={() => void checkAmounts()}
                error={amountError}
              />
              <div>
                <Text size="sm" fw={500} mb={6}>
                  Fee{feePreset !== 'custom' && `: ${fee} NPT`}
                </Text>
                <SegmentedControl
                  fullWidth
                  value={feePreset}
                  onChange={(v) => {
                    setFeePreset(v);
                    const preset = FEE_PRESETS.find((p) => p.value === v);
                    if (preset && preset.fee) setFee(preset.fee);
                  }}
                  data={FEE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                />
              </div>
              {feePreset === 'custom' && (
                <TextInput
                  label="Custom fee (NPT)"
                  inputMode="decimal"
                  value={fee}
                  onChange={(e) => {
                    setFee(e.currentTarget.value);
                    setFeeError(null);
                  }}
                  onBlur={() => void checkAmounts()}
                  error={feeError}
                  autoFocus
                />
              )}
              <Text size="xs" c="dimmed">
                Spendable: {formatNau(balance.spendableNau)} NPT. Proving takes a few minutes on a phone.
              </Text>
              <Button type="submit" disabled={!recipient || !amount || !fee || Boolean(recipientError || amountError || feeError)}>
                Send
              </Button>
            </Stack>
          </form>
        )}
      </Stack>
    </Paper>
  );
}
