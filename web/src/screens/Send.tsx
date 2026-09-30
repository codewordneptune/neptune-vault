// Send screen: a recipient and an amount (or several, paid by one
// transaction), a fee; validation before a review step; the proof itself
// runs as a job in the app context so it survives this screen being
// unmounted (backgrounding locks the app).

import { Badge, Button, Checkbox, Divider, Group, Loader, Modal, Paper, PasswordInput, Progress, SegmentedControl, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { useMediaQuery, useReducedMotion } from '@mantine/hooks';
import { IconAddressBook, IconFingerprint, IconLink, IconPlus, IconScan } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { formatNau, NAU_PER_COIN, showNau, UNANSWERED_TITLE, useApp } from '../app/AppContext';
import { clearSendDraft, keepSendDraft, sendDraft, type ExtraPayee, type SendDraft } from '../app/sendDraft';
import { DESKTOP } from '../app/platform';
import { formatAbout, formatDuration } from '../util/time';
import { useQuote } from '../app/price';
import { decimalsProblem } from '../util/amount';
import { fiatOf, fiatOfTyped, formatFiat } from '../util/fiat';
import { cleanNote, MAX_PAYMENTS, paymentsTotalNau, SEND_NOTE_MAX, RequiresLustrationError, SendBusyError, SendUnconfirmedError } from '../app/send';
import { isCancellation } from '../app/passkey';
import { WrongPasswordError } from '../storage/envelope';
import { ContactPicker } from '../components/ContactPicker';
import { Amount } from '../components/Amount';
import { Caution, Done, ErrorLine, Info } from '../components/Notice';
import { MAY_HAVE_GONE_OUT, notSentReason, SENDING_UNTIL_CONFIRMED } from '../app/words';
import { usePendingSends } from '../app/pending';
import { QrScanner } from '../components/QrScanner';
import { ContactForm } from './Contacts';
import { abbreviateAddress, addressKindNote, parsePaymentText, shortAddress } from '../util/address';
import { networkLabel } from '../util/network';
import { confirmsSends, type ContactRecord } from '../storage/db';

// Fee presets. Every level clears the default proof-upgrader floor of
// about 0.017 NPT; the spread is for when upgraders or composers have
// transactions to choose between.
const FEE_PRESETS: { value: string; label: string; fee: string }[] = [
  { value: 'low', label: 'Low', fee: '0.1' },
  { value: 'medium', label: 'Medium', fee: '0.3' },
  { value: 'high', label: 'High', fee: '0.5' },
  { value: 'custom', label: 'Custom', fee: '' },
];
/**
 * Below this, nodes usually do not finish proving a send (the proof
 * upgraders' default floor is about 0.017 NPT), so it may never confirm.
 */
const LOW_FEE = '0.02';
const DEFAULT_PRESET = 'medium';
const DEFAULT_FEE = FEE_PRESETS.find((p) => p.value === DEFAULT_PRESET)!.fee;
const presetFee = (preset: string, custom: string | undefined) =>
  preset === 'custom' ? (custom ?? '') : (FEE_PRESETS.find((p) => p.value === preset)?.fee ?? DEFAULT_FEE);

type Step = 'form' | 'review';

// Where an amount's estimate in another currency sits: under the field, and
// above any error, like the other notes about a field.
const UNDER_THE_FIELD: ('label' | 'input' | 'description' | 'error')[] = ['label', 'input', 'description', 'error'];


export function Send() {
  const { services, account, balance, utxos, online, sync, syncNow, sendJob, screenAwake, startSend, cancelSend, dismissSendJob, dismissLastSend, dismissSendFailure } = useApp();
  // What is on hold, as Home counts it: the change pending sends bring back.
  const { ready: pendingReady, onHoldNau, isOwn } = usePendingSends();
  // Amounts hidden on Home stay hidden here, the review and its errors included.
  const hidden = services.settings.hideBalance ?? false;
  const reducedMotion = useReducedMotion();
  // Narrow by the text's own measure (enlarged text counts): four fee choices stack.
  const stacked = useMediaQuery('(max-width: 22em)');
  // The node did not answer as a node at the last sync: sending would fail the same way.
  const nodeDown = sync?.phase === 'error' && sync.nodeDown === true;
  // A mouse or trackpad: a computer, where advice about touching the screen reads as a bug.
  const finePointer = useMediaQuery('(pointer: fine)');
  // Sends go out only once the person confirms with a password or passkey,
  // unless they turned that off for this wallet in Settings. It is asked on
  // the review, before anything starts: the proof is made only after it.
  const confirmEach = confirmsSends(account);
  const location = useLocation();
  const navigate = useNavigate();
  const arrival = location.state as { recipient?: string; fresh?: boolean } | null;
  const prefill = arrival?.recipient;
  // "Send to" a contact, or a new send by shortcut, starts with an empty
  // form: a draft's amount or extra recipients were meant for someone else.
  const draft = account && !prefill && !arrival?.fresh ? sendDraft(account.id) : undefined;
  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState(prefill ?? draft?.recipient ?? '');
  // The last successfully sent recipient, offered for saving as a contact.
  // A send that finished while the app was locked is still offered.
  const [lastRecipient, setLastRecipient] = useState<string | null>(() =>
    sendJob?.done && sendJob.ending === 'sent' && sendJob.request.payments.length === 1 ? sendJob.request.payments[0].recipient.trim().toLowerCase() : null,
  );
  const [savedName, setSavedName] = useState<string | null>(null);
  // From a payment link: its name is shown as unverified and offered as the
  // contact's name after the send; its message fills the note in.
  const [linkMeta, setLinkMeta] = useState<{ label?: string; message?: string } | null>(prefill ? null : (draft?.linkMeta ?? null));
  // A note to self, kept with the send in History on this device only. A
  // request's message replaces it, as the request's amount replaces the
  // amount, and goes with the request when the recipient changes.
  const [note, setNote] = useState(prefill ? '' : (draft?.note ?? ''));
  const filledNote = useRef<string | null>(prefill ? null : (draft?.linkMeta?.message ?? null));
  // Most sends have no note, so its field waits behind "+ Add a note". It
  // shows once asked for, and by itself while it holds text: a request's
  // message, or a draft's note.
  const [noteOpen, setNoteOpen] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const showNote = noteOpen || note !== '';
  // The name a request gave, offered for the contact after the send.
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  // The review is a dialog like every other: centred on a wide screen, the
  // whole screen on a phone.
  const phone = useMediaQuery('(max-width: 36em)');
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
        <IconAddressBook size={16} stroke={1.8} aria-hidden />
        <span>
          Saved contact: <b dir="auto" className="vault-bidi">{name}</b>
        </span>
      </span>
    ) : undefined;
  };
  // Who a send went to, as every notice about it names them, Home's too:
  // the contact, or the address shortened, and how many more.
  const whoOf = (request: { payments: { recipient: string }[] }): string => {
    const first = request.payments[0]?.recipient.trim() ?? '';
    const others = request.payments.length - 1;
    if (!others && first && isOwn(first)) return 'yourself';
    const name = contacts.find((c) => c.address === first.toLowerCase())?.name ?? shortAddress(first);
    return others ? `${name} and ${others} more` : name;
  };
  // One name per recipient, under its address: a saved contact's own, or
  // else the name a payment request gave, in the same form and said to be
  // unverified (anyone can write any name into a request).
  const nameNote = (address: string, requestName: string | undefined) =>
    contactNote(address) ??
    (requestName ? (
      <span className="vault-contact-match">
        <IconLink size={16} stroke={1.8} aria-hidden />
        <span>
          Named in the request: <b dir="auto" className="vault-bidi">{requestName}</b> (not verified)
        </span>
      </span>
    ) : undefined);

  useEffect(() => {
    if (!account || !lastRecipient) return;
    void services.contacts.findByAddress(account.id, lastRecipient).then((c) => setSavedName(c?.name ?? null));
  }, [services, account, lastRecipient]);
  const [amount, setAmount] = useState(draft?.amount ?? '');
  // The fee level is remembered between sends (settings); a custom fee is
  // not. It was typed for one payment, and coming back to find an unusual
  // fee already chosen is how someone pays it twice without meaning to. A
  // draft of this session keeps its own, custom or not.
  const rememberedPreset = services.settings.feePreset && services.settings.feePreset !== 'custom' ? services.settings.feePreset : DEFAULT_PRESET;
  const [feePreset, setFeePreset] = useState(draft?.feePreset ?? rememberedPreset);
  const [fee, setFee] = useState(draft?.fee ?? presetFee(rememberedPreset, undefined));
  // An unusually high fee, or one so low the send may never confirm, must be
  // agreed to on the review sheet, in so many words.
  const [feeAgreed, setFeeAgreed] = useState(false);
  // "Max" in exact nau: the shown text has eight decimals and the balance has more.
  const [maxExact, setMaxExact] = useState<{ text: string; nau: bigint } | null>(null);
  // The contact name of each recipient on the review sheet, when it is one.
  const [reviewNames, setReviewNames] = useState<(string | null)[]>([]);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  // Focused when Custom is chosen with a pointer, not whenever the field
  // happens to mount, and not when arrowing through the choices, which would
  // throw a keyboard user out of them (the field is next in Tab order).
  const customFeeRef = useRef<HTMLInputElement>(null);
  const feeByPointer = useRef(false);
  // The amount fields, by recipient (0 is the first), for where focus goes after a Remove.
  const amountRefs = useRef(new Map<number, HTMLInputElement>());
  // As reviewed: each payment in nau (the first recipient's first), their sum, and the fee.
  const [totals, setTotals] = useState<{ amountNau: bigint; feeNau: bigint; feeHigh: boolean; feeLow: boolean; payments: bigint[] } | null>(null);
  const [askLustration, setAskLustration] = useState(false);
  // Which recipient Scan and Choose contact fill: 0 for the first, else an added one's id.
  const [scanFor, setScanFor] = useState<number | null>(null);
  const [pickFor, setPickFor] = useState<number | null>(null);
  // Recipients after the first. Several payments in one transaction take
  // one proof and one fee, and none has to wait for the change of another.
  const [extras, setExtras] = useState<ExtraPayee[]>(draft?.extras ?? []);
  const nextExtraId = useRef(1 + Math.max(0, ...(draft?.extras ?? []).map((x) => x.id)));
  const updateExtra = (id: number, patch: Partial<ExtraPayee>) => setExtras((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  // A recipient just added gets the focus, so its fields are where the
  // person is, and not somewhere below them unseen.
  const focusExtra = useRef<number | null>(null);
  const addRecipient = () => {
    const id = nextExtraId.current++;
    focusExtra.current = id;
    setExtras((all) => [...all, { id, recipient: '', amount: '', recipientError: null, amountError: null }]);
    // Max means everything to one recipient; with two it would mean nothing.
    setMaxExact(null);
  };

  // The form as it stands, kept as this wallet's draft when the screen goes.
  const formNow = useRef<SendDraft>({ recipient, amount, extras, feePreset, fee, linkMeta, note });
  formNow.current = { recipient, amount, extras, feePreset, fee, linkMeta, note };
  const draftFor = useRef(account?.id ?? null);
  draftFor.current = account?.id ?? null;
  useEffect(
    () => () => {
      const id = draftFor.current;
      if (!id) return;
      // A form whose send is running is that send, not a draft: kept, it
      // would come back pre-filled after the payment went out.
      const job = sendJobRef.current;
      if (job && !job.done) return clearSendDraft(id);
      const f = formNow.current;
      const empty = f.recipient.trim() === '' && f.amount.trim() === '' && f.extras.length === 0;
      if (empty) clearSendDraft(id);
      else keepSendDraft(id, { ...f, extras: f.extras.map((x) => ({ ...x, recipientError: null, amountError: null })) });
    },
    [],
  );

  // Field checks run on blur and again on submit. On blur they judge only
  // what was typed: an empty field is not an error until Review, which then
  // takes the person to it, so nothing turns red on the way to a field. A
  // value in nau, or the message explaining why there is none.
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

  const checkRecipient = async (leaving = false): Promise<boolean> => {
    const message = leaving && recipient.trim() === '' ? null : await addressProblem(recipient, []);
    setRecipientError(message);
    return message === null;
  };

  const checkExtraRecipient = async (id: number, leaving = false): Promise<boolean> => {
    const at = extras.findIndex((x) => x.id === id);
    if (at < 0) return true;
    const earlier = [recipient, ...extras.slice(0, at).map((x) => x.recipient)].map((a) => a.trim().toLowerCase());
    const empty = extras[at].recipient.trim() === '';
    const message = empty ? (leaving ? null : 'Enter the address, or remove this recipient') : await addressProblem(extras[at].recipient, earlier);
    updateExtra(id, { recipientError: message });
    return message === null;
  };

  // Every amount and the fee, against the spendable balance. On leaving a
  // field (`leaving`) an amount or a fee that is still empty is not an error
  // yet: the person may be on the way to it.
  const checkAmounts = async (leaving = false): Promise<boolean> => {
    const typed = await parsePositive(amount, 'amount');
    // Max means everything: the exact figure, not the eight decimals on screen.
    const a = maxExact && extras.length === 0 && maxExact.text === amount && 'nau' in typed ? { nau: maxExact.nau } : typed;
    const more = await Promise.all(extras.map((x) => parsePositive(x.amount, 'amount')));
    const f = await parsePositive(fee, 'fee');
    let amountMessage = 'message' in a ? (leaving && amount.trim() === '' ? null : a.message) : null;
    const moreMessages = more.map((m, i) => {
      if (!('message' in m)) return null;
      if (extras[i].amount.trim() === '') return leaving ? null : 'Enter the amount, or remove this recipient';
      return m.message;
    });
    const feeMessage = 'message' in f ? (leaving && fee.trim() === '' ? null : f.message) : null;
    const parsed = [a, ...more];
    if (parsed.every((p) => 'nau' in p) && 'nau' in f) {
      const payments = parsed.map((p) => (p as { nau: bigint }).nau);
      const total = payments.reduce((sum, n) => sum + n, 0n);
      if (total + f.nau > balance.spendableNau) {
        // The figure itself only while amounts are shown.
        const spendable = hidden ? 'the spendable balance' : `the spendable balance of ${showNau(balance.spendableNau)} NPT`;
        if (extras.length === 0) amountMessage = `Amount plus fee exceeds ${spendable}`;
        else moreMessages[moreMessages.length - 1] = `The amounts plus the fee exceed ${spendable}`;
      } else {
        // Unusual: more than 1 NPT, or more than the payments themselves and above every preset.
        const one = BigInt(await services.core.parseAmount('1'));
        const topPreset = BigInt(await services.core.parseAmount(FEE_PRESETS.reduce((m, p) => (Number(p.fee) > Number(m) ? p.fee : m), '0')));
        const feeHigh = f.nau > one || (f.nau > total && f.nau > topPreset);
        const feeLow = f.nau < BigInt(await services.core.parseAmount(LOW_FEE));
        setTotals({ amountNau: total, feeNau: f.nau, feeHigh, feeLow, payments });
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
      setAmountError(hidden ? 'The fee alone exceeds the spendable balance' : `The fee alone exceeds the spendable balance of ${showNau(balance.spendableNau)} NPT`);
      return;
    }
    const text = formatNau(max);
    setAmount(text);
    setMaxExact({ text, nau: max });
    setAmountError(null);
  };

  const formRef = useRef<HTMLFormElement>(null);
  const review = async () => {
    const checks = await Promise.all([checkRecipient(), ...extras.map((x) => checkExtraRecipient(x.id)), checkAmounts()]);
    if (!checks.every(Boolean)) {
      // Review stays pressable, so what stands in its way is shown, and the
      // first such field, which may be below the fold, gets the focus.
      setTimeout(() => {
        const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
        first?.focus();
        first?.scrollIntoView({ block: 'center' });
      }, 0);
      return;
    }
    const addresses = [recipient, ...extras.map((x) => x.recipient)].map((a) => a.trim());
    const names = await Promise.all(addresses.map(async (a) => (account ? ((await services.contacts.findByAddress(account.id, a))?.name ?? null) : null)));
    setReviewNames(names);
    setStep('review');
  };

  // A second tap while the first is being taken up does nothing at all.
  const [starting, setStarting] = useState(false);
  // The password or passkey, asked on the review before the send starts.
  // Once given it holds until the review closes, so a send that turns out
  // to need its coins published ("Send anyway") is not asked again.
  const [approvedHere, setApprovedHere] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyOffered, setPasskeyOffered] = useState<boolean | null>(null);
  useEffect(() => {
    void services.accounts.passkeySupported().then(setPasskeyOffered, () => setPasskeyOffered(false));
  }, [services]);
  const hasPasskey = Boolean(account?.passkey) && passkeyOffered === true;
  useEffect(() => {
    if (step === 'review') return;
    setApprovedHere(false);
    setPassword('');
    setPasswordError(null);
    setPasskeyError(null);
  }, [step]);
  const needsApproval = confirmEach && !approvedHere;
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
        cleanNote(note) || null,
      );
      setLastRecipient(sentTo);
      setLastLabel(sentTo && linkMeta?.label ? linkMeta.label : null);
      setRecipient('');
      setAmount('');
      setExtras([]);
      setLinkMeta(null);
      setNote('');
      setNoteOpen(false);
      filledNote.current = null;
      setTotals(null);
      setStep('form');
    } catch (e) {
      if (e instanceof SendBusyError) return;
      if (e instanceof RequiresLustrationError) {
        dismissSendJob();
        setAskLustration(true);
      } else if (e instanceof SendUnconfirmedError) {
        // It may have gone through: the filled form would make paying twice
        // two taps away. It is in History, and the notice says so.
        setRecipient('');
        setAmount('');
        setExtras([]);
        setLinkMeta(null);
        setNote('');
        setNoteOpen(false);
        filledNote.current = null;
        setTotals(null);
        setStep('form');
      } else {
        // The failure notice lives on the form.
        setStep('form');
      }
    } finally {
      setStarting(false);
    }
  };

  // The password, checked before anything starts; a wrong one is said at the field.
  const confirmWithPassword = async () => {
    if (!account || !password) return;
    setChecking(true);
    setPasswordError(null);
    let ok = false;
    try {
      await services.accounts.verifyPassword(account.id, password);
      ok = true;
    } catch (e) {
      setPasswordError(e instanceof WrongPasswordError ? 'Wrong password. Try again.' : (e as Error).message);
    } finally {
      setChecking(false);
    }
    if (!ok) return;
    setPassword('');
    setApprovedHere(true);
    await send(askLustration);
  };
  // The passkey, likewise. Closing its sheet is a choice, not an error: the password is there instead.
  const confirmWithPasskey = async () => {
    if (!account) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    let ok = false;
    try {
      await services.accounts.verifyPasskey(account.id);
      ok = true;
    } catch (e) {
      if (!isCancellation(e)) setPasskeyError((e as Error).message);
    } finally {
      setPasskeyBusy(false);
    }
    if (!ok) return;
    setApprovedHere(true);
    await send(askLustration);
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
      // A request fills the form from itself: its message replaces the note.
      // Without one, a note the person wrote stays; one an earlier request filled in goes.
      // What an earlier request filled in is read now: the update runs later, after the ref has moved on.
      const message = parsed.message ? cleanNote(parsed.message) : '';
      const earlier = filledNote.current;
      setNote((current) => (message ? message : current === earlier ? '' : current));
      filledNote.current = message || null;
    },
    [],
  );
  // The request no longer applies (another recipient): its name goes, and
  // its message too while the note is still the one it filled in.
  const dropRequest = () => {
    setLinkMeta(null);
    const earlier = filledNote.current;
    setNote((current) => (current === earlier ? '' : current));
    filledNote.current = null;
  };

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

  const [formSaid, setFormSaid] = useState('');
  const onScanned = (text: string) => {
    const target = scanFor;
    setScanFor(null);
    if (target === null || target === 0) applyText(text);
    else applyExtraText(target, text);
    setFormSaid(target === null || target === 0 ? 'Address filled from the QR code.' : `Address of recipient ${extras.findIndex((x) => x.id === target) + 2} filled from the QR code.`);
  };

  // Clear starts the form over: every recipient and amount, the added ones,
  // a request's name, the note, and a custom fee, back to the usual level
  // (Low, Medium and High are a setting, kept between sends). One tap and no
  // dialog: it shows only while the form holds something, away from Review,
  // and touches nothing sent or saved. Focus goes to the recipient, where
  // the form starts again, and does not fall away with the button.
  const recipientRef = useRef<HTMLInputElement>(null);
  const hasContent = recipient.trim() !== '' || amount.trim() !== '' || extras.length > 0 || note.trim() !== '' || feePreset === 'custom';
  const clearForm = () => {
    setRecipient('');
    setRecipientError(null);
    setAmount('');
    setAmountError(null);
    setExtras([]);
    setLinkMeta(null);
    setNote('');
    setNoteOpen(false);
    filledNote.current = null;
    if (feePreset === 'custom') {
      setFeePreset(rememberedPreset);
      setFee(presetFee(rememberedPreset, undefined));
    }
    setFeeError(null);
    setMaxExact(null);
    setFeeAgreed(false);
    setAskLustration(false);
    setTotals(null);
    setFormSaid('Form cleared.');
    recipientRef.current?.focus();
  };

  // A finished job's notice belongs to this visit; leaving the screen
  // clears it. Locking unmounts the screen too, and there the notice is kept:
  // a send that ended while the app locked must still say how it ended.
  useEffect(() => {
    return () => {
      const job = sendJobRef.current;
      if (!job?.done || services.accounts.currentAccountId === null) return;
      // Seen here, so Home need not say it again. A send the node never
      // answered about keeps its note there until its row settles.
      if (job.ending === 'sent') dismissLastSend();
      dismissSendJob();
    };
  }, [dismissSendJob, dismissLastSend, services]);
  const sendJobRef = useRef(sendJob);
  sendJobRef.current = sendJob;

  // Max follows the fee: chosen, it means everything, whatever the fee.
  const feeSeen = useRef(fee);
  useEffect(() => {
    if (feeSeen.current === fee) return;
    feeSeen.current = fee;
    // A custom fee is being typed: half a number would read as an error.
    // It is followed when the field is left.
    if (feePreset === 'custom') return;
    if (maxExact && extras.length === 0 && amount === maxExact.text) void sendAll();
    // Only a change of fee re-runs it; the rest is read as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fee]);

  // Stopping throws the proof away, so it is asked first.
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!sendJob || sendJob.done) setStopping(false);
  }, [sendJob]);

  // Focus follows the screen: to the proving view's title when it starts,
  // and to the result when it ends.
  const runningTitle = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const isRunning = Boolean(sendJob && !sendJob.done);
  const isDone = Boolean(sendJob?.done && sendJob.ending);
  useEffect(() => {
    if (isRunning) runningTitle.current?.focus();
  }, [isRunning]);
  useEffect(() => {
    if (!isDone) return;
    // After the review dialog has closed and handed focus back, or it
    // would take the focus straight back from the result.
    const t = setTimeout(() => resultRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, [isDone]);
  // One dismiss clears the result here and its note on Home.
  const dismissResult = () => {
    if (sendJob?.ending === 'sent' || sendJob?.ending === 'unconfirmed') dismissLastSend();
    if (sendJob?.ending === 'failed') dismissSendFailure();
    dismissSendJob();
  };
  const maxFollowsFee = () => Boolean(maxExact && extras.length === 0 && amount === maxExact.text);

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
    // What is being sent, for a second look while it proves: the amount,
    // who gets it, and the fee.
    const request = sendJob.request;
    const masked = hidden;
    const who = whoOf(request);
    return (
      <Paper>
        <Stack>
          <Title order={2} tabIndex={-1} ref={runningTitle}>
            Sending
          </Title>
          <Text size="sm" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <Amount nau={paymentsTotalNau(request)} hidden={masked} /> to <span dir="auto" className="vault-bidi">{who}</span> · fee <Amount nau={BigInt(request.fee_nau ?? '0')} hidden={masked} />
          </Text>
          {/* One signal of progress at a time, in plain words: a line while the
              send is being got ready and handed over, the bar while it is
              proven (measured by the work done, so it never disagrees with a
              step count). */}
          <div aria-live="polite">
            {/* The steps that wait on the node have no measure of their own: a
                turning mark says the app is at work, not stuck. */}
            {!(proving && p) && (
              <Group gap="xs" wrap="nowrap" align="center">
                <Loader size={14} color="var(--v-muted)" aria-hidden />
                <Text>{sendJob.progress.stage === 'submitting' ? 'Almost done…' : 'Getting ready…'}</Text>
              </Group>
            )}
            {/* Why the steps started over, when they did: a block arrived. */}
            {sendJob.progress.note && (
              <Text size="sm" c="var(--v-warn-text)" mt={4}>
                {sendJob.progress.note}
              </Text>
            )}
          </div>
          {proving && p && <Progress value={Math.round(100 * (p.work ?? p.index / p.total))} animated={!reducedMotion} aria-label="Share of the proving work done" />}
          {proving && (
            <Text size="sm" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {estimate !== null ? `${capitalise(formatAbout(estimate))} on this device · ` : ''}
              {formatDuration(provingSeconds)} so far
            </Text>
          )}
          <Text size="sm">
            {screenAwake === 'refused'
              ? DESKTOP
                ? 'This computer would not promise to stay awake. Keep the app running and the computer awake until this finishes: sleep pauses the send.'
                : finePointer
                  ? 'This browser would not promise to keep the computer awake. Keep this tab open and the computer awake until this finishes: sleep pauses the send.'
                  : 'This device would not keep the screen on. Keep the app open and touch the screen now and then until this finishes: a locked phone pauses the send.'
              : DESKTOP
                ? 'Keep the app running until this finishes.'
                : 'Keep the app open and in front until this finishes. Other screens are fine.'}
          </Text>
          {proving && (
            <Button variant="light" color="red" onClick={() => setConfirmStop(true)} loading={stopping}>
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </Stack>
        <Modal opened={confirmStop} onClose={() => setConfirmStop(false)} title="Stop this send?">
          <Stack>
            <Text size="sm">What it has done so far ({formatDuration(provingSeconds)}) is lost. Nothing has been sent.</Text>
            <Group grow>
              <Button variant="default" onClick={() => setConfirmStop(false)}>
                Keep going
              </Button>
              <Button
                color="red"
                onClick={() => {
                  setConfirmStop(false);
                  setStopping(true);
                  cancelSend();
                }}
              >
                Stop
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Paper>
    );
  }

  // The review is a sheet over the form, so the form stays in view and
  // "Edit" is a step back rather than a screen change.
  let reviewSheet: ReactNode = null;
  if (step === 'review' && totals) {
    const totalNau = totals.amountNau + totals.feeNau;
    const kind = addressKindNote(recipient);
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
    // What stays spendable while it is pending, and after: said only when the two differ.
    const spendableWhile = balance.spendableNau - heldNau;
    const spendableAfter = balance.spendableNau - totalNau;
    reviewSheet = (
        <Stack>
          {/* One line before the payment: what cannot be undone, and how long it takes. */}
          <Text size="sm" c="dimmed">
            This send cannot be changed once it starts, and {estimate !== null ? `takes ${formatAbout(estimate)} on this device` : 'can take a few minutes'}.
          </Text>
          <div className="vault-review">
            {payees.length === 1 ? (
              <>
                <div>
                  <span className="vault-review-label">To</span>
                  {reviewName && (
                    <Text size="md" fw={600}>
                      <bdi>{reviewName}</bdi>
                    </Text>
                  )}
                  <Text ff="monospace" size="sm" c={reviewName ? 'dimmed' : undefined}>
                    {abbreviateAddress(recipient)}
                  </Text>
                  {/* One name per recipient: the saved contact's, or else the request's, said to be unverified. */}
                  {!reviewName && linkMeta?.label && (
                    <Text size="sm" c="dimmed" mt={2}>
                      Named in the request:{' '}
                      <Text span inherit c="var(--v-text)" fw={600} dir="auto" className="vault-bidi">
                        {linkMeta.label}
                      </Text>{' '}
                      (not verified)
                    </Text>
                  )}
                  {/* A kind other than Standard, in plain words. */}
                  {kind && (
                    <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                      {kind}
                    </Badge>
                  )}
                </div>
                <div className="vault-review-row">
                  <span>Amount</span>
                  <b>
                    <Amount nau={totals.amountNau} />
                  </b>
                </div>
              </>
            ) : (
              <>
                {/* Several recipients: each with what it gets, in the order sent. */}
                <span className="vault-review-label">To {payees.length} recipients</span>
                {payees.map((p, i) => (
                  <div className="vault-review-row vault-review-payee" key={i}>
                    <div style={{ minWidth: 0 }}>
                      {p.name && (
                        <Text size="md" fw={600}>
                          <bdi>{p.name}</bdi>
                        </Text>
                      )}
                      <Text ff="monospace" size="sm" c={p.name ? 'dimmed' : undefined}>
                        {abbreviateAddress(p.address)}
                      </Text>
                      {addressKindNote(p.address) && (
                        <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                          {addressKindNote(p.address)}
                        </Badge>
                      )}
                    </div>
                    <b>
                      <Amount nau={p.nau} />
                    </b>
                  </div>
                ))}
              </>
            )}
            <div className="vault-review-row">
              <span>Fee</span>
              <b>
                <Amount nau={totals.feeNau} />
              </b>
            </div>
            <div className="vault-review-row total">
              <span>Total</span>
              <b>
                <Amount nau={totalNau} />
              </b>
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
          {cleanNote(note) && (
            <Text size="sm">
              <Text span inherit c="dimmed">
                Note to self:{' '}
              </Text>
              <bdi>{cleanNote(note)}</bdi>
            </Text>
          )}
          {/* Only when the change of this send makes the two figures differ,
              and never while amounts are hidden. */}
          {!hidden && spendableWhile !== spendableAfter && (
            <Text size="sm" c="dimmed">
              You can spend {showNau(spendableWhile)} NPT until it confirms, then {showNau(spendableAfter)} NPT.
            </Text>
          )}
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
          {totals.feeLow && (
            <Checkbox
              checked={feeAgreed}
              onChange={(e) => setFeeAgreed(e.currentTarget.checked)}
              label={`The fee is ${showNau(totals.feeNau)} NPT. Nodes usually do not finish proving sends that pay less than about ${LOW_FEE} NPT, so this one may never confirm. Send it anyway.`}
            />
          )}
          {/* The password or passkey, before the send starts: the proof is made only after it. */}
          {needsApproval && (
            <Stack gap="sm">
              {hasPasskey && (
                <>
                  <Button leftSection={<IconFingerprint size={16} stroke={1.8} />} loading={passkeyBusy || (starting && !checking)} disabled={running || checking || ((totals.feeHigh || totals.feeLow) && !feeAgreed)} onClick={() => void confirmWithPasskey()}>
                    Send with passkey
                  </Button>
                  {passkeyError && <ErrorLine>{passkeyError}</ErrorLine>}
                  <Divider label="or use the password" labelPosition="center" />
                </>
              )}
              {/* Where typing is how the send goes on (a wide screen, no passkey), the field has the focus. */}
              <PasswordInput
                label="Password"
                data-autofocus={!phone && !hasPasskey ? true : undefined}
                value={password}
                onChange={(e) => {
                  setPassword(e.currentTarget.value);
                  setPasswordError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void confirmWithPassword();
                  }
                }}
                error={passwordError}
                errorProps={{ role: 'alert' }}
                autoComplete="current-password"
              />
            </Stack>
          )}
          <Group grow>
            <Button variant="default" onClick={() => setStep('form')}>
              Edit
            </Button>
            <Button
              variant={needsApproval && hasPasskey ? 'light' : 'filled'}
              onClick={() => void (needsApproval ? confirmWithPassword() : send(askLustration))}
              loading={checking || (starting && !passkeyBusy)}
              disabled={running || passkeyBusy || ((totals.feeHigh || totals.feeLow) && !feeAgreed) || (needsApproval && !password)}
            >
              {/* The password above says what confirms it; the button says what it does. */}
              {askLustration ? 'Send anyway' : 'Send'}
            </Button>
          </Group>
        </Stack>
    );
  }

  return (
    <Paper>
      <Stack>
        <Modal opened={reviewSheet !== null} onClose={() => setStep('form')} title="Review" size={560} centered fullScreen={phone}>
          {reviewSheet}
        </Modal>
        {/* What can be spent, and at the end of its line Clear: away from
            Review, and there only while the form holds something to clear. */}
        <div className="vault-send-head">
          <Title order={2} className="sr-only">
            Send
          </Title>
          <Text size="sm" c="dimmed">
            Spendable {hidden ? '••••' : showNau(balance.spendableNau)} NPT
            {/* The same line as Home's: the change pending sends bring back, so
                the two figures add up to the balance Home shows. */}
            {pendingReady && onHoldNau > 0n && ` · ${hidden ? '••••' : showNau(onHoldNau)} NPT on hold`}
          </Text>
          {hasContent && (
            <UnstyledButton type="button" onClick={clearForm} aria-label="Clear the form" c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
              Clear
            </UnstyledButton>
          )}
        </div>
        {/* How the last send ended, where the person is: focused, so it is
            read out, and dismissed here and on Home at once. */}
        {sendJob?.done && sendJob.ending && (
          // Focused when it appears, so it is read out once, as focus
          // arrives; its notice is not a live region as well.
          <div ref={resultRef} tabIndex={-1} className="vault-send-result" data-focus-managed>
            {/* One sentence, in the same words as Home's notice. The proof's time is in Diagnostics. */}
            {sendJob.ending === 'sent' && sendJob.outcome && (
              <Done title="Sending" onClose={dismissResult} closeLabel="Dismiss" role={undefined}>
                <span>
                  {hidden ? '••••' : showNau(paymentsTotalNau(sendJob.request))} NPT to <bdi>{whoOf(sendJob.request)}</bdi>, plus a {hidden ? '••••' : showNau(BigInt(sendJob.request.fee_nau ?? '0'))} NPT fee. {SENDING_UNTIL_CONFIRMED}
                </span>
                {lastRecipient && !savedName && (
                  <span>
                    <UnstyledButton onClick={() => setSaving(true)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                      Save recipient as a contact
                    </UnstyledButton>
                  </span>
                )}
              </Done>
            )}
            {sendJob.ending === 'unconfirmed' && (
              <Caution title={UNANSWERED_TITLE} onClose={dismissResult} closeLabel="Dismiss">
                <span>
                  Your {hidden ? '••••' : showNau(paymentsTotalNau(sendJob.request))} NPT to <bdi>{whoOf(sendJob.request)}</bdi> {MAY_HAVE_GONE_OUT}
                </span>
                <span>
                  <UnstyledButton onClick={() => navigate('/')} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                    See in History
                  </UnstyledButton>
                </span>
              </Caution>
            )}
            {sendJob.ending === 'stopped' && (
              <Info onClose={dismissResult} closeLabel="Dismiss">
                {sendJob.error}
              </Info>
            )}
            {/* Under the title "Not sent", the reason without saying so again. */}
            {sendJob.ending === 'failed' && (
              <ErrorLine title="Not sent" onClose={dismissResult} role={undefined}>
                {notSentReason(sendJob.error ?? '')}
              </ErrorLine>
            )}
          </div>
        )}
        <div className="sr-only" role="status">
          {formSaid}
        </div>
        <form
          ref={formRef}
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
            <Stack role={extras.length > 0 ? 'group' : undefined} aria-labelledby={extras.length > 0 ? 'payee-first' : undefined}>
            {extras.length > 0 && (
              <span className="vault-group-label" id="payee-first">
                Recipient 1
              </span>
            )}
            <div className={contacts.length > 0 ? 'vault-field-action-wrap' : undefined}>
              {/* Offered once there is a contact to choose: in a new wallet it would open an empty list. */}
              {contacts.length > 0 && (
                <UnstyledButton type="button" onClick={() => setPickFor(0)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-field-action" aria-label={extras.length > 0 ? 'Choose a contact for recipient 1' : undefined}>
                  <IconAddressBook size={16} stroke={1.8} aria-hidden />
                  Choose contact
                </UnstyledButton>
              )}
              <TextInput
                ref={recipientRef}
                label="Recipient address"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="Address or request"
                value={recipient}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  // A payment link arriving by any route (keyboard paste, share)
                  // is split into its fields, the same as Paste and Scan do.
                  if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyText(value);
                  else {
                    setRecipient(value);
                    setRecipientError(null);
                    dropRequest();
                  }
                }}
                onBlur={() => void checkRecipient(true)}
                error={recipientError}
                description={nameNote(recipient, linkMeta?.label)}
                inputWrapperOrder={['label', 'input', 'description', 'error']}
                rightSectionWidth={80}
                rightSection={
                  <Button variant="subtle" size="compact-sm" className="vault-tap" leftSection={<IconScan size={16} stroke={1.8} />} onClick={() => setScanFor(0)} aria-label={extras.length > 0 ? "Scan recipient 1's address" : undefined}>
                    Scan
                  </Button>
                }
              />
            </div>
            <TextInput
              ref={(el) => {
                if (el) amountRefs.current.set(0, el);
              }}
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
            </Stack>
            {extras.map((x, i) => (
              <div key={x.id} className="vault-payee" role="group" aria-labelledby={`payee-${x.id}`}>
                <div className="vault-payee-head">
                  <span className="vault-group-label" id={`payee-${x.id}`}>
                    Recipient {i + 2}
                  </span>
                  <UnstyledButton
                    type="button"
                    onClick={() => {
                      // The recipient goes, and its button: focus goes to the amount before it.
                      const before = i === 0 ? 0 : extras[i - 1].id;
                      setExtras((all) => all.filter((y) => y.id !== x.id));
                      setTimeout(() => amountRefs.current.get(before)?.focus(), 0);
                    }}
                    c="var(--v-accent-text)"
                    fz="sm"
                    className="vault-tap-link"
                    aria-label={`Remove recipient ${i + 2}`}
                  >
                    Remove
                  </UnstyledButton>
                </div>
                <div className={contacts.length > 0 ? 'vault-field-action-wrap' : undefined}>
                  {contacts.length > 0 && (
                    <UnstyledButton type="button" onClick={() => setPickFor(x.id)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-field-action" aria-label={`Choose a contact for recipient ${i + 2}`}>
                      <IconAddressBook size={16} stroke={1.8} aria-hidden />
                      Choose contact
                    </UnstyledButton>
                  )}
                  <TextInput
                    label="Recipient address"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Address or request"
                    value={x.recipient}
                    ref={(el) => {
                      if (el && focusExtra.current === x.id) {
                        focusExtra.current = null;
                        el.focus();
                      }
                    }}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyExtraText(x.id, value);
                      else updateExtra(x.id, { recipient: value, recipientError: null });
                    }}
                    onBlur={() => void checkExtraRecipient(x.id, true)}
                    error={x.recipientError}
                    description={contactNote(x.recipient)}
                    inputWrapperOrder={['label', 'input', 'description', 'error']}
                    rightSectionWidth={80}
                    rightSection={
                      <Button variant="subtle" size="compact-sm" className="vault-tap" leftSection={<IconScan size={16} stroke={1.8} />} onClick={() => setScanFor(x.id)} aria-label={`Scan recipient ${i + 2}'s address`}>
                        Scan
                      </Button>
                    }
                  />
                </div>
                <TextInput
                  ref={(el) => {
                    if (el) amountRefs.current.set(x.id, el);
                    else amountRefs.current.delete(x.id);
                  }}
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
            {/* The two extras as links on one line: another recipient, and a note,
                which most sends do without. The note opens where it is asked for. */}
            {(1 + extras.length < MAX_PAYMENTS || !showNote) && (
              <div className="vault-send-extras">
                {1 + extras.length < MAX_PAYMENTS && (
                  <UnstyledButton type="button" onClick={addRecipient} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-add-payee">
                    <IconPlus size={16} stroke={1.8} aria-hidden />
                    Add another recipient
                  </UnstyledButton>
                )}
                {!showNote && (
                  <UnstyledButton
                    type="button"
                    onClick={() => {
                      setNoteOpen(true);
                      setTimeout(() => noteRef.current?.focus(), 0);
                    }}
                    c="var(--v-accent-text)"
                    fz="sm"
                    className="vault-tap-link vault-tap-link-start vault-add-payee"
                  >
                    <IconPlus size={16} stroke={1.8} aria-hidden />
                    Add a note
                  </UnstyledButton>
                )}
              </div>
            )}
            {/* For the whole send, however many recipients: kept in History on this device, never sent. */}
            {showNote && (
              <TextInput ref={noteRef} label="Note to self (optional)" description="Only you see it, in History." placeholder="What it is for" value={note} maxLength={SEND_NOTE_MAX} onChange={(e) => setNote(e.currentTarget.value)} />
            )}
            <div>
              <Text size="sm" fw={600}>
                Fee (NPT)
              </Text>
              {/* What the fee buys, which the numbers alone do not say. Proof
                  upgraders take part of it for proving the send into a block,
                  and pick the sends that pay them best first. A hint about a
                  choice comes before it, as under every field's name. */}
              <Text id="fee-hint" size="sm" c="dimmed" mb={6}>
                Higher-fee sends go first in a queue.
              </Text>
              <SegmentedControl
                fullWidth
                orientation={stacked ? 'vertical' : 'horizontal'}
                onPointerDown={() => (feeByPointer.current = true)}
                onKeyDown={() => (feeByPointer.current = false)}
                aria-label="Fee"
                aria-describedby="fee-hint"
                value={feePreset}
                onChange={(v) => {
                  setFeePreset(v);
                  const preset = FEE_PRESETS.find((x) => x.value === v);
                  if (preset && preset.fee) setFee(preset.fee);
                  else if (v === 'custom') {
                    setFee('');
                    if (feeByPointer.current) setTimeout(() => customFeeRef.current?.focus(), 0);
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
                onBlur={() => void (maxFollowsFee() ? sendAll() : checkAmounts(true))}
                error={feeError}
                ref={customFeeRef}
              />
            )}
            {/* Why Review waits, one look for both reasons: a sentence, no
                title. The node's own words are on Settings, Advanced. */}
            {!online && <Caution>You are offline. Review works again once you are back online.</Caution>}
            {online && nodeDown && (
              <Caution>
                <span>The node is not answering, so sending has to wait.</span>
                {/* The same two actions as Home's status line, in the same form. */}
                <Group gap="sm" mt={4}>
                  <UnstyledButton onClick={() => void syncNow()} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                    Try again
                  </UnstyledButton>
                  <UnstyledButton onClick={() => navigate('/settings/advanced', { state: { from: 'send' } })} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
                    Settings
                  </UnstyledButton>
                </Group>
              </Caution>
            )}
            <Button type="submit" disabled={!online || nodeDown}>
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
          dropRequest();
        }}
      />
      {lastRecipient && (
        <ContactForm
          opened={saving}
          onClose={() => setSaving(false)}
          fixedAddress={lastRecipient}
          initialName={lastLabel ?? undefined}
          onSave={async (name, address) => {
            if (!account) return;
            const c = await services.contacts.add(account.id, name, address);
            setSavedName(c.name);
            loadContacts();
            setSaving(false);
            // The link that was pressed is now a sentence: the result it is in takes the focus.
            setTimeout(() => resultRef.current?.focus(), 300);
          }}
        />
      )}
    </Paper>
  );
}

/** "about 2 min" at the start of a sentence. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

