// Send screen: a recipient and an amount (or several, paid by one
// transaction), a fee; validation before a review step; the proof itself
// runs as a job in the app context so it survives this screen being
// unmounted (backgrounding locks the app).

import { Alert, Badge, Button, Checkbox, Drawer, Group, Paper, Progress, SegmentedControl, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconAddressBook, IconLink, IconPlus, IconScan } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { formatNau, NAU_PER_COIN, showNau, useApp } from '../app/AppContext';
import { useQuote } from '../app/price';
import { decimalsProblem } from '../util/amount';
import { fiatOf, fiatOfTyped, formatFiat } from '../util/fiat';
import { MAX_PAYMENTS, paymentsTotalNau, RequiresLustrationError, SendBusyError } from '../app/send';
import { ContactPicker } from '../components/ContactPicker';
import { Caution } from '../components/Notice';
import { QrScanner } from '../components/QrScanner';
import { ContactForm } from './Contacts';
import { abbreviateAddress, addressKindLabel, parsePaymentText } from '../util/address';
import { networkLabel } from '../util/network';
import type { ContactRecord } from '../storage/db';

// Fee presets. Every level clears the default proof-upgrader floor of
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

// Where an amount's estimate in another currency sits: under the field, and
// above any error, like the other notes about a field.
const UNDER_THE_FIELD: ('label' | 'input' | 'description' | 'error')[] = ['label', 'input', 'description', 'error'];

/** A recipient after the first: an address, an amount, and what is wrong with them. */
interface ExtraPayee {
  id: number;
  recipient: string;
  amount: string;
  recipientError: string | null;
  amountError: string | null;
}

