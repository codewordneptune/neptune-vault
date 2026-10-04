// Send screen: a recipient and an amount (or several, paid by one
// transaction), a fee; validation before a review step; the proof itself
// runs as a job in the app context so it survives this screen being
// unmounted (backgrounding locks the app).

import { ActionIcon, Badge, Button, Checkbox, Divider, Group, Input, Loader, Paper, PasswordInput, Progress, Stack, Text, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { useMediaQuery, useReducedMotion } from '@mantine/hooks';
import { IconFingerprint, IconPlus, IconScan, IconUsers } from '@tabler/icons-react';
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Sheet } from '../components/Sheet';
import { formatNau, NAU_PER_COIN, showNau, UNANSWERED_TITLE, useApp } from '../app/AppContext';
import { clearSendDraft, keepSendDraft, sendDraft, type ExtraPayee, type SendDraft } from '../app/sendDraft';
import { DESKTOP } from '../app/platform';
import { formatAbout, formatDuration, timeAgo } from '../util/time';
import { QUOTE_OLD_MS, useQuote } from '../app/price';
import { decimalsProblem } from '../util/amount';
import { fiatOf, fiatOfTyped, formatFiat } from '../util/fiat';
import { cleanNote, givenUpRivals, MAX_PAYMENTS, paymentsTotalNau, SEND_NOTE_MAX, RequiresLustrationError, SendBusyError, SendUnconfirmedError } from '../app/send';
import { isCancellation } from '../app/passkey';
import { WrongPasswordError } from '../storage/envelope';
import { ContactPicker } from '../components/ContactPicker';
import { Amount } from '../components/Amount';
import { Spoken } from '../components/Spoken';
import { ChoiceField } from '../components/ChoiceField';
import { Caution, ErrorLine, Info } from '../components/Notice';
import { MAY_HAVE_GONE_OUT, notSentReason, PREPARING_SEND, sendStageText, SENDING_UNTIL_CONFIRMED, SENT_WAITING } from '../app/words';
import { usePendingSends } from '../app/pending';
import { QrScanner } from '../components/QrScanner';
import { ContactForm } from './Contacts';
import { abbreviateAddress, addressKindNote, parsePaymentText } from '../util/address';
import { networkLabel } from '../util/network';
import { confirmsSends, type ContactRecord, type HistoryRecord } from '../storage/db';

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

/**
 * The fee as a share of what it pays for, said once it is over a fifth: the
 * default fee is 60% of a 0.5 NPT send. Figures for reading, not for money.
 */
function feeShareNote(feeNpt: number, amountNpt: number, several: boolean): string | null {
  if (!(feeNpt > 0) || !(amountNpt > 0) || feeNpt <= amountNpt / 5) return null;
  const of = several ? 'the amounts together' : 'the amount';
  return feeNpt > amountNpt ? `The fee is larger than ${of}.` : `The fee is ${Math.round((feeNpt / amountNpt) * 100)}% of ${of}.`;
}

/** A typed amount in NPT, for reading; null when it is not one yet. */
function typedNpt(text: string): number | null {
  const plain = text.replace(/[\s  ]/g, '');
  return /^(\d+(\.\d*)?|\.\d+)$/.test(plain) ? Number(plain) : null;
}
const presetFee = (preset: string, custom: string | undefined) =>
  preset === 'custom' ? (custom ?? '') : (FEE_PRESETS.find((p) => p.value === preset)?.fee ?? DEFAULT_FEE);

type Step = 'form' | 'review';

// Where an amount's or a fee's estimate in another currency sits: under the
// field, and above any error, like the other notes about a field.
const UNDER_THE_FIELD: ('label' | 'input' | 'description' | 'error')[] = ['label', 'input', 'description', 'error'];

/**
 * Choose contact and Scan inside an address field: each fills the field, so
 * they sit in it, as icons named for screen readers and in a tooltip.
 * Choose contact is offered once there is a contact: in a new wallet it
 * would open an empty list. `who` names the recipient when there are several.
 * A press leaves the focus in the field: a field left holding an address
 * turns into a card, which would take these buttons away mid-click.
 */
