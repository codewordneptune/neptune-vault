// Send screen (F15 to F18, R23): one recipient, amount, fee; validation
// before a review step; the proof itself runs as a job in the app context
// so it survives this screen being unmounted (backgrounding locks the app).

import { Alert, Badge, Button, Checkbox, Drawer, Group, Paper, Progress, SegmentedControl, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconAddressBook, IconLink, IconScan } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { formatNau, showNau, useApp } from '../app/AppContext';
import { RequiresLustrationError, SendBusyError } from '../app/send';
import { ContactPicker } from '../components/ContactPicker';
import { Caution } from '../components/Notice';
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
/** Seconds as people say them: "45 seconds", "2 minutes". */
function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

const DEFAULT_PRESET = 'medium';
const DEFAULT_FEE = FEE_PRESETS.find((p) => p.value === DEFAULT_PRESET)!.fee;
const presetFee = (preset: string, custom: string | undefined) =>
  preset === 'custom' ? (custom ?? '') : (FEE_PRESETS.find((p) => p.value === preset)?.fee ?? DEFAULT_FEE);

type Step = 'form' | 'review';

export function Send() {
  const { services, account, balance, utxos, online, sendJob, screenAwake, startSend, cancelSend, dismissSendJob } = useApp();
  const location = useLocation();
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
  // The fee level is remembered between sends (settings); a custom fee is
  // not. It was typed for one payment, and coming back to find an unusual
  // fee already chosen is how someone pays it twice without meaning to.
  const rememberedPreset = services.settings.feePreset && services.settings.feePreset !== 'custom' ? services.settings.feePreset : DEFAULT_PRESET;
  const [feePreset, setFeePreset] = useState(rememberedPreset);
  const [fee, setFee] = useState(presetFee(rememberedPreset, undefined));
  // An unusually high fee must be agreed to on the review sheet, in so many words.
  const [feeAgreed, setFeeAgreed] = useState(false);
  // "Max" in exact nau: the shown text has eight decimals and the balance has more.
  const [maxExact, setMaxExact] = useState<{ text: string; nau: bigint } | null>(null);
  const [reviewName, setReviewName] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  // Focused when Custom is chosen, not whenever the field happens to mount.
  const customFeeRef = useRef<HTMLInputElement>(null);
  const [totals, setTotals] = useState<{ amountNau: bigint; feeNau: bigint; feeHigh: boolean } | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Field checks run on blur and again on submit. A value in nau, or the
  // message explaining why there is none.
  const parsePositive = async (raw: string, what: string): Promise<{ nau: bigint } | { message: string }> => {
    // A pasted "1 234.5" is fine; spaces (including the narrow ones the app shows) are grouping.
    const text = raw.replace(/[\s\u202F\u00A0]/g, '');
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
    const typed = await parsePositive(amount, 'amount');
    // Max means everything: the exact figure, not the eight decimals on screen.
    const a = maxExact && maxExact.text === amount && 'nau' in typed ? { nau: maxExact.nau } : typed;
    const f = await parsePositive(fee, 'fee');
    let amountMessage = 'message' in a ? a.message : null;
    const feeMessage = 'message' in f ? f.message : null;
    if ('nau' in a && 'nau' in f) {
      if (a.nau + f.nau > balance.spendableNau) {
        amountMessage = `Amount plus fee exceeds the spendable balance of ${showNau(balance.spendableNau)} NPT`;
      } else {
        // Unusual: more than 1 NPT, or more than the payment itself and above every preset.
        const one = BigInt(await services.core.parseAmount('1'));
        const topPreset = BigInt(await services.core.parseAmount(FEE_PRESETS.reduce((m, p) => (Number(p.fee) > Number(m) ? p.fee : m), '0')));
        const feeHigh = f.nau > one || (f.nau > a.nau && f.nau > topPreset);
        setTotals({ amountNau: a.nau, feeNau: f.nau, feeHigh });
        setFeeAgreed(false);
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
      setAmountError(`The fee alone exceeds the spendable balance of ${showNau(balance.spendableNau)} NPT`);
      return;
    }
    const text = formatNau(max);
    setAmount(text);
    setMaxExact({ text, nau: max });
    setAmountError(null);
  };

  const review = async () => {
    const [okAddress, okAmounts] = await Promise.all([checkRecipient(), checkAmounts()]);
    if (!(okAddress && okAmounts)) return;
    const contact = account ? await services.contacts.findByAddress(account.id, recipient.trim()) : undefined;
    setReviewName(contact?.name ?? null);
    setStep('review');
  };

  // A second tap while the first is being taken up does nothing at all.
  const [starting, setStarting] = useState(false);
  const send = async (acceptLustration: boolean) => {
    if (!account || starting) return;
    setStarting(true);
    setAskLustration(false);
    try {
      const sentTo = recipient.trim().toLowerCase();
      // The exact figures the review sheet showed go with the request, so the
      // core sends those and never parses the texts a second time, its own way.
      await startSend(
        { recipient: recipient.trim(), amount: amount.trim(), fee: fee.trim(), accept_lustration: acceptLustration, amount_nau: totals?.amountNau.toString(), fee_nau: totals?.feeNau.toString() },
        linkMeta?.message ?? null,
      );
      setLastRecipient(sentTo);
      setRecipient('');
      setAmount('');
      setLinkMeta(null);
      setTotals(null);
      setStep('form');
    } catch (e) {
      if (e instanceof SendBusyError) return;
      if (e instanceof RequiresLustrationError) {
        dismissSendJob();
        setAskLustration(true);
      } else {
        // The failure notice lives on the form.
        setStep('form');
      }
    } finally {
      setStarting(false);
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

  // A finished job's notice belongs to this visit; leaving the screen clears it.
  useEffect(() => {
    return () => {
      if (sendJobRef.current?.done) dismissSendJob();
    };
  }, [dismissSendJob]);
  const sendJobRef = useRef(sendJob);
  sendJobRef.current = sendJob;

  const running = Boolean(sendJob && !sendJob.done);
  const p = sendJob?.progress.proving;
  const proving = sendJob?.progress.stage === 'proving';
  // The prover reports only between sub-proofs, which take minutes, so the
  // elapsed time shown is the wall clock since proving started (kept on the
  // job, so it survives leaving this screen), ticking.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!proving) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [proving]);
  const provingSeconds = sendJob?.provingSince ? Math.max(0, Math.round((now - sendJob.provingSince) / 1000)) : 0;
  // How long the last proof on this device took, when it went through: a
  // better guide than any figure measured elsewhere.
  const last = services.settings.lastProving;
  const estimate = last && !last.error && last.seconds > 0 ? last.seconds : null;

  if (running && sendJob) {
    return (
      <Paper>
        <Stack>
          <Title order={2}>Sending</Title>
          <Text aria-live="polite">
            {sendJob.progress.stage === 'planning' && 'Choosing coins…'}
            {sendJob.progress.stage === 'membership-proofs' && 'Checking your coins with the node…'}
            {sendJob.progress.stage === 'building' && 'Building the transaction…'}
            {proving && (p ? `Proving, step ${Math.min(p.index + 1, p.total)} of ${p.total}` : 'Starting the prover…')}
            {sendJob.progress.stage === 'submitting' && 'Submitting to the node…'}
          </Text>
          {proving && p && <Progress value={100 * (p.work ?? p.index / p.total)} animated aria-label="Share of the proving work done" />}
          {proving && (
            <Text size="sm" c="dimmed">
              {estimate !== null ? `About ${duration(estimate)} on this device · ` : ''}
              {duration(provingSeconds)} so far
            </Text>
          )}
          <Text size="sm">
            {screenAwake === 'refused'
              ? 'This device would not keep the screen on. Keep the app open and touch the screen now and then until the send is submitted: a locked phone pauses the proof.'
              : 'Keep this screen open until the send is submitted.'}
          </Text>
          {proving && (
            <Button variant="light" color="red" onClick={cancelSend}>
              Cancel
            </Button>
          )}
        </Stack>
      </Paper>
    );
  }

  // The review is a sheet over the form, so the form stays in view and
  // "Edit" is a step back rather than a screen change.
  let reviewSheet: ReactNode = null;
  if (step === 'review' && totals) {
    const totalNau = totals.amountNau + totals.feeNau;
    const kind = addressKindLabel(recipient);
    // The coins the core will pick (largest first, then oldest), so the
    // review can say what stays spendable while the send is pending.
    const nowMs = Date.now();
    const coins = utxos
      .filter((u) => u.spentHeight === null && u.pendingTxid === null && (u.releaseDateMs === null || u.releaseDateMs <= nowMs))
      .sort((a, b) => {
        const x = BigInt(a.amountNau);
        const y = BigInt(b.amountNau);
        return x === y ? a.confirmedHeight - b.confirmedHeight : y > x ? 1 : -1;
      });
    let heldNau = 0n;
    for (const c of coins) {
      if (heldNau >= totalNau) break;
      heldNau += BigInt(c.amountNau);
    }
    reviewSheet = (
        <Stack>
          <Text size="sm" c="dimmed">
            Check the details. Once sending starts, the payment cannot be changed. It can take a few minutes on a phone.
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
              <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                {kind}
              </Badge>
            </div>
            <div className="vault-review-row">
              <span>Amount</span>
              <b>{showNau(totals.amountNau)} NPT</b>
            </div>
            <div className="vault-review-row">
              <span>Fee</span>
              <b>{showNau(totals.feeNau)} NPT</b>
            </div>
            <div className="vault-review-row total">
              <span>Total</span>
              <b>{showNau(totalNau)} NPT</b>
            </div>
            {totals.feeNau > totals.amountNau && (
              <Text size="sm" c="var(--v-warn-text)" mt="xs">
                The fee is larger than the amount.
              </Text>
            )}
          </div>
          {(linkMeta?.label || linkMeta?.message) && (
            <div className="vault-link-meta-form">
              <IconLink size={16} stroke={1.8} aria-hidden />
              <div style={{ minWidth: 0 }}>
                {linkMeta.label && (
                  <div style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">
                      Name in the link (unverified)
                    </Text>
                    <Text size="sm" dir="auto" className="vault-bidi vault-link-meta-text">
                      {linkMeta.label}
                    </Text>
                  </div>
                )}
                {linkMeta.message && (
                  <div style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">
                      Note from the link
                    </Text>
                    <Text size="sm" dir="auto" className="vault-bidi vault-link-meta-text">
                      {linkMeta.message}
                    </Text>
                  </div>
                )}
              </div>
            </div>
          )}
          <Text size="sm" c="dimmed">
            Spendable while this is pending: {showNau(balance.spendableNau - heldNau)} NPT. After it confirms, usually within a few blocks: {showNau(balance.spendableNau - totalNau)} NPT.
          </Text>
          {askLustration && (
            <Caution title="Part of this send will be public">
              The network asks this send to publish the coins that pay for it: how much each holds, which of your addresses received it, and where in the chain it came from. Anyone can then link this payment to the ones that funded it. The recipient and the amount you send stay private.
            </Caution>
          )}
          {totals.feeHigh && (
            <Checkbox
              checked={feeAgreed}
              onChange={(e) => setFeeAgreed(e.currentTarget.checked)}
              label={`The fee is ${showNau(totals.feeNau)} NPT, which is unusually high. Pay it anyway.`}
            />
          )}
          <Group grow>
            <Button variant="default" onClick={() => setStep('form')}>
              Edit
            </Button>
            <Button onClick={() => void send(askLustration)} loading={starting} disabled={running || (totals.feeHigh && !feeAgreed)}>{askLustration ? 'Send anyway' : 'Send now'}</Button>
          </Group>
        </Stack>
    );
  }

  return (
    <Paper>
      <Stack>
        <Drawer opened={reviewSheet !== null} onClose={() => setStep('form')} position="bottom" size="auto" title="Review" trapFocus>
          {reviewSheet}
        </Drawer>
        <Group justify="space-between" align="center">
          <div>
            <Title order={2} className="sr-only">
              Send
            </Title>
            <Text size="sm" c="dimmed">
              Spendable {services.settings.hideBalance ? '••••' : showNau(balance.spendableNau)} NPT
            </Text>
          </div>
          <Button size="compact-md" variant="light" className="vault-tap" leftSection={<IconAddressBook size={16} stroke={1.8} />} onClick={() => setPicking(true)}>
            Contacts
          </Button>
        </Group>
        {sendJob?.done && sendJob.outcome && (
          <Alert color="green" title="Submitted" withCloseButton onClose={dismissSendJob}>
            {sendJob.request.amount} NPT is on its way. It shows as pending until it is confirmed
            {sendJob.outcome.proving.seconds > 0 && `; the proof took ${sendJob.outcome.proving.seconds.toFixed(0)} s`}.
            {lastRecipient && (
              <div style={{ marginTop: 8 }}>
                {savedName ? (
                  <Text size="sm">Sent to {savedName}.</Text>
                ) : (
                  <Text size="sm">
                    <UnstyledButton onClick={() => setSaving(true)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
                      Save recipient as a contact
                    </UnstyledButton>
                  </Text>
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
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="Address or payment link"
              value={recipient}
              onChange={(e) => {
                const value = e.currentTarget.value;
                // A payment link arriving by any route (keyboard paste, share)
                // is split into its fields, the same as Paste and Scan do.
                if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyText(value);
                else {
                  setRecipient(value);
                  setRecipientError(null);
                  setLinkMeta(null);
                }
              }}
              onBlur={() => void checkRecipient()}
              error={recipientError}
              rightSectionWidth={80}
              rightSection={
                <Button variant="subtle" size="compact-sm" className="vault-tap" leftSection={<IconScan size={16} stroke={1.8} />} onClick={() => setScanning(true)}>
                  Scan
                </Button>
              }
            />
            {linkMeta && (linkMeta.label || linkMeta.message) && (
              <div className="vault-link-meta-form">
                <IconLink size={16} stroke={1.8} aria-hidden />
                <div style={{ minWidth: 0 }}>
                  {linkMeta.label && (
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" c="dimmed">
                        Name in the link (unverified)
                      </Text>
                      <Text size="sm" dir="auto" className="vault-bidi vault-link-meta-text">
                        {linkMeta.label}
                      </Text>
                    </div>
                  )}
                  {linkMeta.message && (
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" c="dimmed">
                        Note from the link
                      </Text>
                      <Text size="sm" dir="auto" className="vault-bidi vault-link-meta-text">
                        {linkMeta.message}
                      </Text>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                <Button variant="subtle" size="compact-sm" className="vault-tap" onClick={() => void sendAll()} disabled={balance.spendableNau <= 0n}>
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
                aria-label="Fee"
                value={feePreset}
                onChange={(v) => {
                  setFeePreset(v);
                  const preset = FEE_PRESETS.find((x) => x.value === v);
                  if (preset && preset.fee) setFee(preset.fee);
                  else if (v === 'custom') {
                    setFee('');
                    setTimeout(() => customFeeRef.current?.focus(), 0);
                  }
                  if (v !== 'custom') void services.updateSettings({ feePreset: v });
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
              {/* What the fee buys, which the numbers alone do not say. Proof
                  upgraders take part of it for proving the send into a block,
                  and pick the sends that pay them best first. */}
              <Text size="sm" c="dimmed" mt={6}>
                Nodes finish proving your send before it can go into a block, and are paid from the fee. A higher fee gets that done sooner when many sends are waiting.
              </Text>
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
                ref={customFeeRef}
              />
            )}
            {!online && (
              <Caution>You are offline. Sending needs the node; Review comes back when the connection does.</Caution>
            )}
            <Button type="submit" disabled={!online || !recipient || !amount || !fee || Boolean(recipientError || amountError || feeError)}>
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
          // The name and note came with a link, for the link's address. They
          // say nothing about this contact and must not be saved with a payment to them.
          setLinkMeta(null);
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
