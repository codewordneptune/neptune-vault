// Send screen (F15 to F18, R23): one recipient, amount, fee; validation
// before a review step; the proof itself runs as a job in the app context
// so it survives this screen being unmounted (backgrounding locks the app).

import { ActionIcon, Alert, Button, Group, Paper, Progress, SegmentedControl, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconAddressBook, IconClipboard, IconScan } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { formatNau, useApp } from '../app/AppContext';
import { RequiresLustrationError } from '../app/send';
import { ContactPicker } from '../components/ContactPicker';
import { QrScanner } from '../components/QrScanner';
import { ContactForm } from './Contacts';
import { abbreviateAddress, addressKindLabel, parsePaymentText } from '../util/address';
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
const presetFee = (preset: string, custom: string | undefined) =>
  preset === 'custom' ? (custom ?? '') : (FEE_PRESETS.find((p) => p.value === preset)?.fee ?? DEFAULT_FEE);

type Step = 'form' | 'review';

export function Send() {
  const { services, account, balance, sendJob, startSend, cancelSend, dismissSendJob } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const prefill = (location.state as { recipient?: string } | null)?.recipient;
  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState(prefill ?? '');
  const [picking, setPicking] = useState(false);
  // The last successfully sent recipient, offered for saving as a contact.
  const [lastRecipient, setLastRecipient] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  // From a payment link: shown on the review step, never used for anything else.
  const [linkMeta, setLinkMeta] = useState<{ label?: string; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account || !lastRecipient) return;
    void services.contacts.findByAddress(account.id, lastRecipient).then((c) => setSavedName(c?.name ?? null));
  }, [services, account, lastRecipient]);
  const [amount, setAmount] = useState('');
  // The fee level is remembered between sends (settings).
  const [feePreset, setFeePreset] = useState(services.settings.feePreset ?? DEFAULT_PRESET);
  const [fee, setFee] = useState(presetFee(services.settings.feePreset ?? DEFAULT_PRESET, services.settings.feeCustom));
  const [reviewName, setReviewName] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ amountNau: bigint; feeNau: bigint } | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

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
    if ('nau' in a && 'nau' in f) {
      if (a.nau + f.nau > balance.spendableNau) {
        amountMessage = `Amount plus fee exceeds the spendable balance of ${formatNau(balance.spendableNau)} NPT`;
      } else {
        setTotals({ amountNau: a.nau, feeNau: f.nau });
      }
    }
    setAmountError(amountMessage);
    setFeeError(feeMessage);
    return amountMessage === null && feeMessage === null;
  };

  // Everything spendable minus the current fee; the fee must parse first.
  const sendAll = async () => {
    const f = await parsePositive(fee, 'fee');
    if ('message' in f) {
      setFeeError(f.message);
      return;
    }
    const max = balance.spendableNau - f.nau;
    if (max <= 0n) {
      setAmountError(`The fee alone exceeds the spendable balance of ${formatNau(balance.spendableNau)} NPT`);
      return;
    }
    setAmount(formatNau(max));
    setAmountError(null);
  };

  const review = async () => {
    const [okAddress, okAmounts] = await Promise.all([checkRecipient(), checkAmounts()]);
    if (!(okAddress && okAmounts)) return;
    const contact = account ? await services.contacts.findByAddress(account.id, recipient.trim()) : undefined;
    setReviewName(contact?.name ?? null);
    setStep('review');
  };

  const send = async (acceptLustration: boolean) => {
    if (!account) return;
    setAskLustration(false);
    try {
      const sentTo = recipient.trim().toLowerCase();
      await startSend({ recipient: recipient.trim(), amount: amount.trim(), fee: fee.trim(), accept_lustration: acceptLustration });
      setLastRecipient(sentTo);
      setRecipient('');
      setAmount('');
      setStep('form');
    } catch (e) {
      if (e instanceof RequiresLustrationError) {
        dismissSendJob();
        setAskLustration(true);
      }
      // Other failures are shown from the job state below.
    }
  };

  const applyText = useCallback(
    (text: string) => {
      const parsed = parsePaymentText(text);
      if (parsed.error) {
        setRecipientError(parsed.error);
        return;
      }
      setRecipient(parsed.address);
      setRecipientError(null);
      if (parsed.amount) setAmount(parsed.amount);
      setLinkMeta(parsed.label || parsed.message ? { label: parsed.label, message: parsed.message } : null);
    },
    [],
  );

  const onScanned = useCallback(
    (text: string) => {
      setScanning(false);
      applyText(text);
    },
    [applyText],
  );

  const paste = async () => {
    setPasteError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) setPasteError('The clipboard is empty.');
      else applyText(text);
    } catch {
      setPasteError('Clipboard access was refused. Long-press the field to paste instead.');
    }
  };

  const running = Boolean(sendJob && !sendJob.done);
  const p = sendJob?.progress.proving;
  const proving = sendJob?.progress.stage === 'proving';

  if (running && sendJob) {
    return (
      <Paper>
        <Stack>
          <Title order={2}>Sending</Title>
          <Text>
            {sendJob.progress.stage === 'planning' && 'Choosing inputs…'}
            {sendJob.progress.stage === 'membership-proofs' && 'Fetching membership proofs…'}
            {sendJob.progress.stage === 'building' && 'Building the transaction…'}
            {proving && (p ? `Proving, step ${Math.min(p.index + 1, p.total)} of ${p.total}` : 'Starting the prover…')}
            {sendJob.progress.stage === 'submitting' && 'Submitting to the node…'}
          </Text>
          {proving && p && <Progress value={(100 * p.index) / p.total} animated />}
          {proving && p && (
            <Text size="xs" c="dimmed">
              {p.elapsedSeconds.toFixed(0)} s so far, {p.threads || 'single'} threads{p.memoryMb ? `, ${p.memoryMb.toFixed(0)} MB` : ''}. You can switch apps; the proof continues and the app tells you when it is submitted.
            </Text>
          )}
          {proving && (
            <Button variant="light" color="red" onClick={cancelSend}>
              Cancel
            </Button>
          )}
        </Stack>
      </Paper>
    );
  }

  if (step === 'review' && totals) {
    const totalNau = totals.amountNau + totals.feeNau;
    const kind = addressKindLabel(recipient);
    return (
      <Paper>
        <Stack>
          <Title order={2}>Review</Title>
          <Text size="sm" c="dimmed">
            Check everything once more. The proof takes a few minutes and cannot be changed after it starts.
          </Text>
          <div className="vault-review">
            <div>
              <span className="vault-eyebrow">To</span>
              {reviewName && (
                <Text size="lg" fw={600}>
                  {reviewName}
                </Text>
              )}
              <Text ff="monospace" size="sm" c={reviewName ? 'dimmed' : undefined}>
                {abbreviateAddress(recipient)}
              </Text>
              <Text size="xs" c="dimmed">
                {kind} address
              </Text>
              {linkMeta?.label && (
                <Text size="sm" mt={4}>
                  Payee named in the link: {linkMeta.label}
                </Text>
              )}
              {linkMeta?.message && (
                <Text size="sm" c="dimmed">
                  Note from the link: {linkMeta.message}
                </Text>
              )}
            </div>
            <div className="vault-review-row">
              <span>Amount</span>
              <b>{formatNau(totals.amountNau)} NPT</b>
            </div>
            <div className="vault-review-row">
              <span>Fee</span>
              <b>{formatNau(totals.feeNau)} NPT</b>
            </div>
            <div className="vault-review-row total">
              <span>Total</span>
              <b>{formatNau(totalNau)} NPT</b>
            </div>
            <div className="vault-review-row">
              <span>Balance after</span>
              <b>{formatNau(balance.spendableNau - totalNau)} NPT</b>
            </div>
          </div>
          {askLustration && (
            <Alert color="yellow" title="One more thing">
              This transaction has to include an extra public announcement the network requires right now. It does not change the amount.
            </Alert>
          )}
          <Group grow>
            <Button variant="default" onClick={() => setStep('form')}>
              Edit
            </Button>
            <Button onClick={() => void send(askLustration)}>{askLustration ? 'Send anyway' : 'Send now'}</Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper>
      <Stack>
        <Group justify="space-between" align="center">
          <div>
            <Title order={2}>Send</Title>
            <Text size="sm" c="dimmed">
              Spendable {formatNau(balance.spendableNau)} NPT
            </Text>
          </div>
          <Button size="compact-md" variant="light" leftSection={<IconAddressBook size={16} stroke={1.8} />} onClick={() => navigate('/contacts')}>
            Contacts
          </Button>
        </Group>
        {sendJob?.done && sendJob.outcome && (
          <Alert color="green" title="Submitted" withCloseButton onClose={dismissSendJob}>
            {sendJob.request.amount} NPT is on its way. It shows as pending until the network includes it
            {sendJob.outcome.proving.seconds > 0 && `; the proof took ${sendJob.outcome.proving.seconds.toFixed(0)} s`}.
            {lastRecipient && (
              <div style={{ marginTop: 8 }}>
                {savedName ? (
                  <Text size="sm">Sent to {savedName}.</Text>
                ) : (
                  <Button size="compact-sm" variant="light" onClick={() => setSaving(true)}>
                    Save recipient as a contact
                  </Button>
                )}
              </div>
            )}
          </Alert>
        )}
        {sendJob?.done && sendJob.error && (
          <Alert color="red" title="Not sent" withCloseButton onClose={dismissSendJob}>
            {sendJob.error}
          </Alert>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          <Stack>
            <TextInput
              label="Recipient address"
              value={recipient}
              onChange={(e) => {
                const value = e.currentTarget.value;
                // A payment link arriving by any route (keyboard paste, share)
                // is split into its fields, the same as Paste and Scan do.
                if (/^s*[a-z]+:/i.test(value) && value.includes('1')) applyText(value);
                else {
                  setRecipient(value);
                  setRecipientError(null);
                  setLinkMeta(null);
                }
              }}
              onBlur={() => void checkRecipient()}
              error={recipientError ?? pasteError}
              rightSectionWidth={118}
              rightSection={
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Saved recipients">
                    <ActionIcon variant="subtle" aria-label="Choose a saved recipient" onClick={() => setPicking(true)}>
                      <IconAddressBook size={18} stroke={1.8} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Paste">
                    <ActionIcon variant="subtle" aria-label="Paste address" onClick={() => void paste()}>
                      <IconClipboard size={18} stroke={1.8} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Scan QR code">
                    <ActionIcon variant="subtle" aria-label="Scan a QR code" onClick={() => setScanning(true)}>
                      <IconScan size={18} stroke={1.8} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              }
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
              rightSectionWidth={64}
              rightSection={
                <Button variant="subtle" size="compact-sm" onClick={() => void sendAll()} disabled={balance.spendableNau <= 0n}>
                  Max
                </Button>
              }
            />
            <div>
              <Text size="sm" fw={500} mb={6}>
                Fee (NPT)
              </Text>
              <SegmentedControl
                fullWidth
                value={feePreset}
                onChange={(v) => {
                  setFeePreset(v);
                  const preset = FEE_PRESETS.find((x) => x.value === v);
                  if (preset && preset.fee) setFee(preset.fee);
                  else if (v === 'custom') setFee(services.settings.feeCustom ?? '');
                  void services.updateSettings({ feePreset: v });
                }}
                data={FEE_PRESETS.map((x) => ({
                  value: x.value,
                  label: (
                    <span className="vault-fee-seg">
                      <span>{x.label}</span>
                      <small>{x.fee || 'any'}</small>
                    </span>
                  ),
                }))}
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
                  void services.updateSettings({ feeCustom: e.currentTarget.value });
                }}
                onBlur={() => void checkAmounts()}
                error={feeError}
                autoFocus
              />
            )}
            <Button type="submit" disabled={!recipient || !amount || !fee || Boolean(recipientError || amountError || feeError)}>
              Review
            </Button>
          </Stack>
        </form>
      </Stack>
      <QrScanner opened={scanning} onClose={() => setScanning(false)} onResult={onScanned} />
      <ContactPicker
        opened={picking}
        onClose={() => setPicking(false)}
        onPick={(c) => {
          setPicking(false);
          setRecipient(c.address);
          setRecipientError(null);
        }}
      />
      {lastRecipient && (
        <ContactForm
          opened={saving}
          onClose={() => setSaving(false)}
          fixedAddress={lastRecipient}
          onSave={async (name, address) => {
            if (!account) return;
            const c = await services.contacts.add(account.id, name, address);
            setSavedName(c.name);
            setSaving(false);
          }}
        />
      )}
    </Paper>
  );
}
