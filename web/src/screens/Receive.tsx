// Receiving: the address of each kind as text and QR code, and a
// payment request (NIP-002 link with amount, name and note) with its own
// code. Two tabs, because the address code and the request code must never
// be mistaken for one another. Key 0 of a kind is its main address; "next
// unused" derives the next key of that kind.

import { ActionIcon, Button, Combobox, Group, Loader, Menu, Modal, Paper, Stack, Tabs, Text, TextInput, Title, UnstyledButton, useCombobox } from '@mantine/core';
import { IconArrowsMaximize, IconCheck, IconChevronDown, IconCopy, IconDotsVertical, IconPencil, IconPlus, IconShare, IconTrash } from '@tabler/icons-react';
import { useElementSize } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';

import { QrFullScreen } from '../components/QrFullScreen';
import { Caution, Done, Info } from '../components/Notice';

import { formatNau, showNau, useApp } from '../app/AppContext';
import { ADDRESS_LABEL_MAX, addressKey, cleanLabel, coinAddressKey, markGiven, readGiven, readLabels, writeLabel, type AddressLabels } from '../app/addressLabels';
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
// said at the end of its note and on the full-screen code, not in its label.
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

// What each kind is for, said the same way for each so they can be
// compared: who it is for first, then its one trade-off, then the
// protocol's name for it. All three are shown in the list where the kind is
// chosen. View-only's risk shows again as a caution whenever that kind is
// chosen, right before Copy and Share, so it is read before sharing: a
// payer needs the address to pay it, so every payer can watch too. The
// reuse guidance is the desktop wallet's addresses page's: every payment
// carries its address's receiver identifier in the clear, so payments to
// one address can be linked (neptune-wallet's own note on
// into_announcement), though never their amounts.
const KIND_NOTES: Record<KeyKind, string> = {
  generation: `The one to use by default, but long: about ${showInt(3500)} characters. Reusing it is safe, but payments to the same address can be linked on the chain (not their amounts), so give each payer a new address when that matters. Technical name: ${KIND_PROTOCOL.generation} address.`,
  ec_hybrid: `Short enough to paste into a chat. Give each one to a single sender: if one is reused widely, a future quantum computer could reveal the payments sent to it, though never spend them. Technical name: ${KIND_PROTOCOL.ec_hybrid} address.`,
  viewing: `Anyone who has it, payers included, can see every payment made to it (only to it) but never spend them. Suits a fundraiser that shows its donations. Technical name: ${KIND_PROTOCOL.viewing} address.`,
};
/** Right before sharing a View-only address: its one risk, in a line. */
const VIEWING_CAUTION = 'Anyone who has this address, payers included, can see every payment made to it.';

/** "Standard main address", "Short address 3". */
function addressTitle(kind: KeyKind, index: number): string {
  return `${KIND_LABELS[kind]} ${index === 0 ? 'main address' : `address ${index}`}`;
}