function FieldActions({ contacts, onPick, onScan, who }: { contacts: boolean; onPick: () => void; onScan: () => void; who: string | null }) {
  return (
    <Group gap={4} wrap="nowrap">
      {contacts && (
        <Tooltip label="Choose contact">
          <ActionIcon type="button" variant="subtle" size="lg" className="vault-tap" onMouseDown={(e) => e.preventDefault()} onClick={onPick} aria-label={who ? `Choose a contact for ${who}` : 'Choose contact'}>
            <IconUsers size={20} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label="Scan">
        <ActionIcon type="button" variant="subtle" size="lg" className="vault-tap" onMouseDown={(e) => e.preventDefault()} onClick={onScan} aria-label={who ? `Scan ${who}'s address` : 'Scan'}>
          <IconScan size={20} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * A recipient once its field holds a whole address and the person has left
 * it: who it is, by the saved contact's name or a request's (said to be
 * unverified), or that no contact has the address, with Change at the end
 * of that line, which brings the field back with the address selected,
 * Choose contact and Scan beside it; under it the address, shortened as
 * everywhere, across the card; and its kind when it is not Standard, as on
 * the review.
 */
function RecipientCard({ address, name, requestName, who, onChange, changeRef }: { address: string; name: string | null; requestName: string | null; who: string | null; onChange: () => void; changeRef: (el: HTMLButtonElement | null) => void }) {
  const labelId = useId();
  const kind = addressKindNote(address);
  const shownName = name ?? requestName;
  return (
    <Input.Wrapper label="Recipient address" labelElement="div" size="md" labelProps={{ id: labelId }}>
      <div className="vault-recipient" role="group" aria-labelledby={labelId}>
        {/* The people icon marks a saved contact; a request's name says "unverified" instead. */}
        {name && <IconUsers size={20} aria-hidden className="vault-recipient-icon" />}
        <div className="vault-recipient-text">
          <div className="vault-recipient-head">
            {shownName ? (
              <div className="vault-recipient-name">
                <Text span fw={600} truncate>
                  <bdi>{shownName}</bdi>
                </Text>
                {/* Never cut off: a link can carry any name. */}
                {!name && (
                  <Text span size="sm" c="dimmed" style={{ flex: 'none' }}>
                    (unverified)
                  </Text>
                )}
              </div>
            ) : (
              <Text span size="sm" c="dimmed">
                Not in your contacts
              </Text>
            )}
            <UnstyledButton ref={changeRef} type="button" onClick={onChange} c="var(--v-accent-text)" fz="sm" className="vault-tap-link" aria-label={who ? `Change ${who}` : 'Change the recipient'}>
              Change
            </UnstyledButton>
          </div>
          <Text ff="monospace" size="sm" c={shownName ? 'dimmed' : undefined}>
            {abbreviateAddress(address)}
          </Text>
          {kind && (
            <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
              {kind}
            </Badge>
          )}
        </div>
      </div>
    </Input.Wrapper>
  );
}

export function Send() {
  const { services, account, balance, utxos, history, online, sync, syncNow, sendJob, screenAwake, startSend, cancelSend, dismissSendJob, dismissLastSend, dismissSendFailure } = useApp();
  // Sends given up on that may still pay someone a send to these addresses pays (givenUpRivals).
  const rivalsFor = (addresses: string[]) => givenUpRivals(history, new Set(utxos.filter((u) => u.spentHeight === null && u.pendingTxid === null).map((u) => u.hash)), addresses);
  // Whether an address is this wallet's own, so a send to it says "yourself".
  const { isOwn } = usePendingSends();
  // Amounts hidden on Home stay hidden here, the review and its errors included.
  const hidden = services.settings.hideBalance ?? false;
  const spendableText = `Spendable ${hidden ? '••••' : showNau(balance.spendableNau)} NPT`;
  const reducedMotion = useReducedMotion();
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
  // `link`: a payment link opened from another app or a web page, in the
  // phone app (app/paymentLinks.ts), read below as a scanned code is.
  const arrival = location.state as { recipient?: string; fresh?: boolean; link?: string } | null;
  const prefill = arrival?.recipient;
  // "Send to" a contact, a new send by shortcut, or a payment link starts
  // with an empty form: a draft's amount or extra recipients were meant for
  // someone else.
  const draft = account && !prefill && !arrival?.fresh && !arrival?.link ? sendDraft(account.id) : undefined;
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
  /** The saved contact's name for an address, or null. */
  const contactName = (address: string): string | null => {
    const wanted = address.trim().toLowerCase();
    return (wanted && contacts.find((c) => c.address === wanted)?.name) || null;
  };
  // Who a send went to, as every notice about it names them, Home's too:
  // the contact, or the address shortened, and how many more.
  const whoOf = (request: { payments: { recipient: string }[] }): string => {
    const first = request.payments[0]?.recipient.trim() ?? '';
    const others = request.payments.length - 1;
    if (!others && first && isOwn(first)) return 'yourself';
    const name = contacts.find((c) => c.address === first.toLowerCase())?.name ?? abbreviateAddress(first);
    return others ? `${name} and ${others} more` : name;
  };

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
  // Focused when Custom is chosen, for the fee to be typed next; not
  // whenever the field happens to mount.
  const customFeeRef = useRef<HTMLInputElement>(null);
  const feeLevel = FEE_PRESETS.find((p) => p.value === feePreset)?.label;
  const choiceEstimate = feePreset === 'custom' ? undefined : estimateOf(fee);
  const chooseFee = (value: string) => {
    if (value === feePreset) return;
    setFeePreset(value);
    const preset = FEE_PRESETS.find((p) => p.value === value);
    if (preset?.fee) setFee(preset.fee);
    else {
      setFee('');
      setTimeout(() => customFeeRef.current?.focus(), 0);
    }
    if (value !== 'custom') void services.updateSettings({ feePreset: value });
  };
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

  // A recipient field holding a valid address shows it as a card once the
  // person has left it. `editing`: the field they are in, 0 for the first,
  // else an added one's id. The addresses found valid on this network are
  // kept, lower case, so a card shows without waiting on a check it passed.
  const [editing, setEditing] = useState<number | null>(null);
  const [validAddresses, setValidAddresses] = useState<ReadonlySet<string>>(() => new Set());
  const addressList = [recipient, ...extras.map((x) => x.recipient)]
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
  useEffect(() => {
    if (!addressList) return;
    let live = true;
    const all = [...new Set(addressList.split('\n'))];
    void Promise.all(all.map(async (a) => ((await services.core.isValidAddress(a, services.networkName())) ? a : null))).then(
      (found) => {
        const valid = found.filter((a): a is string => a !== null);
        if (live && valid.length > 0) setValidAddresses((known) => (valid.every((a) => known.has(a)) ? known : new Set([...known, ...valid])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [services, addressList]);
  const asCard = (id: number, address: string, error: string | null) => editing !== id && error === null && validAddresses.has(address.trim().toLowerCase());
  // Where focus goes as a field and its card trade places: into the field
  // (Change, Clear), or to the card's Change once Choose contact or Scan
  // filled it. Their sheet hands focus back to the field as it closes; that
  // is not the person going back into it.
  const focusFirst = useRef(false);
  const focusCard = useRef<number | null>(null);
  const justFilled = useRef<{ id: number; until: number } | null>(null);
  const enterField = (id: number) => {
    const filled = justFilled.current;
    if (filled && filled.id === id && Date.now() < filled.until) return;
    focusCard.current = null;
    setEditing(id);
  };
  const leaveField = (id: number) => setEditing((f) => (f === id ? null : f));
  const filledField = (id: number) => {
    justFilled.current = { id, until: Date.now() + 1000 };
    focusCard.current = id;
    leaveField(id);
  };
  const changeRecipient = (id: number) => {
    if (id === 0) focusFirst.current = true;
    else focusExtra.current = id;
    setEditing(id);
  };
  const cardChangeRef = (id: number) => (el: HTMLButtonElement | null) => {
    if (el && focusCard.current === id) {
      focusCard.current = null;
      el.focus();
    }
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

  // A link left in a field because it did not read keeps its own message.
  const linkProblem = (text: string) => (/^\s*[a-z]+:/i.test(text) ? (parsePaymentText(text).error ?? null) : null);

  const checkRecipient = async (leaving = false): Promise<boolean> => {
    const message = leaving && recipient.trim() === '' ? null : (linkProblem(recipient) ?? (await addressProblem(recipient, [])));
    setRecipientError(message);
    return message === null;
  };

  const checkExtraRecipient = async (id: number, leaving = false): Promise<boolean> => {
    const at = extras.findIndex((x) => x.id === id);
    if (at < 0) return true;
    const earlier = [recipient, ...extras.slice(0, at).map((x) => x.recipient)].map((a) => a.trim().toLowerCase());
    const empty = extras[at].recipient.trim() === '';
    const message = empty ? (leaving ? null : 'Enter the address, or remove this recipient') : (linkProblem(extras[at].recipient) ?? (await addressProblem(extras[at].recipient, earlier)));
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
        { rivals: rivalsFor(addresses) },
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

  // `typed`: the text came through the field itself. One that does not read
  // stays there, with its message, to be seen and corrected.
  const applyText = useCallback(
    (text: string, typed = false) => {
      const parsed = parsePaymentText(text);
      if (parsed.error) {
        if (typed) setRecipient(text);
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
  const applyExtraText = (id: number, text: string, typed = false) => {
    const parsed = parsePaymentText(text);
    if (parsed.error) {
      updateExtra(id, { recipientError: parsed.error, ...(typed ? { recipient: text } : {}) });
      return;
    }
    updateExtra(id, { recipient: parsed.address, recipientError: null, ...(parsed.amount ? { amount: parsed.amount, amountError: null } : {}) });
  };

  const [formSaid, setFormSaid] = useState('');
  const onScanned = (text: string) => {
    const target = scanFor;
    setScanFor(null);
    filledField(target ?? 0);
    const first = target === null || target === 0;
    if (first) applyText(text);
    else applyExtraText(target, text);
    // Said as it went: a code that is not a request fills nothing.
    const parsed = parsePaymentText(text);
    const filled = parsed.amount ? 'Address and amount' : 'Address';
    setFormSaid(parsed.error ? `The QR code was not used. ${parsed.error}` : first ? `${filled} filled from the QR code.` : `${filled} of recipient ${extras.findIndex((x) => x.id === target) + 2} filled from the QR code.`);
  };

  // Clear starts the form over: every recipient and amount, the added ones,
  // a request's name, the note, and a custom fee, back to the usual level
  // (Low, Medium and High are a setting, kept between sends). One tap and no
  // dialog: it can be pressed only while the form holds something, away from
  // Review, and touches nothing sent or saved. Focus goes to the recipient,
  // where the form starts again, not to a button that can no longer be pressed.
  const recipientRef = useRef<HTMLInputElement>(null);
  // The fee against the amounts typed, said while its choices are open.
  const typedAmounts = [amount, ...extras.map((x) => x.amount)].map(typedNpt);
  const formFeeNote = typedAmounts.every((n) => n !== null) ? feeShareNote(typedNpt(fee) ?? 0, typedAmounts.reduce<number>((sum, n) => sum + (n ?? 0), 0), extras.length > 0) : null;
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
    // A card gives way to the empty field, which takes the focus as it comes.
    if (recipientRef.current) recipientRef.current.focus();
    else focusFirst.current = true;
  };

  // A payment link opened from elsewhere: the form starts over from it, as
  // from a scanned code, and a review open for an earlier send closes. Each
  // link once, by its place in the history; nothing goes out without the
  // review.
  const linkRead = useRef<string | null>(null);
  useEffect(() => {
    const link = arrival?.link;
    if (!link || linkRead.current === location.key) return;
    linkRead.current = location.key;
    setStep('form');
    clearForm();
    applyText(link);
    setFormSaid('Filled in from the payment link.');
    // The form's own helpers, as they are now; the arrival is what counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

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
            {PREPARING_SEND}
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
                <Text>{sendStageText(sendJob.progress.stage, true)}…</Text>
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
              <Spoken text={estimate !== null ? `${capitalise(formatAbout(estimate))} on this device · ` : ''} />
              <Spoken text={`${formatDuration(provingSeconds)} so far`} />
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
        <Sheet opened={confirmStop} onClose={() => setConfirmStop(false)} title="Stop this send?">
          <Stack>
            <Text size="sm">What it has done so far (<Spoken text={formatDuration(provingSeconds)} />) is lost. Nothing has been sent.</Text>
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
        </Sheet>
      </Paper>
    );
  }

  // The review is a sheet over the form, so the form stays in view and
  // "Edit" is a step back rather than a screen change.
  let reviewSheet: ReactNode = null;
  if (step === 'review' && totals) {
    const totalNau = totals.amountNau + totals.feeNau;
    const reviewFeeNote = feeShareNote(Number(totals.feeNau), Number(totals.amountNau), extras.length > 0);
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
    const picked: typeof coins = [];
    for (const c of coins) {
      if (heldNau >= totalNau) break;
      heldNau += BigInt(c.amountNau);
      picked.push(c);
    }
    // A send given up on that may still pay the same person: this send also
    // spends one of its coins, as SendService does, alone if it pays for all.
    const rivals = rivalsFor(payees.map((x) => x.address));
    const added: typeof coins = [];
    for (const rival of rivals) {
      const theirs = coins.filter((u) => rival.inputHashes.includes(u.hash));
      if (theirs.length > 0 && !theirs.some((u) => picked.includes(u) || added.includes(u))) added.push(theirs[0]);
    }
    if (added.length === 1 && BigInt(added[0].amountNau) >= totalNau) heldNau = BigInt(added[0].amountNau);
    else heldNau += added.reduce((sum, u) => sum + BigInt(u.amountNau), 0n);
    const rivalTo = (rival: HistoryRecord) => {
      const to = (rival.payments?.length ? rival.payments.map((x) => x.recipient) : [rival.recipient ?? '']).find((a) => payees.some((x) => x.address.toLowerCase() === a.toLowerCase())) ?? '';
      return contactName(to) ?? abbreviateAddress(to);
    };
    // What stays spendable while it is pending, and the change on hold until it confirms: said only when there is change.
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
                      Name, unverified:{' '}
                      <Text span inherit c="var(--v-text)" fw={600} dir="auto" className="vault-bidi">
                        {linkMeta.label}
                      </Text>
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
            {/* As under the balance: the price's age once it is getting old, its source in Settings, Currency. */}
            {quote && (
              <Text size="xs" c="dimmed" ta="right" mt={-6} style={{ fontVariantNumeric: 'tabular-nums' }}>
                <Spoken text={`≈ ${formatFiat(fiatOf(totalNau, NAU_PER_COIN, quote.price), quote.currency)}`} />
                {Date.now() - quote.at > QUOTE_OLD_MS && <Spoken text={` · price from ${timeAgo(quote.at)}`} />}
              </Text>
            )}
            {reviewFeeNote && (
              <Text size="sm" c="var(--v-warn-text)" mt="xs">
                {reviewFeeNote}
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
          {/* Only when this send has change, and never while amounts are hidden. */}
          {!hidden && spendableWhile !== spendableAfter && (
            <Text size="sm" c="dimmed">
              <Spoken text={`While this send is pending, ${showNau(spendableWhile)} NPT stays spendable; its change of ${showNau(spendableAfter - spendableWhile)} NPT is on hold until it confirms.`} />
            </Text>
          )}
          {rivals.length > 0 && (
            <Caution title="An earlier send may still go through">
              <Spoken
                text={
                  rivals.length === 1
                    ? `Your earlier ${hidden ? '' : `${showNau(BigInt(rivals[0].amountNau))} NPT `}to ${rivalTo(rivals[0])} may still go through: giving up on it did not call it back. This send spends one of the same coins, so only one of the two can go through.`
                    : `${rivals.length} earlier sends you gave up on may still go through. This send spends one coin of each, so none of them can go through along with it.`
                }
              />
            </Caution>
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
              label={<Spoken text={`The fee is ${showNau(totals.feeNau)} NPT, which is unusually high. Pay it anyway.`} />}
            />
          )}
          {totals.feeLow && (
            <Checkbox
              checked={feeAgreed}
              onChange={(e) => setFeeAgreed(e.currentTarget.checked)}
              label={<Spoken text={`The fee is ${showNau(totals.feeNau)} NPT. Nodes usually do not finish proving sends that pay less than about ${LOW_FEE} NPT, so this one may never confirm. Send it anyway.`} />}
            />
          )}
          {/* The password or passkey, before the send starts: the proof is made only after it. */}
          {needsApproval && (
            <Stack gap="sm">
              {hasPasskey && (
                <>
                  <Button leftSection={<IconFingerprint size={16} />} loading={passkeyBusy || (starting && !checking)} disabled={running || checking || ((totals.feeHigh || totals.feeLow) && !feeAgreed)} onClick={() => void confirmWithPasskey()}>
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
        <Sheet opened={reviewSheet !== null} onClose={() => setStep('form')} title="Review" size={560} centered fullScreen={phone}>
          {reviewSheet}
        </Sheet>
        <Title order={2} className="sr-only">
          Send
        </Title>
        {/* Clear, away from Review, always in its place so that nothing moves as
            the form fills, and pressable only while it holds something to clear. */}
        <div className="vault-send-head">
          <UnstyledButton type="button" onClick={clearForm} disabled={!hasContent} aria-label="Clear the form" c={hasContent ? 'var(--v-accent-text)' : 'var(--v-faint)'} fz="sm" className="vault-tap-link">
            Clear
          </UnstyledButton>
        </div>
        {/* How the last send ended, where the person is: focused, so it is
            read out, and dismissed here and on Home at once. */}
        {sendJob?.done && sendJob.ending && (
          // Focused when it appears, so it is read out once, as focus
          // arrives; its notice is not a live region as well.
          <div ref={resultRef} tabIndex={-1} className="vault-send-result" data-focus-managed>
            {/* One sentence, in the same words as Home's notice. The proof's time is in Diagnostics. */}
            {sendJob.ending === 'sent' && sendJob.outcome && (
              <Info title={SENT_WAITING} onClose={dismissResult} closeLabel="Dismiss">
                <span>
                  <Spoken text={hidden ? '••••' : showNau(paymentsTotalNau(sendJob.request))} /> NPT to <bdi>{whoOf(sendJob.request)}</bdi>, plus a <Spoken text={hidden ? '••••' : showNau(BigInt(sendJob.request.fee_nau ?? '0'))} /> NPT fee. {SENDING_UNTIL_CONFIRMED}
                </span>
                {lastRecipient && !savedName && (
                  <span>
                    <UnstyledButton onClick={() => setSaving(true)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                      Save recipient as a contact
                    </UnstyledButton>
                  </span>
                )}
              </Info>
            )}
            {sendJob.ending === 'unconfirmed' && (
              <Caution title={UNANSWERED_TITLE} onClose={dismissResult} closeLabel="Dismiss">
                <span>
                  Your <Spoken text={hidden ? '••••' : showNau(paymentsTotalNau(sendJob.request))} /> NPT to <bdi>{whoOf(sendJob.request)}</bdi> {MAY_HAVE_GONE_OUT}
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
            <Stack role={extras.length > 0 ? 'group' : undefined} aria-labelledby={extras.length > 0 ? 'payee-first' : undefined}>
            {extras.length > 0 && (
              <span className="vault-group-label" id="payee-first">
                Recipient 1
              </span>
            )}
              {asCard(0, recipient, recipientError) ? (
                <RecipientCard
                  address={recipient.trim()}
                  name={contactName(recipient)}
                  requestName={linkMeta?.label ?? null}
                  who={extras.length > 0 ? 'recipient 1' : null}
                  onChange={() => changeRecipient(0)}
                  changeRef={cardChangeRef(0)}
                />
              ) : (
              <TextInput
                ref={(el) => {
                  recipientRef.current = el;
                  if (el && focusFirst.current) {
                    focusFirst.current = false;
                    el.focus();
                    el.select();
                  }
                }}
                label="Recipient address"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="Address or request"
                classNames={{ input: 'vault-address-input' }}
                value={recipient}
                onFocus={() => enterField(0)}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setEditing(0);
                  // A payment link arriving by any route (keyboard paste, share)
                  // is split into its fields, the same as Paste and Scan do.
                  if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyText(value, true);
                  else {
                    setRecipient(value);
                    setRecipientError(null);
                    dropRequest();
                  }
                }}
                onBlur={() => void checkRecipient(true)}
                wrapperProps={{ onBlur: (e: FocusEvent<HTMLDivElement>) => !e.currentTarget.contains(e.relatedTarget) && leaveField(0) }}
                error={recipientError}
                inputWrapperOrder={['label', 'input', 'description', 'error']}
                rightSectionWidth={contacts.length > 0 ? 84 : 48}
                rightSection={<FieldActions contacts={contacts.length > 0} onPick={() => setPickFor(0)} onScan={() => setScanFor(0)} who={extras.length > 0 ? 'recipient 1' : null} />}
              />
              )}
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
              error={amountError && <Spoken text={amountError} />}
              description={<Spoken text={[estimateOf(amount), spendableText].filter(Boolean).join(' · ')} />}
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
                  {asCard(x.id, x.recipient, x.recipientError) ? (
                    <RecipientCard
                      address={x.recipient.trim()}
                      name={contactName(x.recipient)}
                      requestName={null}
                      who={`recipient ${i + 2}`}
                      onChange={() => changeRecipient(x.id)}
                      changeRef={cardChangeRef(x.id)}
                    />
                  ) : (
                  <TextInput
                    label="Recipient address"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Address or request"
                    classNames={{ input: 'vault-address-input' }}
                    value={x.recipient}
                    ref={(el) => {
                      if (el && focusExtra.current === x.id) {
                        focusExtra.current = null;
                        el.focus();
                        el.select();
                      }
                    }}
                    onFocus={() => enterField(x.id)}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setEditing(x.id);
                      if (/^\s*[a-z]+:/i.test(value) && value.includes('1')) applyExtraText(x.id, value, true);
                      else updateExtra(x.id, { recipient: value, recipientError: null });
                    }}
                    onBlur={() => void checkExtraRecipient(x.id, true)}
                    wrapperProps={{ onBlur: (e: FocusEvent<HTMLDivElement>) => !e.currentTarget.contains(e.relatedTarget) && leaveField(x.id) }}
                    error={x.recipientError}
                    inputWrapperOrder={['label', 'input', 'description', 'error']}
                    rightSectionWidth={contacts.length > 0 ? 84 : 48}
                    rightSection={<FieldActions contacts={contacts.length > 0} onPick={() => setPickFor(x.id)} onScan={() => setScanFor(x.id)} who={`recipient ${i + 2}`} />}
                  />
                  )}
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
                  error={x.amountError && <Spoken text={x.amountError} />}
                  description={estimateOf(x.amount) && <Spoken text={estimateOf(x.amount)} />}
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
                    <IconPlus size={16} aria-hidden />
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
                    <IconPlus size={16} aria-hidden />
                    Add a note
                  </UnstyledButton>
                )}
              </div>
            )}
            {/* For the whole send, however many recipients: kept in History on this device, never sent. */}
            {showNote && (
              <TextInput ref={noteRef} label="Note to self (optional)" description="Only you see it, in History." placeholder="What it is for" value={note} maxLength={SEND_NOTE_MAX} onChange={(e) => setNote(e.currentTarget.value)} />
            )}
            {/* Chosen as the address type is on Receive: a field that opens the
                list, each choice with what it costs; under the field, as under
                an amount, its estimate in another currency. */}
            <ChoiceField
              label="Fee"
              value={feePreset}
              face={
                feePreset === 'custom' ? (
                  feeLevel
                ) : (
                  <>
                    {feeLevel} <span className="vault-choice-amount">{fee} NPT</span>
                  </>
                )
              }
              choices={FEE_PRESETS.map((p) => ({ value: p.value, name: p.label, note: p.fee ? <Spoken text={[`${p.fee} NPT`, estimateOf(p.fee)].filter(Boolean).join(' · ')} /> : 'Any amount you choose' }))}
              hint="A higher fee usually confirms sooner when the network is busy."
              onChoose={chooseFee}
              reading={choiceEstimate && <Spoken text={choiceEstimate} />}
            />
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
                error={feeError && <Spoken text={feeError} />}
                description={estimateOf(fee) && <Spoken text={estimateOf(fee)} />}
                inputWrapperOrder={UNDER_THE_FIELD}
                ref={customFeeRef}
              />
            )}
            {formFeeNote && (
              <Text size="sm" c="var(--v-warn-text)">
                {formFeeNote}
              </Text>
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
      {/* Closed without a choice, a field the sheet left as a card gets the focus back on its Change. */}
      <QrScanner
        opened={scanFor !== null}
        onClose={() => {
          focusCard.current = scanFor;
          setScanFor(null);
        }}
        onResult={onScanned}
      />
      <ContactPicker
        opened={pickFor !== null}
        onClose={() => {
          focusCard.current = pickFor;
          setPickFor(null);
        }}
        onPick={(c) => {
          const target = pickFor;
          setPickFor(null);
          filledField(target ?? 0);
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

