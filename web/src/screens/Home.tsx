// Balance, sync status and history.

import { ActionIcon, Button, Group, Paper, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconArrowsExchange, IconChevronRight, IconClockPause, IconCopy, IconExternalLink, IconEye, IconEyeOff, IconHourglass, IconInfoCircle, IconRefresh, IconWifiOff } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Sheet } from '../components/Sheet';
import { NAU_PER_COIN, showBlock, showNau, UNANSWERED_TITLE, useApp } from '../app/AppContext';
import { coinAddressKey, addressKey, readLabels, type AddressLabels } from '../app/addressLabels';
import { MEMPOOL_KEEPS_MS, SEND_LIFETIME_MS, SEND_NOTE_MAX } from '../app/send';
import { readReceivedNotes, receivedCoinOf, writeReceivedNote, type ReceivedNotes } from '../app/receivedNotes';
import { usePendingSends } from '../app/pending';
import { readSendDetails, withSendDetails } from '../app/sendDetails';
import { speakNau } from '../components/Amount';
import { QUOTE_OLD_MS, useQuote } from '../app/price';
import { fiatOf, fiatParts } from '../util/fiat';
import type { StoredUtxo } from '../backend/types';
import type { AccountRecord, ContactRecord, HistoryRecord, SendDetails } from '../storage/db';
import { InstallNudge } from '../components/InstallNudge';
import { Caution, ErrorLine, Info } from '../components/Notice';
import { COINS_SAFE, MAY_HAVE_GONE_OUT, notSentReason, SENDING_UNTIL_CONFIRMED, SENT_WAITING, WAITING_FOR_BLOCK } from '../app/words';
import { DESKTOP, NATIVE } from '../app/platform';
import { LINKS } from '../app/links';
import { abbreviateAddress } from '../util/address';
import { copyText } from '../util/clipboard';
import { coinKeyOfReceipt, groupHistory, type HistoryEntry } from '../util/history';
import { dayAhead, dayKey, dayLabel, formatDate, formatDateTime, formatTime, timeAgo, whenInSentence } from '../util/time';

