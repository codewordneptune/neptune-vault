// Receiving: the address of each kind as text and QR code, and a
// payment request (NIP-002 link with amount, name and note) with its own
// code. Two tabs, because the address code and the request code must never
// be mistaken for one another. Key 0 of a kind is its main address; "next
// unused" derives the next key of that kind.

import { ActionIcon, Button, Group, Loader, Menu, Modal, Paper, SegmentedControl, Stack, Tabs, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconArrowsMaximize, IconChevronRight, IconCopy, IconDotsVertical, IconPencil, IconShare, IconTrash } from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

import { QrFullScreen } from '../components/QrFullScreen';
import { Caution, Done, Info } from '../components/Notice';

import { formatNau, showNau, useApp } from '../app/AppContext';
import { ADDRESS_LABEL_MAX, addressKey, cleanLabel, coinAddressKey, readLabels, writeLabel, type AddressLabels } from '../app/addressLabels';
import { coinKeyOfReceipt } from '../util/history';
import { useQuote } from '../app/price';
import { decimalsProblem } from '../util/amount';
import { fiatOfTyped, formatFiat } from '../util/fiat';
import { nextKeyIndicesOf } from '../storage/db';
import { abbreviateAddress, metaProblem, paymentQrPayload, paymentUri } from '../util/address';
import { copyText } from '../util/clipboard';
import { groupDigits, showInt } from '../util/format';
import { KEY_LOOKAHEAD, type KeyKind } from '../backend/types';

// Labelled by what the address is for; the protocol's name for the kind is
// said once, at the end of its note under the choice, not on the choice.
const KIND_LABELS: Record<KeyKind, string> = {
  generation: 'Standard',
  ec_hybrid: 'Short',
  viewing: 'View-only',
};
const KIND_PROTOCOL: Record<KeyKind, string> = {
  generation: 'Generation',
  ec_hybrid: 'EC hybrid',
  viewing: 'Viewing',
};

// What the chosen kind is for, said the same way for each so they can be
// compared: who it is for first, then its one trade-off. The guidance of
// the desktop wallet's addresses page, but for reuse: every payment carries
// its address's receiver identifier in the clear, so payments to one address
// can be linked (neptune-wallet's own note on into_announcement), though
// never their amounts. Shown right under the choice, on both tabs (a request
// carries the same address), and before the code and its Copy and Share, so
// the View-only caution is read before sharing.
const KIND_NOTES: Record<KeyKind, string> = {
  generation: `The one to use by default, but long: about ${showInt(3500)} characters. Reusing it is safe, but payments to the same address can be linked on the chain (not their amounts), so give each payer a new address when that matters. Technical name: ${KIND_PROTOCOL.generation} address.`,
  ec_hybrid: `Short enough to paste into a chat. Give each one to a single sender: if one is reused widely, a future quantum computer could reveal the payments sent to it, though never spend them. Technical name: ${KIND_PROTOCOL.ec_hybrid} address.`,
  viewing: `Lets someone watch payments, such as an accountant. Whoever holds it sees every payment it receives, but can never spend them. Share it only with someone you trust with that. Technical name: ${KIND_PROTOCOL.viewing} address.`,
};

/** "Standard main address", "Short address 3". */
function addressTitle(kind: KeyKind, index: number): string {
  return `${KIND_LABELS[kind]} ${index === 0 ? 'main address' : `address ${index}`}`;
}

// The note's shape says how much care the kind needs: information for
// Standard and Short, which are both ordinary choices (the words carry
// Short's one-sender rule), so switching between them changes only the
// words; a caution for View-only, whose exposure cannot be taken back.
function KindNote({ kind }: { kind: KeyKind }) {
  const text = KIND_NOTES[kind];
  return kind === 'viewing' ? <Caution id="kind-note">{text}</Caution> : <Info id="kind-note">{text}</Info>;
}