export function Send() {
  const { services, account, balance, utxos, online, sendJob, screenAwake, startSend, cancelSend, dismissSendJob } = useApp();
  const location = useLocation();
  const prefill = (location.state as { recipient?: string } | null)?.recipient;
  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState(prefill ?? '');
  // The last successfully sent recipient, offered for saving as a contact.
  const [lastRecipient, setLastRecipient] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  // From a payment link: shown on the review step, never used for anything else.
  const [linkMeta, setLinkMeta] = useState<{ label?: string; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // The wallet's contacts, so an address typed, pasted or scanned into a
  // recipient field is named when it is a saved one: the review is too late
  // to notice that the address is not the one meant.
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  // With the balance shown in another currency, each amount is too: as a
  // check on the NPT typed, never as what is sent. No price, or one over an
  // hour old, shows nothing.
  const quote = useQuote(services.settings.fiatCurrency);
  const estimateOf = (text: string) => {
    const value = quote ? fiatOfTyped(text, quote.price) : null;
    return quote && value !== null ? `≈ ${formatFiat(value, quote.currency)}` : undefined;
  };
  const loadContacts = useCallback(() => {
    if (account) void services.contacts.list(account.id).then(setContacts);
  }, [services, account]);
  useEffect(loadContacts, [loadContacts]);
  const contactNote = (address: string) => {
    const wanted = address.trim().toLowerCase();
    const name = wanted ? contacts.find((c) => c.address === wanted)?.name : undefined;
    return name ? (
      <span className="vault-contact-match">
        <IconAddressBook size={14} stroke={1.8} aria-hidden />
        <span>
          Saved contact: <b dir="auto" className="vault-bidi">{name}</b>
        </span>
      </span>
    ) : undefined;
  };

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
  // The contact name of each recipient on the review sheet, when it is one.
  const [reviewNames, setReviewNames] = useState<(string | null)[]>([]);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  // Focused when Custom is chosen, not whenever the field happens to mount.
  const customFeeRef = useRef<HTMLInputElement>(null);
  // As reviewed: each payment in nau (the first recipient's first), their sum, and the fee.
  const [totals, setTotals] = useState<{ amountNau: bigint; feeNau: bigint; feeHigh: boolean; payments: bigint[] } | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  // Which recipient Scan and Choose contact fill: 0 for the first, else an added one's id.
  const [scanFor, setScanFor] = useState<number | null>(null);
  const [pickFor, setPickFor] = useState<number | null>(null);
  // Recipients after the first. Several payments in one transaction take
  // one proof and one fee, and none has to wait for the change of another.
  const [extras, setExtras] = useState<ExtraPayee[]>([]);
  const nextExtraId = useRef(1);
  const updateExtra = (id: number, patch: Partial<ExtraPayee>) => setExtras((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const addRecipient = () => {
    setExtras((all) => [...all, { id: nextExtraId.current++, recipient: '', amount: '', recipientError: null, amountError: null }]);
    // Max means everything to one recipient; with two it would mean nothing.
    setMaxExact(null);
  };

  // Field checks run on blur and again on submit. A value in nau, or the
  // message explaining why there is none.
  const parsePositive = async (raw: string, what: string): Promise<{ nau: bigint } | { message: string }> => {
    // A pasted "1 234.5" is fine; spaces (including the narrow ones the app shows) are grouping.
    const text = raw.replace(/[\s\u202F\u00A0]/g, '');
    if (text.trim() === '') return { message: `Enter the ${what}` };
    if (text.trim().startsWith('-')) return { message: `The ${what} must be greater than zero` };
    // No more decimals than the review can show: it must show what is sent.
    const tooPrecise = decimalsProblem(text);
    if (tooPrecise) return { message: tooPrecise };
    let nau: bigint;
    try {
      nau = BigInt(await services.core.parseAmount(text));
    } catch {
      return { message: `The ${what} must be a number, such as 1.5` };
    }
    if (nau <= 0n) return { message: `The ${what} must be greater than zero` };
    return { nau };
  };

  // Why an address cannot be paid, or null. `earlier` holds the addresses
  // above it in the form, lower case: the core pays each address once.
  const addressProblem = async (raw: string, earlier: string[]): Promise<string | null> => {
    const text = raw.trim();
    if (text === '') return 'Enter the recipient address';
    if (!(await services.core.isValidAddress(text, services.networkName()))) return `Not a valid ${networkLabel(services.settings.network)} address`;
    if (earlier.includes(text.toLowerCase())) return 'This address is already paid above. Pay it once, with the amounts together.';
    return null;
  };

  const checkRecipient = async (): Promise<boolean> => {
    const message = await addressProblem(recipient, []);
    setRecipientError(message);
    return message === null;
  };

  const checkExtraRecipient = async (id: number): Promise<boolean> => {
    const at = extras.findIndex((x) => x.id === id);
    if (at < 0) return true;
    const earlier = [recipient, ...extras.slice(0, at).map((x) => x.recipient)].map((a) => a.trim().toLowerCase());
    const message = await addressProblem(extras[at].recipient, earlier);
    updateExtra(id, { recipientError: message });
    return message === null;
  };

  // Every amount and the fee, against the spendable balance. On leaving a
  // field (`leaving`) an added recipient's amount that is still empty is not
  // an error yet: the person may be on the way to it.
  const checkAmounts = async (leaving = false): Promise<boolean> => {
    const typed = await parsePositive(amount, 'amount');
    // Max means everything: the exact figure, not the eight decimals on screen.
    const a = maxExact && extras.length === 0 && maxExact.text === amount && 'nau' in typed ? { nau: maxExact.nau } : typed;
    const more = await Promise.all(extras.map((x) => parsePositive(x.amount, 'amount')));
    const f = await parsePositive(fee, 'fee');
    let amountMessage = 'message' in a ? a.message : null;
    const moreMessages = more.map((m, i) => ('message' in m && !(leaving && extras[i].amount.trim() === '') ? m.message : null));
    const feeMessage = 'message' in f ? f.message : null;
    const parsed = [a, ...more];
    if (parsed.every((p) => 'nau' in p) && 'nau' in f) {
      const payments = parsed.map((p) => (p as { nau: bigint }).nau);
      const total = payments.reduce((sum, n) => sum + n, 0n);
      if (total + f.nau > balance.spendableNau) {
        const spendable = showNau(balance.spendableNau);
        if (extras.length === 0) amountMessage = `Amount plus fee exceeds the spendable balance of ${spendable} NPT`;
        else moreMessages[moreMessages.length - 1] = `The amounts plus the fee exceed the spendable balance of ${spendable} NPT`;
      } else {
        // Unusual: more than 1 NPT, or more than the payments themselves and above every preset.
        const one = BigInt(await services.core.parseAmount('1'));
        const topPreset = BigInt(await services.core.parseAmount(FEE_PRESETS.reduce((m, p) => (Number(p.fee) > Number(m) ? p.fee : m), '0')));
        const feeHigh = f.nau > one || (f.nau > total && f.nau > topPreset);
        setTotals({ amountNau: total, feeNau: f.nau, feeHigh, payments });
        setFeeAgreed(false);
      }
    }
    setAmountError(amountMessage);
    setExtras((all) => all.map((x, i) => ({ ...x, amountError: moreMessages[i] ?? null })));
    setFeeError(feeMessage);
    return amountMessage === null && feeMessage === null && moreMessages.every((m) => m === null);
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
    const checks = await Promise.all([checkRecipient(), ...extras.map((x) => checkExtraRecipient(x.id)), checkAmounts()]);
    if (!checks.every(Boolean)) return;
    const addresses = [recipient, ...extras.map((x) => x.recipient)].map((a) => a.trim());
    const names = await Promise.all(addresses.map(async (a) => (account ? ((await services.contacts.findByAddress(account.id, a))?.name ?? null) : null)));
    setReviewNames(names);
    setStep('review');
  };

  // A second tap while the first is being taken up does nothing at all.
  const [starting, setStarting] = useState(false);
  const send = async (acceptLustration: boolean) => {
    if (!account || starting || !totals) return;
    setStarting(true);
    setAskLustration(false);
    try {
      // Saving as a contact is offered after a send to one recipient.
      const sentTo = extras.length === 0 ? recipient.trim().toLowerCase() : null;
      const addresses = [recipient, ...extras.map((x) => x.recipient)];
      const amounts = [amount, ...extras.map((x) => x.amount)];
      // The exact figures the review sheet showed go with the request, so the
      // core sends those and never parses the texts a second time, its own way.
      await startSend(
        {
          payments: addresses.map((r, i) => ({ recipient: r.trim(), amount: amounts[i].trim(), amount_nau: totals.payments[i].toString() })),
          fee: fee.trim(),
          accept_lustration: acceptLustration,
          fee_nau: totals.feeNau.toString(),
        },
        linkMeta?.message ?? null,
      );
      setLastRecipient(sentTo);
      setRecipient('');
      setAmount('');
      setExtras([]);
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

  // A link for an added recipient gives its address and amount. The name
  // and note a link can carry are shown for the first recipient only.
  const applyExtraText = (id: number, text: string) => {
    const parsed = parsePaymentText(text);
    if (parsed.error) {
      updateExtra(id, { recipientError: parsed.error });
      return;
    }
    updateExtra(id, { recipient: parsed.address, recipientError: null, ...(parsed.amount ? { amount: parsed.amount, amountError: null } : {}) });
  };

  const onScanned = (text: string) => {
    const target = scanFor;
    setScanFor(null);
    if (target === null || target === 0) applyText(text);
    else applyExtraText(target, text);
  };

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
    const reviewName = reviewNames[0] ?? null;
    const payees = [recipient, ...extras.map((x) => x.recipient)].map((address, i) => ({ address: address.trim(), name: reviewNames[i] ?? null, nau: totals.payments[i] ?? 0n }));
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
            {payees.length === 1 ? (
              <>
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
              </>
            ) : (
              <>
                {/* Several recipients: each with what it gets, in the order sent. */}
                <span className="vault-eyebrow">To {payees.length} recipients</span>
                {payees.map((p, i) => (
                  <div className="vault-review-row vault-review-payee" key={i}>
                    <div style={{ minWidth: 0 }}>
                      {p.name && (
                        <Text size="sm" fw={600}>
                          {p.name}
                        </Text>
                      )}
                      <Text ff="monospace" size="sm" c={p.name ? 'dimmed' : undefined}>
                        {abbreviateAddress(p.address)}
                      </Text>
                      <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                        {addressKindLabel(p.address)}
                      </Badge>
                    </div>
                    <b>{showNau(p.nau)} NPT</b>
                  </div>
                ))}
              </>
            )}
            <div className="vault-review-row">
              <span>Fee</span>
              <b>{showNau(totals.feeNau)} NPT</b>
            </div>
            <div className="vault-review-row total">
              <span>Total</span>
              <b>{showNau(totalNau)} NPT</b>
            </div>
            {quote && (
              <Text size="xs" c="dimmed" ta="right" mt={-6} style={{ fontVariantNumeric: 'tabular-nums' }}>
                ≈ {formatFiat(fiatOf(totalNau, NAU_PER_COIN, quote.price), quote.currency)} · {quote.source}
              </Text>
            )}
            {totals.feeNau > totals.amountNau && (
              <Text size="sm" c="var(--v-warn-text)" mt="xs">
                {payees.length === 1 ? 'The fee is larger than the amount.' : 'The fee is larger than the amounts together.'}
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
        <div>
          <Title order={2} className="sr-only">
            Send
          </Title>
          <Text size="sm" c="dimmed">
            Spendable {services.settings.hideBalance ? '••••' : showNau(balance.spendableNau)} NPT
          </Text>
        </div>
        {sendJob?.done && sendJob.outcome && (
          <Alert color="green" title="Submitted" withCloseButton onClose={dismissSendJob}>
            {showNau(paymentsTotalNau(sendJob.request))} NPT is on its way. It shows as pending until it is confirmed
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
            {/* A saved contact fills the recipient, as Scan does: so it sits on
                the field's own label line, ahead of the field in the page's
                order as on screen, and not inside the label, which would make
                it part of the field's name. */}
            {extras.length > 0 && <span className="vault-eyebrow">Recipient 1</span>}
            <div className="vault-field-action-wrap">
              <UnstyledButton type="button" onClick={() => setPickFor(0)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-field-action">
                <IconAddressBook size={16} stroke={1.8} aria-hidden />
                Choose contact
              </UnstyledButton>
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
                description={contactNote(recipient)}
                inputWrapperOrder={['label', 'input', 'description', 'error']}
                rightSectionWidth={80}
                rightSection={
                  <Button variant="subtle" size="compact-sm" className="vault-tap" leftSection={<IconScan size={16} stroke={1.8} />} onClick={() => setScanFor(0)}>
                    Scan
                  </Button>
                }
              />
            </div>
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
              onBlur={() => void checkAmounts(true)}
              error={amountError}
              description={estimateOf(amount)}
              inputWrapperOrder={UNDER_THE_FIELD}
              rightSectionWidth={extras.length === 0 ? 64 : undefined}
              rightSection={
                extras.length === 0 ? (
                  <Button variant="subtle" size="compact-sm" className="vault-tap" onClick={() => void sendAll()} disabled={balance.spendableNau <= 0n}>
                    Max
                  </Button>
                ) : undefined
              }
            />
            {extras.map((x, i) => (
              <div key={x.id} className="vault-payee" role="group" aria-labelledby={`payee-${x.id}`}>
                <div className="vault-payee-head">
                  <span className="vault-eyebrow" id={`payee-${x.id}`}>
                    Recipient {i + 2}
                  </span>
                  <UnstyledButton type="button" onClick={() => setExtras((all) => all.filter((y) => y.id !== x.id))} c="var(--v-accent-text)" fz="sm" className="vault-tap-link" aria-label={`Remove recipient ${i + 2}`}>
                    Remove
                  </UnstyledButton>
                </div>
                <div className="vault-field-action-wrap">
                  <UnstyledButton type="button" onClick={() => setPickFor(x.id)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-field-action">
                    <IconAddressBook size={16} stroke={1.8} aria-hidden />
                    Choose contact
                  </UnstyledButton>
                  <TextInput
                    label="Recipient address"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Address or payment link"
                    value={x.recipient}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyExtraText(x.id, value);
                      else updateExtra(x.id, { recipient: value, recipientError: null });
                    }}
                    onBlur={() => void checkExtraRecipient(x.id)}
                    error={x.recipientError}
                    description={contactNote(x.recipient)}
                    inputWrapperOrder={['label', 'input', 'description', 'error']}
                    rightSectionWidth={80}
                    rightSection={
                      <Button variant="subtle" size="compact-sm" className="vault-tap" leftSection={<IconScan size={16} stroke={1.8} />} onClick={() => setScanFor(x.id)}>
                        Scan
                      </Button>
                    }
                  />
                </div>
                <TextInput
                  label="Amount (NPT)"
                  inputMode="decimal"
                  value={x.amount}
                  onChange={(e) => updateExtra(x.id, { amount: e.currentTarget.value, amountError: null })}
                  onBlur={() => void checkAmounts(true)}
                  error={x.amountError}
                  description={estimateOf(x.amount)}
                  inputWrapperOrder={UNDER_THE_FIELD}
                />
              </div>
            ))}
            {1 + extras.length < MAX_PAYMENTS && (
              <UnstyledButton type="button" onClick={addRecipient} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-add-payee">
                <IconPlus size={16} stroke={1.8} aria-hidden />
                Add another recipient
              </UnstyledButton>
            )}
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
                onBlur={() => void checkAmounts(true)}
                error={feeError}
                ref={customFeeRef}
              />
            )}
            {!online && (
              <Caution>You are offline. Sending needs the node; Review comes back when the connection does.</Caution>
            )}
            <Button
              type="submit"
              disabled={!online || !recipient || !amount || !fee || Boolean(recipientError || amountError || feeError) || extras.some((x) => !x.recipient || !x.amount || x.recipientError || x.amountError)}
            >
              Review
            </Button>
          </Stack>
        </form>
      </Stack>
      <QrScanner opened={scanFor !== null} onClose={() => setScanFor(null)} onResult={onScanned} />
      <ContactPicker
        opened={pickFor !== null}
        onClose={() => setPickFor(null)}
        onPick={(c) => {
          const target = pickFor;
          setPickFor(null);
          if (target !== null && target !== 0) {
            updateExtra(target, { recipient: c.address, recipientError: null });
            return;
          }
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
            loadContacts();
            setSaving(false);
          }}
        />
      )}
    </Paper>
  );
}