// A code on the card, like a printed one: the white runs on below it into a
// slim footer that says it opens full screen. The hint sits under the code,
// never on it: a Standard address makes a code so dense that covering any
// of it can stop a camera reading it.
function QrCode({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  return (
    <UnstyledButton onClick={onOpen} aria-label="Show the QR code full screen" className="vault-qr-code">
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
 * The code's place while it is being drawn, or while a request's amount is
 * still being typed: the same white square and footer, so the buttons
 * beneath stay where they are instead of jumping up and back under the
 * finger. It turns only while something is being drawn.
 */
function QrPending({ waiting = true }: { waiting?: boolean }) {
  return (
    <div className="vault-qr-code" style={{ cursor: 'default' }} aria-hidden>
      <div style={{ aspectRatio: '1', display: 'grid', placeItems: 'center' }}>
        {waiting && <Loader size="sm" color="gray" />}
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
  const [tab, setTab] = useState<Tab>('address');
  const [kind, setKind] = useState<KeyKind>('generation');
  const [indices, setIndices] = useState<Record<KeyKind, number>>({ generation: 0, ec_hybrid: 0, viewing: 0 });
  const [address, setAddress] = useState('');
  const [qr, setQr] = useState<string>('');
  const [addressError, setAddressError] = useState<string | null>(null);
  // Which code, if any, is shown as large as the screen allows.
  const [enlarged, setEnlarged] = useState<'address' | 'request' | null>(null);
  const index = indices[kind];
  // The address type's menu is as wide as the card, up to a comfortable measure.
  const { ref: typeCol, width: typeColWidth } = useElementSize();

  // Who each address was given to: a name kept on this device, which History
  // then shows for what arrives through it. The one way to know who paid.
  const [labels, setLabels] = useState<AddressLabels>({});
  useEffect(() => {
    if (!account) return;
    void readLabels(services.core, services.accounts.engine, account.id).then(setLabels, () => setLabels({}));
  }, [services, account]);
  // Which addresses were given out (copied, shared, shown full screen, as
  // an address or in a request), kept with the names: each stays in the
  // list, and New address never offers one of them again.
  const [given, setGiven] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!account) return;
    void readGiven(services.core, services.accounts.engine, account.id).then(setGiven, () => setGiven(new Set()));
  }, [services, account]);
  const giveOut = (k: KeyKind, i: number) => {
    if (!account || given.has(addressKey(k, i))) return;
    setGiven((all) => new Set([...all, addressKey(k, i)]));
    void markGiven(services.core, services.accounts.engine, account.id, k, i).then(setGiven, () => undefined);
  };
  const key = addressKey(kind, index);
  // Names are given, changed and removed in the address list: "Name it" on a
  // row without one, its menu on a row with one, both opening one dialog.
  // After it closes, focus goes back to that row's menu or "Name it", or to
  // New address when the row has gone, and what happened is said.
  const [naming, setNaming] = useState<{ kind: KeyKind; index: number } | null>(null);
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const nameButtons = useRef(new Map<string, HTMLButtonElement>());
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const newRef = useRef<HTMLButtonElement>(null);
  const refocus = (k: string) => {
    setTimeout(() => (moreButtons.current.get(k) ?? nameButtons.current.get(k) ?? newRef.current)?.focus(), 0);
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
  const visit = history.filter((h) => h.kind === 'received' && h.status !== 'failed' && toThis(h) && !atOpen.current?.keys.has(h.key) && !atOpen.current?.pending.has(commitmentOf(h) ?? ''));
  const sumOf = (rows: typeof history) => rows.reduce((sum, h) => sum + BigInt(h.amountNau), 0n);
  // Of what came during this visit: still on its way, and confirmed.
  const visitPendingNau = sumOf(visit.filter((h) => h.status === 'pending'));
  const visitConfirmedNau = sumOf(visit.filter((h) => h.status === 'confirmed'));

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
  // Why the amount typed cannot be asked for, worked out as it is typed; said
  // only once the field is left, as on Send, so "0" on the way to "0.5"
  // is never red. Meanwhile Copy and Share wait, and the code keeps its place.
  const [amountError, setAmountError] = useState<string | null>(null);
  const [amountLeft, setAmountLeft] = useState(false);
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
      setRequestNau(null);
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
          setRequestNau(null);
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
  // Whatever hands the address on gives it out, on either tab.
  const copy = () => {
    giveOut(kind, index);
    void copyText(address, 'Address copied', copyFailed);
  };
  const shareAddress = async () => {
    giveOut(kind, index);
    try {
      await navigator.share({ text: address });
    } catch {
      // Cancelled by the user; nothing to report.
    }
  };
  const copyRequest = () => {
    giveOut(kind, index);
    void copyText(paymentLink, 'Payment request copied', copyFailed);
  };
  // Shown only where the system share sheet exists, as on the Address tab:
  // elsewhere it would only copy, which Copy already does.
  const shareRequest = async () => {
    giveOut(kind, index);
    try {
      await navigator.share({ text: paymentLink });
    } catch {
      // Cancelled by the user; nothing to report.
    }
  };
  // The box shows the address shortened, which is no address at all: text
  // copied from it (a long press, a triple click) is the whole address.
  const copyWhole = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!address) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', address);
    giveOut(kind, index);
    notifications.show({ message: 'Address copied', color: 'green', autoClose: 4000 });
  };

  // The sync looks for payments on every address up to a few past the
  // newest one that has received something. An address further out would
  // never be looked at, and a payment to it never found, so none is offered.
  const used = account ? nextKeyIndicesOf(account)[kind] : 0;
  const furthest = used + KEY_LOOKAHEAD;
  // How many payments came through each address, for its row in the list.
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
  // The list, for the type showing: its main address first, then each with
  // a name, a payment or given out, and the one showing even with none of
  // those (a new one).
  const listed = [
    ...new Set([
      0,
      index,
      ...[...Object.keys(labels), ...given, ...payments.keys()].filter((k) => k.startsWith(`${kind}:`)).map((k) => Number(k.slice(kind.length + 1))),
    ]),
  ]
    .filter((i) => Number.isSafeInteger(i) && i >= 0)
    .sort((a, b) => a - b);
  // Each new address is the first past every one in the list (named, paid
  // or given out) and past the one showing: never one someone may already
  // have. It is added to the list where it is asked for, so nothing above
  // it moves. Once the next one would be past the last offered, New address
  // rests with its line, and focus goes to the row just added.
  const ofKind = (k: string) => (k.startsWith(`${kind}:`) ? Number(k.slice(kind.length + 1)) : -1);
  const takenUpTo = Math.max(0, index, ...[...Object.keys(labels), ...given, ...payments.keys()].map(ofKind).filter(Number.isSafeInteger));
  const nextNew = Math.max(used, takenUpTo + 1);
  const canNew = nextNew <= furthest;
  const nextUnused = () => {
    if (!canNew) return;
    setIndices({ ...indices, [kind]: nextNew });
    setSaid(`${KIND_LABELS[kind]} address ${nextNew} is showing. Payments to it arrive in this wallet like any other.`);
    if (nextNew + 1 > furthest) setTimeout(() => rowButtons.current.get(addressKey(kind, nextNew))?.focus(), 0);
  };
  // Choosing a row shows that address on the tab in use: on a request, the
  // request moves to it. The row stays under the finger; the code above changes.
  const showIndex = (i: number) => {
    setIndices((all) => ({ ...all, [kind]: i }));
    const which = `${KIND_LABELS[kind]} ${i === 0 ? 'main address' : `address ${i}`}`;
    setSaid(tab === 'request' ? `The request is now to ${which}.` : `${which} is showing.`);
  };
  // Another type shows its own addresses, from the one of it shown last.
  const chooseKind = (k: KeyKind) => {
    setKind(k);
    setSaid(`${KIND_LABELS[k]} ${indices[k] === 0 ? 'main address' : `address ${indices[k]}`} is showing.`);
  };
  // The type is a value chosen from a list, so it is a select (a button and
  // a list box), not a menu of commands: "Standard, selected". Opened from
  // the keyboard, the arrows start at the type showing.
  const typeBox = useCombobox({
    onDropdownClose: () => typeBox.resetSelectedOption(),
    onDropdownOpen: (source) => {
      if (source === 'keyboard') typeBox.selectActiveOption();
    },
  });
  useEffect(() => {
    if (index > furthest) setIndices((all) => ({ ...all, [kind]: furthest }));
  }, [index, furthest, kind]);

  const requestInvalid = Boolean(amountError || noteError || labelError);
  // Copy and Share point to View-only's caution while it shows.
  const cautionId = kind === 'viewing' ? 'kind-note' : undefined;
  // The note above the code: what came to the address showing. A payment on
  // its way reads as information, never as done: it is final only once a
  // block confirms it. Only a confirmed payment, or a request confirmed in
  // full, takes the check.
  const show = (nau: bigint) => (hidden ? '••••' : showNau(nau));
  const addressArrival: { done: boolean; text: string } | null =
    arrivingNau > 0n
      ? { done: false, text: hidden ? 'A payment to this address is pending until a block confirms it.' : `${showNau(arrivingNau)} NPT to this address is pending until a block confirms it.` }
      : visitConfirmedNau > 0n
        ? { done: true, text: hidden ? 'A payment to this address arrived.' : `${showNau(visitConfirmedNau)} NPT received.` }
        : null;
  // For a request, how much of it came during this visit, against the amount asked.
  const visitNau = visitPendingNau + visitConfirmedNau;
  const requestArrival: { done: boolean; text: string } | null =
    requestNau === null
      ? addressArrival
      : visitNau === 0n
        ? null
        : visitPendingNau > 0n
          ? {
              done: false,
              text:
                visitConfirmedNau > 0n
                  ? `${show(visitNau)}${visitNau < requestNau ? ` of ${showNau(requestNau)}` : ''} NPT arrived; ${show(visitPendingNau)} NPT of it is pending until a block confirms it.`
                  : `${show(visitNau)}${visitNau < requestNau ? ` of ${showNau(requestNau)}` : ''} NPT is pending until a block confirms it.`,
            }
          : visitNau >= requestNau
            ? { done: true, text: `Paid in full: ${show(visitNau)} NPT.` }
            : { done: false, text: `${show(visitNau)} of ${showNau(requestNau)} NPT received.` };
  const noteOf = (note: { done: boolean; text: string } | null) =>
    note === null ? null : note.done ? <Done role={undefined}>{note.text}</Done> : <Info>{note.text}</Info>;

  return (
    <Paper>
      <Stack>
        <Title order={2} className="sr-only">
          Receive
        </Title>
        <div className="sr-only" role="status">
          {said}
        </div>
        {/* What the card is for comes first, then the code and what to do with
            it: on the first screen for an address, after its fields for a
            request. Which address it is, shared by both tabs and most often
            Standard's main one, is a list under the buttons. */}
        <Tabs value={tab} onChange={(v) => setTab((v as Tab) ?? 'address')} className="vault-tabs" keepMounted={false}>
          <Stack>
            <Tabs.List grow>
              <Tabs.Tab value="address">Address</Tabs.Tab>
              {/* What is shared, as the Address tab says it: the app's one word for it. */}
              <Tabs.Tab value="request">Payment request</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="address">
              <Stack>
                {noteOf(addressArrival)}
                {qr ? <QrCode src={qr} alt={`${KIND_LABELS[kind]} address QR code`} onOpen={() => { giveOut(kind, index); setEnlarged('address'); }} /> : !addressError && <QrPending />}
                {/* The address shortened, for recognising it by its start and end.
                    Copy, Share and the code always carry it in full, and so does
                    text copied from here; a Standard address runs to some 3,500
                    characters, which nobody reads. */}
                <div className="vault-address-box" onCopy={copyWhole}>
                  <span className="vault-address-text">{address ? abbreviateAddress(address) : addressError ? 'No address' : 'Deriving the address…'}</span>
                </div>
                {addressError && (
                  <Text size="sm" c="var(--v-danger-text)">
                    Could not derive this address: {addressError}
                  </Text>
                )}
                {/* Its exposure cannot be taken back: read right before sharing. */}
                {kind === 'viewing' && <Caution id="kind-note">{VIEWING_CAUTION}</Caution>}
                <Group className="vault-receive-actions">
                  {/* One word, as Share is: the code above says what it copies, and
                      so does the note it leaves. A screen reader hears it whole. */}
                  <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={copy} disabled={!address} aria-label="Copy address" aria-describedby={cautionId}>
                    Copy
                  </Button>
                  {canShare && (
                    <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void shareAddress()} disabled={!address} aria-describedby={cautionId}>
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
                  onChange={(e) => {
                    setRequestAmount(e.currentTarget.value);
                    setAmountLeft(false);
                  }}
                  onBlur={() => setAmountLeft(true)}
                  error={amountLeft ? amountError : null}
                  description={requestEstimate}
                  inputWrapperOrder={['label', 'input', 'description', 'error']}
                />
                {/* All three shown from the start: a request is written before it is
                    shared, so they read as what a request can hold, not a hidden extra. */}
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
                {noteOf(requestArrival)}
                {/* The code, then what to do with it: the same order as the Address
                    tab. While the amount is unfinished the code keeps its place. */}
                {requestInvalid ? <QrPending waiting={false} /> : requestQr ? <QrCode src={requestQr} alt="Payment request QR code" onOpen={() => { giveOut(kind, index); setEnlarged('request'); }} /> : <QrPending />}
                {requestQrNote && !requestInvalid && (
                  <Text size="sm" c="dimmed">
                    {requestQrNote}
                  </Text>
                )}
                {kind === 'viewing' && <Caution id="kind-note">{VIEWING_CAUTION}</Caution>}
                <Group className="vault-receive-actions">
                  <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={copyRequest} disabled={requestInvalid} aria-label="Copy request" aria-describedby={cautionId}>
                    Copy
                  </Button>
                  {canShare && (
                    <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void shareRequest()} disabled={requestInvalid} aria-describedby={cautionId}>
                      Share
                    </Button>
                  )}
                </Group>
              </Stack>
            </Tabs.Panel>

            {/* Which address shows, for both tabs: its type as the heading, then
                the addresses of that type (the main one first, then each with
                a name or a payment), then a new one. */}
            <Stack gap={6}>
              <div ref={typeCol}>
                <Combobox
                  store={typeBox}
                  onOptionSubmit={(value) => {
                    chooseKind(value as KeyKind);
                    typeBox.closeDropdown();
                  }}
                  position="bottom-start"
                  // As wide as the card, up to a comfortable measure, and lined
                  // up with its edge (the button's padding reaches 8 px outside it).
                  width={typeColWidth ? Math.min(typeColWidth, 440) : undefined}
                  offset={{ mainAxis: 8, crossAxis: 8 }}
                >
                  <Combobox.Target targetType="button" withExpandedAttribute>
                    {/* The list goes when focus moves on (Tab), as a native select's does. */}
                    <button type="button" className="vault-picker" aria-label={`Address type, ${KIND_LABELS[kind]} addresses`} onClick={() => typeBox.toggleDropdown()} onBlur={() => typeBox.closeDropdown()}>
                      {KIND_LABELS[kind]} addresses
                      <IconChevronDown size={16} stroke={1.8} aria-hidden />
                    </button>
                  </Combobox.Target>
                  <Combobox.Dropdown>
                    <div className="vault-picker-label" aria-hidden>
                      Address type
                    </div>
                    <Combobox.Options aria-label="Address type">
                      {(Object.keys(KIND_LABELS) as KeyKind[]).map((k) => (
                        <Combobox.Option key={k} value={k} active={k === kind} aria-selected={k === kind} className="vault-type-option">
                          <span className="vault-type-check" aria-hidden>
                            {k === kind && <IconCheck size={16} stroke={1.8} />}
                          </span>
                          <span>
                            <Text span display="block" size="sm" fw={600}>
                              {KIND_LABELS[k]}
                            </Text>
                            <Text span display="block" size="xs" c="dimmed">
                              {KIND_NOTES[k]}
                            </Text>
                          </span>
                        </Combobox.Option>
                      ))}
                    </Combobox.Options>
                  </Combobox.Dropdown>
                </Combobox>
              </div>
              <div role="group" aria-label={`${KIND_LABELS[kind]} addresses`}>
                {listed.map((i) => {
                  const k = addressKey(kind, i);
                  const current = i === index;
                  const count = payments.get(k) ?? 0;
                  const name = labels[k];
                  const title = addressTitle(kind, i);
                  // Only a new address is named; a main address named before can still lose its name.
                  const nameable = i > 0;
                  // Who it is for leads when it has a name; its number and payments go beneath.
                  const number = i === 0 ? 'Main address' : `Address ${i}`;
                  const details = [name ? number : null, count === 0 ? null : count === 1 ? '1 payment' : `${count} payments`].filter(Boolean).join(' · ');
                  return (
                    <div key={k} className="vault-row vault-address-row">
                      <UnstyledButton
                        className="vault-address-show"
                        onClick={() => showIndex(i)}
                        aria-current={current || undefined}
                        ref={(el: HTMLButtonElement | null) => {
                          if (el) rowButtons.current.set(k, el);
                          else rowButtons.current.delete(k);
                        }}
                      >
                        <span className="vault-address-mark" aria-hidden>
                          {current && <IconCheck size={16} stroke={1.8} />}
                        </span>
                        <span className="vault-address-title">
                          <Text span display="block" size="sm" fw={current ? 600 : 400}>
                            {name ? <bdi>{name}</bdi> : number}
                          </Text>
                          {details && (
                            <Text span display="block" size="xs" c="dimmed">
                              {details}
                            </Text>
                          )}
                        </span>
                      </UnstyledButton>
                      <div className="vault-address-action">
                        {nameable && !name && (
                          <UnstyledButton
                            onClick={() => setNaming({ kind, index: i })}
                            aria-label={`Name it, ${title}`}
                            c="var(--v-accent-text)"
                            fz="sm"
                            className="vault-tap-link"
                            ref={(el: HTMLButtonElement | null) => {
                              if (el) nameButtons.current.set(k, el);
                              else nameButtons.current.delete(k);
                            }}
                          >
                            Name it
                          </UnstyledButton>
                        )}
                        {name && (
                          <Menu position="bottom-end">
                            <Menu.Target>
                              <ActionIcon
                                variant="subtle"
                                size="lg"
                                className="vault-tap"
                                aria-label={`More for ${title}`}
                                ref={(el: HTMLButtonElement | null) => {
                                  if (el) moreButtons.current.set(k, el);
                                  else moreButtons.current.delete(k);
                                }}
                              >
                                <IconDotsVertical size={20} stroke={1.8} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {nameable && (
                                <Menu.Item leftSection={<IconPencil size={16} stroke={1.8} />} onClick={() => setNaming({ kind, index: i })}>
                                  Rename
                                </Menu.Item>
                              )}
                              {/* Red, as Remove is in every other menu. */}
                              <Menu.Item leftSection={<IconTrash size={16} stroke={1.8} />} c="var(--v-danger-text)" onClick={() => void removeName(kind, i)}>
                                Remove name
                              </Menu.Item>
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="vault-row vault-address-row">
                  <UnstyledButton ref={newRef} className="vault-address-show vault-address-new" onClick={nextUnused} disabled={!canNew}>
                    <span className="vault-address-mark" aria-hidden>
                      <IconPlus size={16} stroke={1.8} />
                    </span>
                    <span className="vault-address-title">
                      <Text span display="block" size="sm" fw={600}>
                        New address
                      </Text>
                      {/* Why a new one, on the row that makes it; at the limit, why
                          there is none. View-only is for watching, not for payers. */}
                      {!canNew ? (
                        <Text span display="block" size="xs" c="dimmed">
                          More addresses open up once one of these has received a payment.
                        </Text>
                      ) : (
                        kind !== 'viewing' && (
                          <Text span display="block" size="xs" c="dimmed">
                            Give each payer their own; payments to one address can be linked.
                          </Text>
                        )
                      )}
                    </span>
                  </UnstyledButton>
                </div>
              </div>
            </Stack>
          </Stack>
        </Tabs>

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

/** Who one address was given to, from the address list. Removing a name is the row menu's other item. */
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