export function Home() {
  const { balance, sync, history, utxos, syncNow, lastSyncedAt, online, services, refresh, account, dismissSendJob, loaded, sendFailure: failure, dismissSendFailure, lastSend, dismissLastSend, screenAwake } = useApp();
  // A send that failed while the person was elsewhere is easy to miss as a
  // toast; it stays here until dismissed, and survives a reload.
  const dismissFailure = () => {
    dismissSendFailure();
    dismissSendJob();
    // The banner and its close button are gone: the screen's heading takes the focus.
    const heading = document.querySelector<HTMLElement>('main h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };
  // Masked amounts for reading the app in public; remembered across visits.
  const [hidden, setHidden] = useState<boolean>(services.settings.hideBalance ?? false);
  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    void services.updateSettings({ hideBalance: next });
  };
  const amount = (nau: bigint) => (hidden ? '••••' : showNau(nau));
  // The same, as a screen reader should say it: plain digits, or "hidden".
  const spoken = (nau: bigint) => speakNau(nau, hidden);
  // The balance in another currency, when the person asked for one.
  const quote = useQuote(services.settings.fiatCurrency);
  // Re-render every 30 s so "2 min ago" stays right.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const navigate = useNavigate();

  // A seed phrase written down and confirmed is the backup that matters,
  // and every way of setting a wallet up confirms it, so Home does not ask
  // for a file on top (Settings, Backup still offers one, for contacts). A
  // wallet whose phrase was never confirmed (an early version, or a setup
  // cut short) is warned until a file exists; a dismissal snoozes it for a week.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const showBackupNudge =
    Boolean(account) &&
    account?.backupConfirmed !== true &&
    !account?.lastBackupAt &&
    !(account?.backupNudgeDismissedAt && Date.now() - account.backupNudgeDismissedAt < WEEK_MS);
  const dismissNudge = async () => {
    if (!account) return;
    await services.accounts.dismissBackupNudge(account.id);
    await refresh();
  };

  // The wallet's history on this device would not open: why, or null.
  const unreadable = account ? services.accounts.engine.unopenedWhy(account.id) : null;

  // What the pending sends do to the balance, as every screen counts it: gone,
  // with their change on hold until they confirm (app/pending.ts).
  const { sends: pendingSends, ready: ownReady, isOwn, toSelf, balanceNau: headlineNau, onHoldNau } = usePendingSends();
  const fiat = quote ? fiatParts(fiatOf(headlineNau, NAU_PER_COIN, quote.price), quote.currency) : null;

  // What a backup file kept of the sends a restore finds only as coins that went.
  const [sendDetails, setSendDetails] = useState<SendDetails[]>([]);
  useEffect(() => {
    if (!account) return;
    void readSendDetails(services.core, services.accounts.engine, account.id).then(setSendDetails, () => setSendDetails([]));
  }, [services, account]);
  // The person's notes on payments received, by the coin each brought.
  const [receivedNotes, setReceivedNotes] = useState<ReceivedNotes>({});
  useEffect(() => {
    if (!account) return;
    void readReceivedNotes(services.core, services.accounts.engine, account.id).then(setReceivedNotes, () => setReceivedNotes({}));
  }, [services, account]);
  // One entry per transaction, with the recipient named when it is a contact.
  const entries = groupHistory(withSendDetails(history, sendDetails), utxos).map((e) =>
    e.kind === 'sent' && e.record.status === 'pending' && toSelf(e.record) ? { ...e, kind: 'self' as const, shownNau: BigInt(e.record.feeNau ?? '0') } : e,
  );
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  useEffect(() => {
    if (!account) return;
    void services.contacts.list(account.id).then(setContacts);
  }, [services, account, history.length]);
  const contactFor = (address: string | null) => (address ? contacts.find((c) => c.address === address) : undefined);
  // Who each receiving address was given to (set on Receive), for naming
  // what came in through it.
  const [labels, setLabels] = useState<AddressLabels>({});
  useEffect(() => {
    if (!account) return;
    void readLabels(services.core, services.accounts.engine, account.id).then(setLabels, () => setLabels({}));
  }, [services, account, history.length]);
  const labelOf = (h: HistoryRecord): string | null => {
    if (h.kind !== 'received') return null;
    const key = h.keyKind !== undefined && h.keyIndex !== undefined ? addressKey(h.keyKind, h.keyIndex) : coinAddressKey(utxos.find((u) => u.hash === coinKeyOfReceipt(h))?.stored);
    return key ? (labels[key] ?? null) : null;
  };
  // The newest block the wallet knows of, for counting confirmations.
  const tipHeight = Math.max(sync?.tipHeight ?? 0, sync?.syncedHeight ?? 0);
  const blocksSince = (h: HistoryRecord): number | null => (h.status === 'confirmed' && h.height !== null && tipHeight >= h.height ? tipHeight - h.height : null);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [why, setWhy] = useState(false);
  // The sheet's technical rows are folded until asked for, and fold again for the next entry.
  const [tech, setTech] = useState(false);
  useEffect(() => setTech(false), [detail]);
  const PAGE = 50;
  const [shown, setShown] = useState(PAGE);
  // The shown entries by calendar day, in the order they come (newest first):
  // a heading says the day once, and each row keeps only its time.
  const days: { key: string; label: string; entries: HistoryEntry[] }[] = [];
  for (const e of entries.slice(0, shown)) {
    const key = dayKey(e.record.timestampMs);
    const day = days.find((d) => d.key === key);
    if (day) day.entries.push(e);
    else days.push({ key, label: dayLabel(e.record.timestampMs), entries: [e] });
  }

  // Giving up on a pending send frees its reserved coins; confirmed first.
  const [givingUp, setGivingUp] = useState<HistoryRecord | null>(null);
  const [giveUpBusy, setGiveUpBusy] = useState(false);
  // A give-up that failed is said in its dialog, which stays open for another try.
  const [giveUpError, setGiveUpError] = useState<string | null>(null);
  const closeGiveUp = () => {
    if (givingUp) focusRow(givingUp.key);
    setGivingUp(null);
    setGiveUpError(null);
  };
  const giveUp = async () => {
    if (!account || !givingUp) return;
    const key = givingUp.key;
    setGiveUpBusy(true);
    setGiveUpError(null);
    try {
      await services.sendService(account.id).forget(givingUp.txid);
    } catch (e) {
      setGiveUpError((e as Error).message);
      return;
    } finally {
      setGiveUpBusy(false);
    }
    setGivingUp(null);
    await refresh();
    focusRow(key);
  };
  // Exactly what giving up frees: the inputs reserved for that transaction.
  const reservedFor = (h: HistoryRecord) => utxos.filter((u) => u.pendingTxid === h.txid).reduce((sum, u) => sum + BigInt(u.amountNau), 0n);

  // The headline counts a pending send as gone and its change as on hold: a
  // small send never turns the balance into 0 because its coin waits for a
  // block. What can be spent meanwhile, and what is on hold, is the line
  // beneath, and the two add up to the headline. Behind the info button, in
  // the same two words: what the headline left out, and what on hold is.
  const pendingExplained = () => {
    const one = pendingSends.length === 1 ? pendingSends[0] : null;
    const it = one !== null;
    const left = one && toSelf(one) ? 'Your balance already counts the pending move to yourself, less its fee.' : `Your balance already leaves out ${it ? 'the pending send' : `the ${pendingSends.length} pending sends`}.`;
    return onHoldNau > 0n ? `${left} The ${amount(onHoldNau)} NPT on hold is the change that comes back when ${it ? 'it confirms' : 'they confirm'}.` : left;
  };

  // Whether the node still holds a pending send: it was seen there at the
  // last check, it was seen before but not at the last check, or never.
  const nodeHolds = (h: HistoryRecord): 'has' | 'had' | 'never' | null => {
    if (!h.mempoolCheckedAt) return null;
    if (h.mempoolSeenAt && h.mempoolSeenAt >= h.mempoolCheckedAt) return 'has';
    return h.mempoolSeenAt ? 'had' : 'never';
  };
  /** When no block can take a pending send any more, and the wallet frees its coins. */
  const expiresAt = (h: HistoryRecord) => (h.stampMs ?? h.timestampMs) + SEND_LIFETIME_MS;
  // A send of this device that nodes have stopped keeping (they drop one
  // ten hours after it was made) and no block has taken: it is not going
  // through, and its coins wait for nothing until it expires. The one state
  // of a send that asks for something, so the one in the caution colour.
  const isStuck = (h: HistoryRecord) =>
    h.kind === 'sent' && h.status === 'pending' && h.key.includes(':sent:') && Date.now() - (h.stampMs ?? h.timestampMs) > MEMPOOL_KEEPS_MS && nodeHolds(h) !== 'has';
  const stuck = pendingSends.find(isStuck);

  // A receipt's time lock, from the row or, for rows written before it was
  // kept there, from the coin. Null once the date has passed.
  const lockOf = (h: HistoryRecord): number | null => {
    if (h.kind !== 'received') return null;
    const date = h.releaseDateMs ?? utxos.find((u) => u.hash === coinKeyOfReceipt(h))?.releaseDateMs ?? null;
    return date !== null && date > Date.now() ? date : null;
  };
  const showDate = formatDate;

  const busy = sync?.phase === 'checking' || sync?.phase === 'restoring' || sync?.phase === 'scanning';
  // A wallet no sync has brought up to the chain's newest block since it was
  // made, restored or rescanned: its balance and History are not the whole
  // story yet, and say so.
  const unsynced = account?.synced === false && sync?.phase !== 'done';
  // Why History is empty then; what went wrong in detail is on the status line above it.
  const unsyncedReason = !online ? 'Not synced yet: you are offline.' : 'Not synced yet, so payments may be missing here.';
  const longScan = (sync?.phase === 'scanning' && sync.tipHeight - sync.syncedHeight > 100) || sync?.phase === 'restoring';
  // A node can be up to date with itself and still behind the network: its
  // newest block is then hours old, although blocks come about every ten
  // minutes. Recent payments would not show, and sends may not go through.
  const behindMs = sync?.phase === 'done' && sync.tipTimestampMs ? Date.now() - sync.tipTimestampMs : 0;
  const behind = behindMs > 60 * 60 * 1000;
  const syncText =
    sync === null
      ? 'Not synced yet'
      : sync.phase === 'checking'
        ? 'Checking the chain'
        : sync.phase === 'restoring'
          ? (sync.message ?? 'Finding your payments')
          : sync.phase === 'scanning'
          ? `Scanning block ${showBlock(sync.syncedHeight)} of ${showBlock(sync.tipHeight)}`
          : sync.phase === 'done'
            ? behind
              ? `Synced to block ${showBlock(sync.tipHeight)}, but that block is ${Math.round(behindMs / 3_600_000)} h old, so the node may be behind`
              : `Up to date · block ${showBlock(sync.syncedHeight)}${lastSyncedAt ? ` · ${timeAgo(lastSyncedAt)}` : ''}`
            : sync.message ?? 'Sync failed';
  // What the status line says is announced after the person asked for a
  // sync, and a payment arriving is announced as it arrives: once each, in
  // a region that is always there, never on every render.
  const [said, setSaid] = useState('');
  const asked = useRef(false);
  const askSync = () => {
    asked.current = true;
    void syncNow();
  };
  useEffect(() => {
    if (asked.current && (sync?.phase === 'done' || sync?.phase === 'error' || !online)) {
      asked.current = false;
      setSaid(!online ? 'You are offline. The balance shown is from the last sync.' : syncText);
    }
    // Only a change of phase is news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.phase, online]);

  const incomingNau = history.filter((h) => h.kind === 'received' && h.status === 'pending').reduce((sum, h) => sum + BigInt(h.amountNau), 0n);
  const incomingSeen = useRef<bigint | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (incomingSeen.current !== null && incomingNau > incomingSeen.current) {
      setSaid(hidden ? 'A payment to you is pending.' : `${speakNau(incomingNau - incomingSeen.current)} NPT to you is pending.`);
    }
    incomingSeen.current = incomingNau;
  }, [incomingNau, loaded, hidden]);
  // The sentence behind the readings under the balance opens from an ⓘ at
  // the end of the last one. A pending send without change shows no
  // reading; a link opens it then.
  const readings = [incomingNau > 0n && 'incoming', loaded && ownReady && onHoldNau > 0n && 'held', balance.lockedNau > 0n && 'locked'].filter(Boolean);
  const explained = incomingNau > 0n || balance.reservedNau > 0n || balance.lockedNau > 0n;
  const explainAfter = (reading: string) =>
    explained && readings[readings.length - 1] === reading ? (
      <ActionIcon variant="transparent" size="sm" className="vault-tap vault-info-button" aria-label="What does this mean?" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
        <IconInfoCircle size={16} />
      </ActionIcon>
    ) : null;
  /** A send that failed or was given up on: nothing left the wallet. */
  const notSent = (e: HistoryEntry) => e.kind !== 'received' && e.record.status === 'failed';
  /** The payments of a send built here, when it paid more than one recipient. */
  const severalOf = (e: HistoryEntry) => ((e.record.payments?.length ?? 0) > 1 ? (e.record.payments ?? []) : null);
  // A row says who, when and how much. Who: the contact a send went to, the
  // name of the address a payment came in through, or how many a send paid.
  // A send's note to self names it when no contact does, or when it paid
  // several. Without either, the title says what happened. The line under it is the
  // time, and the state only while it is not final and the title does not
  // already say it, then the note when the title is the contact's name.
  // Block counts and the fee are in the sheet.
  const whoOf = (e: HistoryEntry): string | null => {
    if (e.kind === 'received') return labelOf(e.record);
    if (e.kind === 'self' || e.record.txid === '' || e.record.recipient === null) return null;
    const several = severalOf(e);
    if (several) return `${several.length} recipients`;
    return contactFor(e.record.recipient)?.name ?? null;
  };
  /** A send's note to self, or the person's note on a payment received, when it has one. */
  const noteOf = (e: HistoryEntry): string | null => {
    if (e.kind === 'sent') return e.record.note || null;
    const coin = e.kind === 'received' ? receivedCoinOf(e.record) : null;
    return coin ? (receivedNotes[coin] ?? null) : null;
  };
  /** The row's title when a name or a note gives one: the note before a count of recipients. */
  const rowNameOf = (e: HistoryEntry): string | null => {
    const note = noteOf(e);
    return note && (severalOf(e) || !whoOf(e)) ? note : whoOf(e);
  };
  const noteAfterTime = (e: HistoryEntry): string | null => {
    const note = noteOf(e);
    return note && rowNameOf(e) !== note ? note : null;
  };
  /** What happened, in a word or two: a send reads Sent once the node has it (with Waiting for a block beside its time until a block confirms it), or Not going through once nodes dropped it. */
  const stateTitleOf = (e: HistoryEntry): string => {
    if (notSent(e)) return 'Not sent';
    if (e.kind === 'received') return e.record.status === 'failed' ? 'Failed' : 'Received';
    if (e.kind === 'self') return e.record.status === 'pending' ? 'Moving to yourself' : 'Moved to yourself';
    if (isStuck(e.record)) return 'Not going through';
    return 'Sent';
  };
  /**
   * The state beside the time, unless the title already says it: in the
   * row's own muted colour while it simply waits for a block (Waiting for a
   * block, Pending), amber only where something is asked of the person (Not
   * going through), red where it did not happen.
   */
  const stateWordOf = (e: HistoryEntry): { word: string; tone: 'muted' | 'warn' | 'failed' } | null => {
    // A send waiting for a block says so even where its title is the state: the title says only Sent.
    if (e.kind === 'sent' && e.record.status === 'pending' && !notSent(e) && !isStuck(e.record)) return { word: WAITING_FOR_BLOCK, tone: 'muted' };
    const saidInTitle = !rowNameOf(e) && e.kind !== 'received';
    if (saidInTitle) return null;
    if (notSent(e)) return { word: 'Not sent', tone: 'failed' };
    if (e.record.status === 'pending') {
      if (e.kind === 'received') return { word: 'Pending', tone: 'muted' };
      if (isStuck(e.record)) return { word: 'Not going through', tone: 'warn' };
      return { word: WAITING_FOR_BLOCK, tone: 'muted' };
    }
    if (e.record.status === 'failed') return { word: 'Failed', tone: 'failed' };
    return null;
  };
  const toneClass = { muted: undefined, warn: 'vault-state-warn', failed: 'vault-state-failed' } as const;
  // After "Show older", the first of the rows it showed, which takes the focus.
  const firstNew = useRef<string | null>(null);
  // Each row's button, for giving focus back to a row once a dialog about it has closed.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusRow = (key: string) => setTimeout(() => rowRefs.current.get(key)?.focus(), 0);
  const rowIconOf = (e: HistoryEntry) =>
    e.kind === 'received' ? <IconArrowDownLeft size={20} /> : e.kind === 'self' ? <IconArrowsExchange size={20} /> : <IconArrowUpRight size={20} />;
  /** What a screen reader says for a row, list or table alike. */
  const rowLabelOf = (e: HistoryEntry) => {
    const who = whoOf(e);
    const name = rowNameOf(e);
    const whom = !name ? '' : name !== who ? `, ${name}` : e.kind === 'received' ? `, ${who}'s address` : `, to ${who}`;
    const money = notSent(e) ? `${spoken(e.shownNau)} NPT, not taken from your balance` : `${e.kind === 'received' ? 'plus' : 'minus'} ${spoken(e.shownNau)} NPT`;
    // A send says its state in its first word (Sent, Not sent), and that it waits for a block; a payment in says pending.
    const pending = e.record.status !== 'pending' ? '' : e.kind === 'received' ? ', pending' : stateWordOf(e)?.word === WAITING_FOR_BLOCK ? ', waiting for a block' : '';
    const release = lockOf(e.record);
    const note = noteAfterTime(e);
    return `${stateTitleOf(e)}${whom}, ${money}${pending}${release !== null ? `, spendable from ${showDate(release)}` : ''}${note ? `, note: ${note}` : ''}, details`;
  };
  /** The full title, for the detail sheet and for screen readers. */
  const titleOf = (e: HistoryEntry) => {
    const word = stateTitleOf(e);
    if (e.kind !== 'sent' || notSent(e) || e.record.txid === '' || e.record.recipient === null) return word;
    const several = severalOf(e);
    if (several) return `${word} to ${several.length} recipients`;
    const c = contactFor(e.record.recipient);
    return `${word} to ${c ? c.name : abbreviateAddress(e.record.recipient)}`;
  };
  // The coins a payment put on the chain, by their commitments: what a block
  // explorer knows them by. A received row's coin carries its own commitment
  // once scanned with a core that keeps it. The labels say "coin", as the
  // rest of the app does; "output" is the protocol's word, not the person's.
  const outputsOf = (e: HistoryEntry): { commitment: string; label: string }[] => {
    const coinOf = (row: HistoryRecord) => {
      const hash = coinKeyOfReceipt(row);
      return (utxos.find((u) => u.hash === hash)?.stored as StoredUtxo | undefined)?.commitment;
    };
    if (e.kind === 'received') {
      const c = coinOf(e.record) ?? e.record.outputs?.[0]?.commitment;
      return c ? [{ commitment: c, label: 'Your coin' }] : [];
    }
    const numbered = (list: { commitment: string; label: string }[]) => {
      const changes = list.filter((o) => o.label === 'Your change').length;
      let n = 0;
      return list.map((o) => (o.label === 'Your change' && changes > 1 ? { ...o, label: `Your change ${++n}` } : o));
    };
    // A payment to one of this wallet's own addresses made a coin of its own.
    const several = severalOf(e);
    let payment = 0;
    const recorded = (e.record.outputs ?? []).map((o) => {
      if (o.role !== 'recipient') return { commitment: o.commitment, label: 'Your change' };
      payment++;
      if (e.kind === 'self' || e.ownPayments.includes(o.commitment)) return { commitment: o.commitment, label: 'Your coin' };
      return { commitment: o.commitment, label: several ? `Coin for recipient ${payment}` : "The recipient's coin" };
    });
    if (recorded.length > 0) return numbered(recorded);
    // A send recorded before outputs were kept: the coins it brought back
    // are known once scanned, the recipient's output is not.
    return numbered(
      e.folded.flatMap((row) => {
        const c = coinOf(row);
        return c ? [{ commitment: c, label: e.kind === 'self' && BigInt(row.amountNau) === BigInt(e.record.amountNau) ? 'Your coin' : 'Your change' }] : [];
      }),
    );
  };

  // The explorer knows Mainnet only.
  const explorer = account?.network === 'main' ? LINKS.explorerOutput : null;

  // Confirmed, and how many blocks have come since: what "wait for several
  // blocks" is counted in.
  const statusOf = (h: HistoryRecord) => {
    const since = blocksSince(h);
    return h.status === 'confirmed'
      ? h.height !== null
        ? since === null
          ? `Confirmed in block ${showBlock(h.height)}`
          : since === 0
            ? `Confirmed in the newest block (block ${showBlock(h.height)})`
            : `Confirmed ${showBlock(since)} ${since === 1 ? 'block' : 'blocks'} ago (block ${showBlock(h.height)})`
        : 'Confirmed'
      : h.status === 'pending'
        ? // The row's words: a send waiting for a block says so, a payment coming in is Pending.
          h.kind === 'sent'
          ? isStuck(h)
            ? 'Not going through'
            : WAITING_FOR_BLOCK
          : 'Pending'
        : h.kind === 'sent'
          ? 'Not sent. Nothing left this wallet.'
          : 'Failed';
  };
  const nodeStatusOf = (h: HistoryRecord) => {
    if (h.kind !== 'sent' || h.status !== 'pending' || !h.mempoolCheckedAt) return null;
    const holds = nodeHolds(h);
    if (holds === 'has') return `The node has it (checked ${whenInSentence(h.mempoolCheckedAt)}).`;
    if (holds === 'had') return `The node had it until ${whenInSentence(h.mempoolSeenAt as number)}, but not at the last check (${whenInSentence(h.mempoolCheckedAt)}). It may have been dropped.`;
    return `The node does not have it (checked ${whenInSentence(h.mempoolCheckedAt)}).`;
  };

  return (
    <Stack gap="md">
      <Title order={2} className="sr-only">
        Home
      </Title>
      {/* A wallet with no confirmed seed phrase and no backup file can be lost
          with this device or browser: a warning, at the top. The early-version
          warning is the Beta tag in the header (PocNotice.tsx). */}
      {showBackupNudge && (
        <Caution title="Back up this wallet" onClose={() => void dismissNudge()} closeLabel="Dismiss the backup reminder">
          {NATIVE
            ? 'This wallet lives only on this device. Export a backup file so you can restore it, with its contacts, if the device is lost or its data deleted.'
            : "This wallet lives only in this browser. Export a backup file so you can restore it, with its contacts, if the browser's data is cleared."}
          <div>
            <UnstyledButton onClick={() => navigate('/settings/backup', { state: { from: 'home' } })} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
              Export backup file
            </UnstyledButton>
          </div>
        </Caution>
      )}
      {/* A wallet whose history on this device would not open looks empty:
          it says so, and how to rebuild it from the chain. */}
      {account && unreadable && <RebuildNotice accountId={account.id} why={unreadable} />}
      {/* The dot answers "is this current?" without reading: green up to date,
          blue while working, amber when the node looks behind (a caution:
          recent payments may not show), red when it cannot say. */}
      <div className="vault-status">
        <span className="vault-status-text">
          <span className={`vault-status-dot ${!online || sync?.phase === 'error' ? 'bad' : sync?.phase === 'done' ? (behind ? 'warn' : 'ok') : 'busy'}`} aria-hidden />
          {!online && <IconWifiOff size={16} />}
          {busy && <IconRefresh size={16} className="vault-spin" />}
          {syncText}
        </span>
        {/* The actions stay where they are while a sync runs, unavailable
            rather than gone, so focus on them is not dropped. */}
        {online && (
          <span className="vault-status-actions">
            {sync?.phase === 'error' && !busy && (
              <UnstyledButton onClick={() => navigate('/settings/advanced', { state: { from: 'home' } })} fz="xs" c="var(--v-accent-text)" className="vault-tap-link">
                Settings
              </UnstyledButton>
            )}
            <UnstyledButton onClick={() => !busy && askSync()} aria-disabled={busy} fz="xs" c={busy ? 'dimmed' : 'var(--v-accent-text)'} className="vault-tap-link">
              {busy ? 'Syncing…' : sync?.phase === 'error' ? 'Try again' : 'Sync'}
            </UnstyledButton>
          </span>
        )}
      </div>
      <div className="sr-only" role="status">
        {said}
      </div>
      {/* A long scan stops when the screen turns off and the wallet locks: said
          while one runs, in full only when the app could not keep the screen on. */}
      {longScan && !DESKTOP && (
        <Text size="xs" c="dimmed" mt={-8}>
          {screenAwake === 'held' ? 'Keep the app open until the scan finishes. It pauses if the wallet locks, and goes on at the next unlock.' : 'Keep the app open with the screen on: the scan pauses when the screen turns off, and goes on at the next unlock.'}
        </Text>
      )}
      {/* On a phone a card, the actions under the balance; on a wide screen a
          band, the actions to its right. */}
      <Paper>
        <div className="vault-balance-layout">
          <Stack gap="xs">
            {/* The eye keeps its 40 px target but is pulled into the row's
                margins, so the label sits where every other card's title does.
                One name, and the pressed state says whether amounts are hidden. */}
            <div className="vault-balance-head">
              <span className="vault-eyebrow">Balance</span>
              <ActionIcon variant="subtle" size="lg" className="vault-tap" my={-10} mr={-8} aria-label="Hide amounts" aria-pressed={hidden} onClick={toggleHidden}>
                {hidden ? <IconEyeOff size={20} /> : <IconEye size={20} />}
              </ActionIcon>
            </div>
            {/* The figure on screen is grouped; a screen reader is given plain digits, or "hidden". */}
            <div className="vault-balance">
              <span aria-hidden>
                {loaded && ownReady ? amount(headlineNau) : '…'}
                <small> NPT</small>
              </span>
              <span className="sr-only">{loaded && ownReady ? `Balance ${spoken(headlineNau)} NPT${unsynced ? ', not synced yet' : ''}` : 'Balance loading'}</span>
            </div>
            {loaded && unsynced && (
              <Text size="sm" c="dimmed" aria-hidden>
                Not synced yet
              </Text>
            )}
            {/* An estimate, and said to be one. Its price says how old it is
                once that matters; where it is from is in Settings, Currency. */}
            {loaded && ownReady && quote && fiat && (
              <div className="vault-balance-fiat">
                <span className="vault-balance-fiat-value">
                  ≈ {hidden ? '••••' : fiat.figure} <span className="vault-unit">{fiat.code}</span>
                </span>
                {Date.now() - quote.at > QUOTE_OLD_MS && <span className="vault-balance-fiat-source">price from {timeAgo(quote.at)}</span>}
              </div>
            )}
            {/* Money on the way and money held, as two readings; the sentence behind them is one tap away. */}
            {incomingNau > 0n && (
              <Group gap={6} wrap="nowrap">
                <IconArrowDownLeft size={16} className="vault-balance-note-in" aria-hidden />
                <Text size="sm" c="dimmed">
                  <span className="vault-figure">{amount(incomingNau)}</span> NPT pending
                  {explainAfter('incoming')}
                </Text>
              </Group>
            )}
            {/* The two figures add up to the balance above. */}
            {loaded && ownReady && onHoldNau > 0n && (
              <Group gap={6} wrap="nowrap" align="flex-start">
                <IconHourglass size={16} className="vault-balance-note-held" aria-hidden style={{ marginTop: 4 }} />
                <Text size="sm" c="dimmed">
                  Spendable <span className="vault-figure">{amount(balance.spendableNau)}</span> NPT · <span className="vault-figure">{amount(onHoldNau)}</span> NPT on hold
                  {explainAfter('held')}
                </Text>
              </Group>
            )}
            {balance.lockedNau > 0n && (
              <Group gap={6} wrap="nowrap">
                <IconClockPause size={16} className="vault-balance-note-held" aria-hidden />
                <Text size="sm" c="dimmed">
                  <span className="vault-figure">{amount(balance.lockedNau)}</span> NPT {balance.nextReleaseMs ? `spendable from ${showDate(balance.nextReleaseMs)}` : 'not spendable yet'}
                  {explainAfter('locked')}
                </Text>
              </Group>
            )}
            {explained && (
              <>
                {readings.length === 0 && (
                  <UnstyledButton onClick={() => setWhy((v) => !v)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start" aria-expanded={why}>
                    {why ? 'Less' : 'What does this mean?'}
                  </UnstyledButton>
                )}
                {why && (
                  <Text size="sm" c="dimmed">
                    {incomingNau > 0n && `${amount(incomingNau)} NPT is pending: it becomes spendable once a block confirms it. `}
                    {balance.lockedNau > 0n && `${amount(balance.lockedNau)} NPT is yours, but the sender set a date before which it cannot be spent, so it is not counted as spendable. `}
                    {balance.reservedNau > 0n && `${pendingExplained()} `}
                  </Text>
                )}
              </>
            )}
          </Stack>
          <div className="vault-balance-actions">
            <Button leftSection={<IconArrowUpRight size={16} />} onClick={() => navigate('/send')}>
              Send
            </Button>
            <Button variant="light" leftSection={<IconArrowDownLeft size={16} />} onClick={() => navigate('/receive')}>
              Receive
            </Button>
          </div>
        </div>
      </Paper>

      {/* Notices about what happened and what to do, after the balance so it
          keeps the first screen: one about a send at a time, then the install offer. */}
      {/* How the last send that reached the node ended, until it confirms or is dismissed: a send that
          finished while the app was locked still says so here. */}
      {lastSend && lastSend.accountId === account?.id && !(failure && failure.accountId === account.id && failure.at > lastSend.at) && (
        (() => {
          const c = contactFor(lastSend.recipient.toLowerCase());
          // A name is set apart from the text around it, so one written right to left cannot reorder the sentence.
          const who =
            !lastSend.others && isOwn(lastSend.recipient) ? (
              'yourself'
            ) : (
              <>
                <bdi>{c ? c.name : abbreviateAddress(lastSend.recipient)}</bdi>
                {lastSend.others ? ` and ${lastSend.others} more` : ''}
              </>
            );
          const dismiss = () => {
            dismissLastSend();
            dismissSendJob();
          };
          // Not announced when it appears: the toast or the Send screen said it as it happened.
          // One sentence each, in the same words as on Send, and in one
          // element: a notice stacks what it holds as lines, and the name,
          // an element of its own, would break it there. When it was sent is in History.
          return lastSend.state === 'unconfirmed' ? (
            <Caution title={UNANSWERED_TITLE} onClose={dismiss} closeLabel="Dismiss">
              <span>
                Your {amount(BigInt(lastSend.amountNau))} NPT to {who} {MAY_HAVE_GONE_OUT}
              </span>
            </Caution>
          ) : (
            <Info title={SENT_WAITING} onClose={dismiss} closeLabel="Dismiss">
              <span>
                {amount(BigInt(lastSend.amountNau))} NPT to {who}, plus a {amount(BigInt(lastSend.feeNau))} NPT fee. {SENDING_UNTIL_CONFIRMED}
              </span>
            </Info>
          );
        })()
      )}
      {/* A group, not an alert: the toast announced it when it happened, and
          an alert here would be announced again at every visit to Home. */}
      {failure && failure.accountId === account?.id && !(lastSend && lastSend.accountId === account.id && lastSend.at >= failure.at) && (
        <ErrorLine title="Not sent" onClose={dismissFailure} role="group">
          <Text size="sm">
            {hidden ? '••••' : failure.amount} NPT to <bdi>{contactFor(failure.recipient.toLowerCase())?.name ?? abbreviateAddress(failure.recipient)}</bdi>
            {failure.others ? ` and ${failure.others} more` : ''}. {notSentReason(failure.message)}
          </Text>
        </ErrorLine>
      )}
      {/* A send nodes no longer keep and no block took: it is not going
          through, and its coins wait for nothing until it expires. One
          sentence and a calm button: giving up is what it recommends, and
          the dialog after it says why and gives the red button. */}
      {stuck && (
        <Caution title="This send is not going through">
          {/* The sentence in one element, as above, and the button on its own line. */}
          <span>
            Giving up on your {amount(BigInt(stuck.amountNau))}&nbsp;NPT to {stuck.recipient ? <bdi>{contactFor(stuck.recipient)?.name ?? abbreviateAddress(stuck.recipient)}</bdi> : 'a recipient'} makes {amount(reservedFor(stuck))}&nbsp;NPT spendable now; otherwise it becomes spendable {dayAhead(expiresAt(stuck)).replace(/ (?=\S+$)/, ' ')}.
          </span>
          <Group mt={4}>
            <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => setGivingUp(stuck)}>
              Give up on this send
            </Button>
          </Group>
        </Caution>
      )}
      {/* One notice at a time: while the backup warning above shows, the install offer waits. */}
      {!showBackupNudge && <InstallNudge />}

      <Paper>
        <Stack>
        <Title order={3}>History</Title>
        {!loaded ? (
          <Text c="dimmed" size="sm">
            Loading…
          </Text>
        ) : entries.length === 0 ? (
          !busy && unsynced ? (
            // Nothing found yet because nothing has been searched: why, and the two ways on.
            <Stack gap={6}>
              <Text c="dimmed" size="sm">
                {unsyncedReason}
              </Text>
              <Group gap="sm">
                <UnstyledButton onClick={askSync} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                  Try again
                </UnstyledButton>
                <UnstyledButton onClick={() => navigate('/settings/advanced', { state: { from: 'home' } })} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
                  Node settings
                </UnstyledButton>
              </Group>
            </Stack>
          ) : busy ? (
            // Still being searched: "nothing" would be a guess, and a
            // restore of a funded wallet reading as empty is alarming. How
            // far it has got is said once, on the status line above.
            <Text c="dimmed" size="sm">
              Finding your payments…
            </Text>
          ) : (
            <Stack gap={6}>
              <Text c="dimmed" size="sm">
                Nothing yet.{' '}
                <UnstyledButton onClick={() => navigate('/receive')} fz="sm" className="vault-inline-link">
                  Share your receiving address
                </UnstyledButton>{' '}
                to get started.
              </Text>
              {account && <SearchedFrom account={account} />}
            </Stack>
          )
        ) : (
          <div>
            {days.map((day) => (
              <section key={day.key} className="vault-history-day">
                <h4 className="vault-history-day-label">{day.label}</h4>
                <div>
                  {day.entries.map((e) => {
                    const h = e.record;
                    const incoming = e.kind === 'received';
                    return (
                      <UnstyledButton
                        className="vault-row vault-row-button"
                        key={h.key}
                        onClick={() => setDetail(e)}
                        aria-label={rowLabelOf(e)}
                        ref={(el: HTMLButtonElement | null) => {
                          if (el) rowRefs.current.set(h.key, el);
                          else rowRefs.current.delete(h.key);
                          // The first of the rows just shown takes the focus from the button that is gone.
                          if (el && firstNew.current === h.key) {
                            firstNew.current = null;
                            el.focus();
                          }
                        }}
                      >
                        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                          <span className={`vault-row-icon${incoming ? '' : ' out'}`}>{rowIconOf(e)}</span>
                          <div style={{ minWidth: 0 }}>
                            {/* A send not going through says so in its title when nothing else names it, in the caution colour. */}
                            <Text size="sm" fw={600} className={!rowNameOf(e) && isStuck(h) ? 'vault-row-title vault-state-warn' : 'vault-row-title'}>
                              {rowNameOf(e) ? <bdi>{rowNameOf(e)}</bdi> : stateTitleOf(e)}
                            </Text>
                            <Text size="xs" c="dimmed" className="vault-row-meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {formatTime(h.timestampMs)}
                              {stateWordOf(e) && (
                                <>
                                  {' · '}
                                  <Text span inherit className={toneClass[stateWordOf(e)?.tone ?? 'muted']}>
                                    {stateWordOf(e)?.word}
                                  </Text>
                                </>
                              )}
                              {/* A time lock only waits for its date: said in the row's own colour. */}
                              {lockOf(h) !== null && ` · Spendable from ${showDate(lockOf(h) as number)}`}
                              {e.kind === 'self' && !hidden && ' · fee only'}
                              {/* Last, so a long one is what the line cuts short. */}
                              {noteAfterTime(e) && (
                                <>
                                  {' · '}
                                  <bdi>{noteAfterTime(e)}</bdi>
                                </>
                              )}
                            </Text>
                          </div>
                        </Group>
                        <div className="vault-row-amount">
                          {/* Nothing left the wallet: the figure is struck through, with no sign. */}
                          <Text size="sm" fw={600} c={notSent(e) ? 'dimmed' : undefined} td={notSent(e) ? 'line-through' : undefined} className={incoming ? 'vault-amount-in' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {notSent(e) ? '' : incoming ? '+' : '−'}
                            {amount(e.shownNau)}{' '}
                            <span className="vault-unit">NPT</span>
                          </Text>
                        </div>
                      </UnstyledButton>
                    );
                  })}
                </div>
              </section>
            ))}
            {entries.length > shown && (
              <Button
                variant="subtle"
                fullWidth
                mt="xs"
                onClick={() => {
                  firstNew.current = entries[shown]?.record.key ?? null;
                  setShown((n) => n + PAGE);
                }}
              >
                Show {Math.min(PAGE, entries.length - shown)} older
              </Button>
            )}
          </div>
        )}
        </Stack>
      </Paper>

      <Sheet opened={detail !== null} onClose={() => setDetail(null)} title={detail ? titleOf(detail) : ''}>
        {detail && (
          <Stack gap="sm">
            <DetailRow label="Status" value={statusOf(detail.record)} />
            <DetailRow label="When" value={formatDateTime(detail.record.timestampMs)} />
            {/* The figures as the review showed them before the send: a
                receipt, each on one line, the total set off beneath. */}
            <div className="vault-review">
              {detail.kind === 'received' && <ReceiptRow label="Amount" figure={amount(detail.shownNau)} />}
              {detail.kind === 'sent' && (
                <ReceiptRow label={detail.record.txid === '' || detail.record.recipient === null ? 'Amount plus fee' : severalOf(detail) ? 'Amounts together' : 'Amount'} figure={amount(BigInt(detail.record.amountNau))} />
              )}
              {detail.kind === 'self' && <ReceiptRow label="Moved" figure={amount(BigInt(detail.record.amountNau))} />}
              {detail.kind !== 'received' && detail.record.feeNau && <ReceiptRow label="Fee" figure={amount(BigInt(detail.record.feeNau))} />}
              {/* The figure on the row, where it is made of two: what left the wallet. */}
              {/* When some of it paid this wallet's own addresses, the amounts and the fee add up to more than what left, so the row says which it is. */}
              {detail.kind === 'sent' && detail.record.feeNau && <ReceiptRow total label={detail.ownPayments.length > 0 ? 'Left this wallet' : 'Total'} figure={amount(detail.shownNau)} />}
            </div>
            {labelOf(detail.record) && <DetailRow label="Paid to" value={`Your address for ${labelOf(detail.record)}`} isolate />}
            {lockOf(detail.record) !== null && (
              <DetailRow label="Spendable from" value={`${formatDateTime(lockOf(detail.record) as number)}. The sender set this date; confirmations do not bring it forward.`} />
            )}
            {/* A send to several: each recipient, with what it got, in the order sent. */}
            {detail.kind !== 'received' &&
              severalOf(detail)?.map((p, i) => {
                const c = contactFor(p.recipient);
                const own = detail.kind === 'self' || detail.ownPayments.includes((detail.record.outputs ?? []).filter((o) => o.role === 'recipient')[i]?.commitment ?? '');
                return (
                  <DetailRow
                    key={i}
                    label={`Recipient ${i + 1}${own ? ' · this wallet' : c ? ` · ${c.name}` : ''} · ${amount(BigInt(p.amountNau))} NPT`}
                    value={p.recipient}
                    mono
                    abbreviate
                    copy="Address copied"
                  />
                );
              })}
            {detail.kind !== 'received' && detail.record.recipient && !severalOf(detail) && (
              <DetailRow
                label={detail.kind === 'self' ? 'Recipient · this wallet' : contactFor(detail.record.recipient) ? `Recipient · ${contactFor(detail.record.recipient)?.name}` : 'Recipient'}
                value={detail.record.recipient}
                mono
                abbreviate
                copy="Address copied"
              />
            )}
            {detail.kind === 'sent' && !detail.record.recipient && (
              <DetailRow label="Recipient" value="Not recorded. The send was made on another device or before a restore, so the amount above includes the fee." />
            )}
            {detail.record.note && <DetailRow label="Note" value={detail.record.note} isolate />}
            {detail.kind === 'received' && receivedCoinOf(detail.record) && account && (
              <ReceivedNote
                key={detail.record.key}
                note={noteOf(detail)}
                onSave={async (text: string) => setReceivedNotes(await writeReceivedNote(services.core, services.accounts.engine, account.id, receivedCoinOf(detail.record)!, text))}
              />
            )}
            {detail.record.error && <DetailRow label="What happened" value={detail.record.error} />}
            {(outputsOf(detail).length > 0 || nodeStatusOf(detail.record) !== null || (detail.kind !== 'received' && detail.changeNau !== null && detail.changeNau > 0n)) && (
              <>
                {/* A section of the sheet, not a link beside the address's own
                    link: a line above it, the muted colour, a chevron that turns. */}
                <UnstyledButton onClick={() => setTech((v) => !v)} className="vault-detail-section" aria-expanded={tech}>
                  <span>Technical details</span>
                  <IconChevronRight size={16} aria-hidden className={tech ? 'vault-chevron open' : 'vault-chevron'} />
                </UnstyledButton>
                {/* What the node said at its last check: the status above already says what it means. */}
                {tech && nodeStatusOf(detail.record) && <DetailRow label="Node" value={nodeStatusOf(detail.record) as string} />}
                {/* The change is the send's own business: what came back to this wallet, not money received. */}
                {tech && detail.kind !== 'received' && detail.changeNau !== null && detail.changeNau > 0n && (
                  <DetailRow label="Change" value={`${amount(detail.changeNau)} NPT, which came back to this wallet`} />
                )}
                {tech && outputsOf(detail).length > 0 && (
                  <Text size="sm" c="dimmed">
                    Identifiers of the coins this payment created, for looking them up in a block explorer. They reveal no amount and no address.
                  </Text>
                )}
                {tech &&
                  outputsOf(detail).map((o) => (
                    <DetailRow key={o.commitment} label={o.label} value={o.commitment} mono copy="Identifier copied" href={explorer ? explorer + o.commitment : undefined} />
                  ))}
              </>
            )}
            {/* Calm, as on Home's notice: the dialog it opens says why and holds the red button. */}
            {detail.kind !== 'received' && detail.record.status === 'pending' && (
              <Group justify="flex-end" mt="xs">
                <Button
                  variant="light"
                  onClick={() => {
                    setGivingUp(detail.record);
                    setDetail(null);
                  }}
                >
                  Give up on this send
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Sheet>

      <Sheet opened={givingUp !== null} onClose={closeGiveUp} returnFocus={false} title="Give up on this send?">
        {givingUp && (
          <Stack>
            <Text size="sm">
              {nodeHolds(givingUp) === 'has'
                ? 'The node still has this send, so it may still go through. Giving up makes its coins spendable here, but if it confirms anyway, it shows up as Sent.'
                : nodeHolds(givingUp) === null
                  ? 'Giving up makes its coins spendable, and the send stays in History, marked Not sent. If it confirms anyway, it still goes through and shows up as Sent.'
                  : 'The node no longer has this send. Giving up makes its coins spendable, and the send stays in History, marked Not sent.'}
            </Text>
            <Text size="sm" c="dimmed">
              This send: {showNau(BigInt(givingUp.amountNau))} NPT{givingUp.feeNau && ` plus a ${showNau(BigInt(givingUp.feeNau))} NPT fee`}. Giving up makes {showNau(reservedFor(givingUp))} NPT spendable again.
            </Text>
            {giveUpError && <ErrorLine title="This send was not given up">{giveUpError}</ErrorLine>}
            <Group grow>
              <Button variant="default" onClick={closeGiveUp}>
                Cancel
              </Button>
              <Button color="red" loading={giveUpBusy} onClick={() => void giveUp()}>
                {giveUpError ? 'Try again' : 'Give up'}
              </Button>
            </Group>
          </Stack>
        )}
      </Sheet>
    </Stack>
  );
}

/** A figure in the detail sheet, as the review shows it: the label, and the figure at the end of the line. */
function ReceiptRow({ label, figure, total }: { label: string; figure: string; total?: boolean }) {
  return (
    <div className={total ? 'vault-review-row total' : 'vault-review-row'}>
      <span>{label}</span>
      <b>
        {figure} <span className="vault-unit">NPT</span>
      </b>
    </div>
  );
}

/** A label and its value in the detail sheet; long values wrap and can be copied. */
function DetailRow({ label, value, mono, copy, href, abbreviate, isolate }: { label: string; value: string; mono?: boolean; copy?: string; href?: string; abbreviate?: boolean; isolate?: boolean }) {
  // Long values (a generation address is about 3,500 characters) show
  // abbreviated with a toggle; copying always takes the full value.
  const [full, setFull] = useState(false);
  const shown = abbreviate && !full ? abbreviateAddress(value) : value;
  return (
    <div className="vault-detail-row">
      <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed" className="vault-detail-label">
          {label}
        </Text>
        {(copy || href) && (
          <Group gap={2} wrap="nowrap">
            {copy && (
              <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copyText(value, copy)}>
                <IconCopy size={20} />
              </ActionIcon>
            )}
            {href && (
              <ActionIcon component="a" href={href} target="_blank" rel="noreferrer" variant="subtle" size="lg" className="vault-tap" aria-label={`Open ${label.toLowerCase()} in the explorer`}>
                <IconExternalLink size={20} />
              </ActionIcon>
            )}
          </Group>
        )}
      </Group>
      <Text size="sm" className={mono ? 'vault-detail-mono' : isolate ? 'vault-bidi vault-link-meta-text' : undefined} dir={isolate ? 'auto' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {shown}
      </Text>
      {abbreviate && (
        <UnstyledButton onClick={() => setFull((v) => !v)} c="var(--v-accent-text)" fz="xs" className="vault-tap-link vault-tap-link-start">
          {full ? 'Hide full address' : 'Show full address'}
        </UnstyledButton>
      )}
    </div>
  );
}

/**
 * A wallet whose history on this device would not open: it looks empty but
 * is not, and it can be rebuilt from the chain. What would not open is kept
 * aside, not deleted. One written by a newer version of the app is not
 * damage: that needs the newer app, not a rebuild.
 */
function RebuildNotice({ accountId, why }: { accountId: string; why: string }) {
  const { services, refresh, syncNow } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (why.includes('written by a newer version')) {
    return (
      <Caution title="Update the app to see this wallet's history">
        This wallet's history on this device was last written by a newer version of Neptune Vault, which this version cannot read. {COINS_SAFE} Update the app, then open the wallet again.
      </Caution>
    );
  }
  const rebuild = async () => {
    setBusy(true);
    setError(null);
    try {
      await services.accounts.setAsideStore(accountId);
      await refresh();
      void syncNow();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Caution title="This wallet's history could not be read">
      Its history on this device could not be read, so the wallet looks empty. {COINS_SAFE} Rebuild the history from the chain: what could not be read is kept aside, and nothing is deleted.
      <Group mt={4}>
        <Button variant="light" size="compact-sm" className="vault-tap" loading={busy} onClick={() => void rebuild()}>
          Rebuild from the chain
        </Button>
      </Group>
      {error && (
        <Text size="sm" c="var(--v-danger-text)" role="alert">
          {error}
        </Text>
      )}
    </Caution>
  );
}

/**
 * Under an empty history: where this wallet looks for payments from. A
 * restore aimed at too late a date shows nothing, and this says how to look
 * further back. After a fast restore, which asks about the whole chain, it
 * says that instead.
 */
function SearchedFrom({ account }: { account: AccountRecord }) {
  const { services } = useApp();
  const navigate = useNavigate();
  const [date, setDate] = useState<number | null>(null);
  const from = account.birthdayHeight;
  useEffect(() => {
    if (account.restoredAt || from <= 1) return;
    let live = true;
    void services
      .node()
      .blockHeaderAt(from)
      .then(
        (h) => live && setDate(h?.timestamp ?? null),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [services, from, account.restoredAt]);
  if (account.restoredAt) {
    return (
      <Text c="dimmed" size="xs">
        A fast restore checked the whole chain and found no payments to this wallet.
      </Text>
    );
  }
  if (from <= 1) return null;
  return (
    <Text c="dimmed" size="xs">
      This wallet looks for payments from block {showBlock(from)}
      {date ? ` (${formatDate(date)})` : ''}. Expecting an older one?{' '}
      <UnstyledButton onClick={() => navigate('/settings/advanced#rescan', { state: { from: 'home' } })} fz="xs" className="vault-inline-link">
        Rescan from an earlier date
      </UnstyledButton>
    </Text>
  );
}

/**
 * The person's note on a payment received, in its details: Add note, or the
 * note with Edit; saved empty, it goes. Worded as a send's note on Send.
 */
function ReceivedNote({ note, onSave }: { note: string | null; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <>
        {note && <DetailRow label="Note" value={note} isolate />}
        <UnstyledButton
          onClick={() => {
            setText(note ?? '');
            setEditing(true);
          }}
          c="var(--v-accent-text)"
          fz="sm"
          className="vault-tap-link vault-tap-link-start"
        >
          {note ? 'Edit note' : 'Add note'}
        </UnstyledButton>
      </>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Stack gap="xs">
        <TextInput label="Note to self" description="Only you see it, in History." placeholder="What it was for" value={text} maxLength={SEND_NOTE_MAX} onChange={(e) => setText(e.currentTarget.value)} autoFocus />
        <Group grow>
          <Button variant="default" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </Group>
        {error && <ErrorLine>{error}</ErrorLine>}
      </Stack>
    </form>
  );
}