// A code on the card, like a printed one: the white runs on below it into a
// slim footer that says it opens full screen. The hint sits under the code,
// never on it: a Standard address makes a code so dense that covering any
// of it can stop a camera reading it.
function QrCode({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  return (
    <UnstyledButton onClick={onOpen} aria-label="Show the QR code full screen" className="vault-receive-col vault-qr-code">
      <img src={src} alt={alt} />
      <span className="vault-qr-foot" aria-hidden>
        <IconArrowsMaximize size={16} stroke={1.8} />
        {/* The word for how this device is used: a tap on a phone, a click with a mouse. */}
        <span className="vault-qr-foot-touch">Tap to enlarge</span>
        <span className="vault-qr-foot-mouse">Click to enlarge</span>
      </span>
    </UnstyledButton>
  );
}

/**
 * The code's place while it is being drawn: the same white square and
 * footer, so the buttons beneath stay where they are when another kind of
 * address is chosen instead of jumping up and back under the finger.
 */
function QrPending() {
  return (
    <div className="vault-receive-col vault-qr-code" style={{ cursor: 'default' }} aria-hidden>
      <div style={{ aspectRatio: '1', display: 'grid', placeItems: 'center' }}>
        <Loader size="sm" color="gray" />
      </div>
      <span className="vault-qr-foot">&nbsp;</span>
    </div>
  );
}

type Tab = 'address' | 'request';

const QR_OPTIONS = { type: 'image/png' as const, width: 1200, margin: 2, errorCorrectionLevel: 'L' as const };

export function Receive() {
  const { services, account, history, utxos, checkIncoming } = useApp();
  const hidden = services.settings.hideBalance ?? false;
  // Narrow by the text's own measure (enlarged text counts): the three kinds stack.
  const stacked = useMediaQuery('(max-width: 22em)');
  const [tab, setTab] = useState<Tab>('address');
  const [kind, setKind] = useState<KeyKind>('generation');
  const [indices, setIndices] = useState<Record<KeyKind, number>>({ generation: 0, ec_hybrid: 0, viewing: 0 });
  const [address, setAddress] = useState('');
  const [qr, setQr] = useState<string>('');
  const [addressError, setAddressError] = useState<string | null>(null);
  // Which code, if any, is shown as large as the screen allows.
  const [enlarged, setEnlarged] = useState<'address' | 'request' | null>(null);
  const index = indices[kind];

  // Who each address was given to: a name kept on this device, which History
  // then shows for what arrives through it. The one way to know who paid.
  const [labels, setLabels] = useState<AddressLabels>({});
  useEffect(() => {
    if (!account) return;
    void readLabels(services.core, services.accounts.engine, account.id).then(setLabels, () => setLabels({}));
  }, [services, account]);
  const key = addressKey(kind, index);
  const [forText, setForText] = useState('');
  const [forError, setForError] = useState<string | null>(null);
  useEffect(() => {
    setForText(labels[key] ?? '');
    setForError(null);
  }, [key, labels]);
  const saveFor = async () => {
    if (!account) return;
    const clean = cleanLabel(forText);
    if (clean === (labels[key] ?? '')) return;
    try {
      setLabels(await writeLabel(services.core, services.accounts.engine, account.id, kind, index, clean));
    } catch (e) {
      setForError((e as Error).message);
    }
  };

  // Names are also given, changed and removed from "Your addresses". After
  // the dialog or menu closes, focus goes back to that row's button, or to
  // the list's summary when the row has gone, and what happened is said.
  const [naming, setNaming] = useState<{ kind: KeyKind; index: number } | null>(null);
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const summaryRef = useRef<HTMLElement>(null);
  const refocus = (k: string) => {
    setTimeout(() => (moreButtons.current.get(k) ?? summaryRef.current)?.focus(), 0);
  };
  const nameAddress = async (k: KeyKind, i: number, text: string) => {
    if (!account) return;
    setLabels(await writeLabel(services.core, services.accounts.engine, account.id, k, i, text));
  };
  const removeName = async (k: KeyKind, i: number) => {
    try {
      await nameAddress(k, i, '');
      setSaid(`Name removed from ${addressTitle(k, i)}. Payments to it still arrive.`);
    } catch (e) {
      notifications.show({ color: 'red', message: (e as Error).message });
    }
    refocus(addressKey(k, i));
  };

  // Payments on their way in are looked for every 10 s while this screen is
  // open, so both sides of a payment made in person see it arrive.
  useEffect(() => {
    void checkIncoming();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void checkIncoming();
    }, 10_000);
    return () => clearInterval(t);
  }, [checkIncoming]);
  const toThis = (h: (typeof history)[number]) =>
    h.keyKind !== undefined && h.keyIndex !== undefined ? h.keyKind === kind && h.keyIndex === index : coinAddressKey(utxos.find((u) => u.hash === coinKeyOfReceipt(h))?.stored) === key;
  const arrivingNau = history.filter((h) => h.kind === 'received' && h.status === 'pending' && toThis(h)).reduce((sum, h) => sum + BigInt(h.amountNau), 0n);
  // What came to this address during this visit, on its way or confirmed:
  // rows that were not there when the screen opened. A payment already on
  // its way then is known by its commitment when its block comes.
  const atOpen = useRef<{ keys: Set<string>; pending: Set<string> } | null>(null);
  if (atOpen.current === null && account) {
    atOpen.current = {
      keys: new Set(history.map((h) => h.key)),
      pending: new Set(history.filter((h) => h.status === 'pending').flatMap((h) => (h.outputs ?? []).map((o) => o.commitment))),
    };
  }
  const commitmentOf = (h: (typeof history)[number]) => (utxos.find((u) => u.hash === coinKeyOfReceipt(h))?.stored as { commitment?: string } | undefined)?.commitment;
  const paidNau = history
    .filter((h) => h.kind === 'received' && h.status !== 'failed' && toThis(h) && !atOpen.current?.keys.has(h.key) && !atOpen.current?.pending.has(commitmentOf(h) ?? ''))
    .reduce((sum, h) => sum + BigInt(h.amountNau), 0n);

  // What changed on this screen without a click on it, said once.
  const [said, setSaid] = useState('');
  const arrivedBefore = useRef(arrivingNau);
  useEffect(() => {
    if (arrivingNau > arrivedBefore.current) setSaid(hidden ? 'A payment to this address is pending.' : `${formatNau(arrivingNau - arrivedBefore.current)} NPT to this address is pending.`);
    arrivedBefore.current = arrivingNau;
  }, [arrivingNau, hidden]);

  // The request: amount, name and note. They belong to this visit of the
  // screen: kept while switching tabs, gone when the screen is left.
  const [requestAmount, setRequestAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  // With the balance shown in another currency, the amount asked for is
  // too, as on Send: an estimate on this screen only. The link and the code
  // carry NPT alone.
  const quote = useQuote(services.settings.fiatCurrency);
  const requestEstimate = (() => {
    const value = quote ? fiatOfTyped(requestAmount, quote.price) : null;
    return quote && value !== null && !amountError ? `≈ ${formatFiat(value, quote.currency)}` : undefined;
  })();
  // The requested amount as a conforming NIP-002 decimal (from nau, so
  // "1,5" or ".5" never reach the link), or undefined when none is asked.
  const [linkAmount, setLinkAmount] = useState<string | undefined>(undefined);
  // The same in nau, for saying how much of it has arrived.
  const [requestNau, setRequestNau] = useState<bigint | null>(null);
  // The name the sender sees as the link's label, and a note for the sender
  // (the link's message): shown on their review and kept with their send,
  // never reaching this wallet.
  const [requestLabel, setRequestLabel] = useState('');
  const labelError = requestLabel.trim() ? metaProblem(requestLabel.trim()) : null;
  const [requestNote, setRequestNote] = useState('');
  const noteError = requestNote.trim() ? metaProblem(requestNote.trim()) : null;
  const linkLabel = labelError ? undefined : requestLabel.trim() || undefined;
  const linkNote = noteError ? undefined : requestNote.trim() || undefined;
  const paymentLink = paymentUri(address, linkAmount, linkNote, linkLabel);
  const [requestQr, setRequestQr] = useState('');
  const [requestQrNote, setRequestQrNote] = useState<string | null>(null);

  // Validate the request amount through the wallet core and normalise it.
  useEffect(() => {
    let cancelled = false;
    // A pasted grouped value is fine; spaces are grouping.
    const text = requestAmount.replace(/[\s  ]/g, '');
    if (text === '') {
      setLinkAmount(undefined);
      setRequestNau(null);
      setAmountError(null);
      return;
    }
    // The link carries the amount as the app shows it, eight decimals at
    // most; more would be asked for in one figure and paid in another.
    const tooPrecise = decimalsProblem(text);
    if (tooPrecise) {
      setAmountError(tooPrecise);
      setLinkAmount(undefined);
      return;
    }
    void (async () => {
      try {
        const nau = BigInt(await services.core.parseAmount(text));
        if (cancelled) return;
        if (nau <= 0n) {
          setAmountError('The amount must be greater than zero');
          setLinkAmount(undefined);
          setRequestNau(null);
        } else {
          setAmountError(null);
          setLinkAmount(formatNau(nau));
          setRequestNau(nau);
        }
      } catch {
        if (!cancelled) {
          setAmountError('Enter a number, such as 1.5');
          setLinkAmount(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestAmount, services]);

  // The address of the chosen kind and index, and its code: the address
  // alone. Scheme and address are upper-cased for the alphanumeric mode a
  // generation address needs. A PNG, not an SVG: a long press on a phone
  // saves the image, and galleries and downloaders handle PNG everywhere
  // while an SVG data URL often arrives as a broken file. 1200 px keeps a
  // version-40 code (177 modules) at about 7 px per module.
  useEffect(() => {
    let cancelled = false;
    // The old address and code go at once: nobody must copy or scan the
    // previous kind believing it is the one just chosen.
    setAddress('');
    setQr('');
    setAddressError(null);
    void (async () => {
      try {
        // Always from the keys, the main address included: an address shown
        // here is one people pay to, and nothing unprotected stands in for it.
        const a = await services.core.address(kind, index);
        if (cancelled) return;
        setAddress(a);
        try {
          setQr(await QRCode.toDataURL(paymentQrPayload(a), QR_OPTIONS));
        } catch {
          setQr('');
        }
      } catch (e) {
        if (!cancelled) setAddressError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, index, account, services]);

  // The request's code carries the whole link when it fits; otherwise as
  // much as fits, with a line saying what the link still carries.
  useEffect(() => {
    if (tab !== 'request' || !address) return;
    let cancelled = false;
    void (async () => {
      const render = async (payload: string) => {
        const url = await QRCode.toDataURL(payload, QR_OPTIONS);
        if (!cancelled) setRequestQr(url);
      };
      const withText = Boolean(linkNote || linkLabel);
      try {
        await render(paymentQrPayload(address, linkAmount, linkNote, linkLabel));
        setRequestQrNote(null);
      } catch {
        try {
          await render(paymentQrPayload(address, linkAmount));
          setRequestQrNote(withText ? 'This code cannot hold the name and note, so a sender scanning it will not see them. Share the request instead.' : null);
        } catch {
          try {
            await render(paymentQrPayload(address));
            setRequestQrNote(linkAmount || withText ? 'This code cannot hold the amount, name and note, so a sender scanning it will not see them. Share the request instead.' : null);
          } catch {
            setRequestQr('');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, address, linkAmount, linkNote, linkLabel]);

  // Where the system share sheet exists, the address can go straight into a
  // message; where it does not, Share would only copy, which Copy already does.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  // The text on this screen is the shortened address, so a failed copy points
  // to what carries it in full, never to long-pressing the text.
  const copyFailed = canShare ? 'Could not copy. Use Share instead, or let the sender scan the code.' : 'Could not copy. Try again, or let the sender scan the code.';
  const copy = () => void copyText(address, 'Address copied', copyFailed);
  const shareAddress = async () => {
    try {
      await navigator.share({ text: address });
    } catch {
      // Cancelled by the user; nothing to report.
    }
  };

  // The system share sheet where it exists; otherwise the link is copied.
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ text: paymentLink });
      } catch {
        // Cancelled by the user; nothing to report.
      }
    } else {
      await copyText(paymentLink, 'Payment request copied', copyFailed);
    }
  };

  // The sync looks for payments on every address up to a few past the
  // newest one that has received something. An address further out would
  // never be looked at, and a payment to it never found, so none is offered.
  const used = account ? nextKeyIndicesOf(account)[kind] : 0;
  const furthest = used + KEY_LOOKAHEAD;
  const mainRef = useRef<HTMLButtonElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const nextUnused = () => {
    const next = Math.min(furthest, Math.max(used, index + 1));
    setIndices({ ...indices, [kind]: next });
    setSaid(`${KIND_LABELS[kind]} address ${next} is showing. Payments to it arrive in this wallet like any other.`);
    // At the last address offered, this button goes: focus moves to the one beside it.
    if (next >= furthest) setTimeout(() => mainRef.current?.focus(), 0);
  };
  const toMain = () => {
    setIndices({ ...indices, [kind]: 0 });
    setSaid(`${KIND_LABELS[kind]} main address is showing.`);
    setTimeout(() => newRef.current?.focus(), 0);
  };
  // Every address with a name or a payment, to find one again and see who paid.
  const payments = new Map<string, number>();
  for (const u of utxos) {
    const stored = u.stored as { own_build_height?: number | null } | undefined;
    // Change and payments to oneself are not payments to the address.
    if (stored?.own_build_height !== null && stored?.own_build_height !== undefined) continue;
    const k = coinAddressKey(u.stored);
    if (k) payments.set(k, (payments.get(k) ?? 0) + 1);
  }
  for (const h of history) {
    if (h.kind === 'received' && h.status === 'pending' && h.keyKind !== undefined && h.keyIndex !== undefined) {
      const k = addressKey(h.keyKind, h.keyIndex);
      payments.set(k, (payments.get(k) ?? 0) + 1);
    }
  }
  const known = [...new Set([...Object.keys(labels), ...payments.keys()])]
    .map((k) => ({ key: k, kind: k.split(':')[0] as KeyKind, index: Number(k.split(':')[1]) }))
    .filter((a) => a.kind in KIND_LABELS && Number.isSafeInteger(a.index))
    .sort((a, b) => Object.keys(KIND_LABELS).indexOf(a.kind) - Object.keys(KIND_LABELS).indexOf(b.kind) || a.index - b.index);
  const showAddress = (k: KeyKind, i: number) => {
    setKind(k);
    setIndices((all) => ({ ...all, [k]: i }));
    setTab('address');
    setSaid(`${KIND_LABELS[k]} ${i === 0 ? 'main address' : `address ${i}`} is showing.`);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (index > furthest) setIndices((all) => ({ ...all, [kind]: furthest }));
  }, [index, furthest, kind]);

  const requestInvalid = Boolean(amountError || noteError || labelError);
  // Said only once another address than the main one is showing: on the main
  // address the kind selector above already says what it is, and the worry
  // this answers (will a new address work?) has not come up.
  const rotationNote =
    index === 0
      ? null
      : `${tab === 'address' ? '' : 'The request is to '}${KIND_LABELS[kind]} address ${index}. ` +
        (index >= furthest ? 'More addresses open up once one of these has received a payment.' : 'Payments to it arrive in this wallet like any other.');

  // The note above the code: a payment on its way to the address showing,
  // or, for a request, how much of it has arrived.
  const arrivingNote =
    arrivingNau > 0n ? (hidden ? 'A payment to this address is pending.' : `${showNau(arrivingNau)} NPT to this address is pending.`) : null;
  const arrivedNote =
    requestNau === null || paidNau === 0n
      ? null
      : paidNau >= requestNau
        ? `Paid in full: ${hidden ? '••••' : showNau(paidNau)} NPT${arrivingNau > 0n ? ', pending' : ''}.`
        : `${hidden ? '••••' : showNau(paidNau)} of ${showNau(requestNau)} NPT arrived.`;

  return (
    <Paper>
      <Stack>
        <Title order={2} className="sr-only">
          Receive
        </Title>
        <div className="sr-only" role="status">
          {said}
        </div>
        {/* What the card is for comes first; the kind of address, which both
            tabs share and most people leave at Standard, comes under it, and
            then each tab's own content, as its panel. */}
        <Tabs value={tab} onChange={(v) => setTab((v as Tab) ?? 'address')} className="vault-tabs" keepMounted={false}>
          <Stack>
            <Tabs.List grow>
              <Tabs.Tab value="address">Address</Tabs.Tab>
              <Tabs.Tab value="request">Request payment</Tabs.Tab>
            </Tabs.List>
            <SegmentedControl
              aria-label="Address kind"
              aria-describedby="kind-note"
              fullWidth
              orientation={stacked ? 'vertical' : 'horizontal'}
              value={kind}
              onChange={(v) => setKind(v as KeyKind)}
              data={(Object.keys(KIND_LABELS) as KeyKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
            />
            <KindNote kind={kind} />

            <Tabs.Panel value="address">
              <Stack>
                {/* Who it is for, on this device only: History names what arrives
                    through it. Asked for a new address, the one made for one
                    payer; the main address is everyone's, so it has no field. */}
                {index > 0 && (
                  <TextInput
                    label="Who is this address for? (optional, only on this device)"
                    placeholder="For example: Alice, or the market stall"
                    value={forText}
                    maxLength={ADDRESS_LABEL_MAX}
                    onChange={(e) => {
                      setForText(e.currentTarget.value);
                      setForError(null);
                    }}
                    onBlur={() => void saveFor()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveFor();
                    }}
                    error={forError}
                    description="Payments to this address show this name in History. Kept on this device and in its backup files, never sent anywhere."
                  />
                )}
                {arrivingNote && (
                  <Done role={undefined}>
                    {arrivingNote}
                  </Done>
                )}
                {qr ? <QrCode src={qr} alt={`${KIND_LABELS[kind]} address QR code`} onOpen={() => setEnlarged('address')} /> : !addressError && <QrPending />}
                {/* The address shortened, for recognising it by its start and end.
                    Copy, Share and the code always carry it in full; a Standard
                    address runs to some 3,500 characters, which nobody reads. */}
                <div className="vault-receive-col vault-address-box">
                  <span className="vault-address-text">{address ? abbreviateAddress(address) : addressError ? 'No address' : 'Deriving the address…'}</span>
                </div>
                {addressError && (
                  <Text size="sm" c="var(--v-danger-text)">
                    Could not derive this address: {addressError}
                  </Text>
                )}
                <Group className="vault-receive-col vault-receive-actions">
                  <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={copy} disabled={!address} aria-describedby="kind-note">
                    Copy address
                  </Button>
                  {canShare && (
                    <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void shareAddress()} disabled={!address} aria-describedby="kind-note">
                      Share
                    </Button>
                  )}
                </Group>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="request">
              <Stack>
                <TextInput
                  label="Amount (NPT, optional)"
                  inputMode="decimal"
                  value={requestAmount}
                  onChange={(e) => setRequestAmount(e.currentTarget.value)}
                  error={amountError}
                  description={requestEstimate}
                  inputWrapperOrder={['label', 'input', 'description', 'error']}
                />
                <TextInput
                  label="Your name (optional)"
                  description="Shown to the sender as an unverified name."
                  value={requestLabel}
                  onChange={(e) => setRequestLabel(e.currentTarget.value)}
                  error={labelError}
                  maxLength={255}
                />
                <TextInput
                  label="Note for the sender (optional)"
                  description="Shown to the sender only; it does not reach you."
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.currentTarget.value)}
                  error={noteError}
                  maxLength={255}
                />
                {arrivedNote && (
                  <Done role={undefined}>
                    {arrivedNote}
                  </Done>
                )}
                {/* The code, then what to do with it: the same order as the Address tab. */}
                {requestQr && !requestInvalid && <QrCode src={requestQr} alt="Payment request QR code" onOpen={() => setEnlarged('request')} />}
                {requestQrNote && !requestInvalid && (
                  <Text size="sm" c="dimmed" className="vault-receive-col">
                    {requestQrNote}
                  </Text>
                )}
                <Group className="vault-receive-col vault-receive-actions">
                  <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(paymentLink, 'Payment request copied', copyFailed)} disabled={requestInvalid} aria-describedby="kind-note">
                    Copy request
                  </Button>
                  <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void share()} disabled={requestInvalid} aria-describedby="kind-note">
                    Share
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>
          </Stack>
        </Tabs>

        {/* The sentence about the address showing, then what can be done about it, on the line beneath. */}
        <Stack gap={4}>
          {rotationNote && (
            <Text size="sm" c="dimmed">
              {rotationNote}
            </Text>
          )}
          <Group gap={6} wrap="nowrap">
            {index > 0 && (
              <UnstyledButton ref={mainRef} onClick={toMain} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                Main address
              </UnstyledButton>
            )}
            {index > 0 && index < furthest && (
              <Text span size="sm" c="dimmed" aria-hidden>
                ·
              </Text>
            )}
            {index < furthest && (
              <UnstyledButton ref={newRef} onClick={nextUnused} c="var(--v-accent-text)" fz="sm" className={index > 0 ? 'vault-tap-link' : 'vault-tap-link vault-tap-link-start'}>
                New address
              </UnstyledButton>
            )}
          </Group>
        </Stack>

        {/* Every address with a name or a payment: who each was for, and how
            many payments came through it. Choosing one shows it above. */}
        {known.length > 0 && (
          <details className="vault-setting">
            <summary ref={summaryRef}>
              <IconChevronRight size={16} stroke={1.8} className="vault-setting-chevron" aria-hidden />
              Your addresses
            </summary>
            <div className="vault-setting-body">
              <Stack gap={2}>
                {known.map((a) => {
                  const count = payments.get(a.key) ?? 0;
                  const current = a.kind === kind && a.index === index;
                  const title = addressTitle(a.kind, a.index);
                  const named = Boolean(labels[a.key]);
                  // Only a new address is named; a main address named before can still lose its name.
                  const nameable = a.index > 0;
                  return (
                    <div key={a.key} className="vault-row vault-address-row">
                      <UnstyledButton className="vault-address-show" onClick={() => showAddress(a.kind, a.index)} aria-current={current || undefined}>
                        <Text size="sm" fw={600}>
                          {title}
                          {named && (
                            <>
                              {' · '}
                              <bdi>{labels[a.key]}</bdi>
                            </>
                          )}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {count === 0 ? 'No payments yet' : count === 1 ? '1 payment' : `${count} payments`}
                          {current ? ' · showing' : ''}
                        </Text>
                      </UnstyledButton>
                      {(nameable || named) && (
                        <Menu position="bottom-end">
                          <Menu.Target>
                            <ActionIcon
                              variant="subtle"
                              size="lg"
                              className="vault-tap"
                              aria-label={`More for ${title}`}
                              ref={(el: HTMLButtonElement | null) => {
                                if (el) moreButtons.current.set(a.key, el);
                                else moreButtons.current.delete(a.key);
                              }}
                            >
                              <IconDotsVertical size={20} stroke={1.8} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {nameable && (
                              <Menu.Item leftSection={<IconPencil size={16} stroke={1.8} />} onClick={() => setNaming({ kind: a.kind, index: a.index })}>
                                {named ? 'Rename' : 'Name it'}
                              </Menu.Item>
                            )}
                            {named && (
                              <Menu.Item leftSection={<IconTrash size={16} stroke={1.8} />} onClick={() => void removeName(a.kind, a.index)}>
                                Remove name
                              </Menu.Item>
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      )}
                    </div>
                  );
                })}
              </Stack>
            </div>
          </details>
        )}
        <Modal
          opened={naming !== null}
          onClose={() => {
            if (naming) refocus(addressKey(naming.kind, naming.index));
            setNaming(null);
          }}
          title={naming && labels[addressKey(naming.kind, naming.index)] ? 'Rename address' : 'Name address'}
          returnFocus={false}
        >
          {naming && (
            <AddressNameForm
              title={addressTitle(naming.kind, naming.index)}
              initial={labels[addressKey(naming.kind, naming.index)] ?? ''}
              onCancel={() => {
                refocus(addressKey(naming.kind, naming.index));
                setNaming(null);
              }}
              onSave={async (text) => {
                await nameAddress(naming.kind, naming.index, text);
                setSaid(`${addressTitle(naming.kind, naming.index)} is now named ${cleanLabel(text)}.`);
                refocus(addressKey(naming.kind, naming.index));
                setNaming(null);
              }}
            />
          )}
        </Modal>
        <QrFullScreen
          opened={enlarged !== null && Boolean(enlarged === 'request' ? requestQr : qr)}
          onClose={() => setEnlarged(null)}
          src={enlarged === 'request' ? requestQr : qr}
          // The name people choose by as the title, and the protocol's own on a
          // quieter line beneath, for checking against another wallet or the node.
          title={enlarged === 'request' ? 'Payment request' : `${KIND_LABELS[kind]} address`}
          subtitle={enlarged === 'request' ? `${KIND_LABELS[kind]} address · ${KIND_PROTOCOL[kind]}` : KIND_PROTOCOL[kind]}
          // The title says what kind of address it is; under the code goes the
          // address itself, and for a request the amount asked for above it.
          caption={`${enlarged === 'request' && linkAmount ? `${groupDigits(linkAmount)} NPT
` : ''}${address ? abbreviateAddress(address) : ''}`}
        />
      </Stack>
    </Paper>
  );
}

/** Who one address was given to, from "Your addresses". Removing a name is the row menu's other item. */
function AddressNameForm({ title, initial, onSave, onCancel }: { title: string; initial: string; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text).catch((err: Error) => setError(err.message));
      }}
    >
      <Stack>
        <TextInput
          label={`Who is ${title} for?`}
          description="Payments to this address show this name in History. Kept on this device and in its backup files, never sent anywhere."
          value={text}
          maxLength={ADDRESS_LABEL_MAX}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setError(null);
          }}
          error={error}
          errorProps={{ role: 'alert' }}
          data-autofocus
        />
        <Group grow>
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!cleanLabel(text)}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
