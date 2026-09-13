// Send screen (F15 to F18, R23): one recipient, amount, fee; validation
// before proving; per-sub-proof progress with a wake lock; cancel.

import { Alert, Button, Group, Paper, Progress, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import { formatNau, useApp } from '../app/AppContext';
import { RequiresLustrationError, type SendProgress } from '../app/send';

const DEFAULT_FEE = '0.01';

export function Send() {
  const { services, account, balance, refresh } = useApp();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState(DEFAULT_FEE);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [result, setResult] = useState<{ txid: string; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  useEffect(() => () => void wakeLock.current?.release(), []);

  const validate = async (): Promise<boolean> => {
    const network = services.networkName();
    const okAddress = recipient.trim() !== '' && (await services.core.isValidAddress(recipient, network));
    setRecipientError(okAddress ? null : `Not a valid ${services.settings.network} address`);
    let okAmount = false;
    try {
      const nau = BigInt(await services.core.parseAmount(amount));
      const feeNau = BigInt(await services.core.parseAmount(fee || '0'));
      if (nau <= 0n) setAmountError('Amount must be positive');
      else if (nau + feeNau > balance.spendableNau) setAmountError(`Only ${formatNau(balance.spendableNau)} NPT spendable`);
      else {
        setAmountError(null);
        okAmount = true;
      }
    } catch (e) {
      setAmountError((e as Error).message);
    }
    return okAddress && okAmount;
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
        <Title order={3}>Send</Title>
        {result && (
          <Alert color="teal" title="Submitted">
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
              <TextInput label="Recipient address" value={recipient} onChange={(e) => setRecipient(e.currentTarget.value)} error={recipientError} />
              <TextInput label="Amount (NPT)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} error={amountError} />
              <TextInput label="Fee (NPT)" inputMode="decimal" value={fee} onChange={(e) => setFee(e.currentTarget.value)} />
              <Text size="xs" c="dimmed">
                Spendable: {formatNau(balance.spendableNau)} NPT. Proving takes a few minutes on a phone.
              </Text>
              <Button type="submit" disabled={!recipient || !amount}>
                Send
              </Button>
            </Stack>
          </form>
        )}
      </Stack>
    </Paper>
  );
}
