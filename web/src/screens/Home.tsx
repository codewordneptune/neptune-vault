// Balance, sync status and history.

import { ActionIcon, Button, Group, Paper, Stack, Text, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconAlertCircle, IconArrowDownLeft, IconArrowUpRight, IconArrowsExchange, IconCheck, IconChevronRight, IconCircleCheck, IconCircleDot, IconClockPause, IconCopy, IconExternalLink, IconEye, IconEyeOff, IconHourglass, IconInfoCircle, IconRefresh, IconWifiOff } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { Sheet } from '../components/Sheet';
import { NAU_PER_COIN, showBlock, showNau, UNANSWERED_TITLE, useApp } from '../app/AppContext';
import { coinAddressKey, addressKey, readLabels, type AddressLabels } from '../app/addressLabels';
import { EXPIRED_NOTE, mayStillGo, MEMPOOL_KEEPS_MS, removable, SEND_LIFETIME_MS, SEND_NOTE_MAX } from '../app/send';
import { readReceivedNotes, receivedCoinOf, writeReceivedNote, type ReceivedNotes } from '../app/receivedNotes';
import { readSentNotes, sentCoinOf, sentNoteOf, writeSentNote, type SentNotes } from '../app/sentNotes';
import { usePendingSends } from '../app/pending';
import { readSendDetails, withSendDetails } from '../app/sendDetails';
import { fixedNau, useCountUp } from '../app/countUp';
import { Amount, Figure, speakNau } from '../components/Amount';
import { Avatar } from '../components/Avatar';
import { Spoken, spokenText } from '../components/Spoken';
import { QUOTE_OLD_MS, useQuote } from '../app/price';
import { fiatOf, fiatParts } from '../util/fiat';
import type { StoredUtxo } from '../backend/types';
import type { AccountRecord, ContactRecord, HistoryRecord, SendDetails } from '../storage/db';
import { InstallNudge } from '../components/InstallNudge';
import { StorageNotice } from '../components/StorageNotice';
import { Caution, ErrorLine, headingNear, Info } from '../components/Notice';
import { COINS_SAFE, MAY_HAVE_GONE_OUT, notSentReason, SENDING_UNTIL_CONFIRMED, SENT_WAITING, WAITING_FOR_BLOCK } from '../app/words';
import { DESKTOP, MOBILE, NATIVE } from '../app/platform';
import { PULL_READY_PX, usePullToSync } from '../app/pullToSync';
import { LINKS } from '../app/links';
import { abbreviateAddress } from '../util/address';
import { copyText } from '../util/clipboard';
import { coinKeyOfReceipt, groupHistory, type HistoryEntry } from '../util/history';
import { arrivals, type Listed } from '../util/arrivals';
import { dayAhead, dayKey, dayLabel, formatAbout, formatDate, formatDateTime, formatTime, timeAgo, whenInSentence } from '../util/time';

export function Home() {
  const { balance, sync, history, utxos, syncNow, lastSyncedAt, online, services, refresh, account, dismissSendJob, loaded, sendFailure: failure, dismissSendFailure, lastSend, dismissLastSend, screenAwake, sendJob } = useApp();
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
  // A new balance counts up or down to its value, the figure in the other currency with it.
  const reducedMotion = useReducedMotion();
  const counted = useCountUp(loaded && ownReady ? headlineNau : null, hidden || reducedMotion, account?.id ?? '');
  const balanceText = hidden ? '••••' : counted && counted.decimals !== null ? fixedNau(counted.nau, counted.decimals) : showNau(headlineNau);
  const fiat = quote ? fiatParts(fiatOf(counted?.nau ?? headlineNau, NAU_PER_COIN, quote.price), quote.currency) : null;

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
  // And on sends, as changed here after the send.
  const [sentNotes, setSentNotes] = useState<SentNotes>({});
  useEffect(() => {
    if (!account) return;
    void readSentNotes(services.core, services.accounts.engine, account.id).then(setSentNotes, () => setSentNotes({}));
  }, [services, account]);
  // One entry per transaction, with the recipient named when it is a contact.
  const entries = groupHistory(withSendDetails(history, sendDetails), utxos).map((e) =>
    e.kind === 'sent' && e.record.status === 'pending' && toSelf(e.record) ? { ...e, kind: 'self' as const, shownNau: BigInt(e.record.feeNau ?? '0') } : e,
  );
  // A payment that arrives while History is in view slides in with a brief
  // green wash (util/arrivals.ts); a wallet's first listing shows as it is.
  const listed = useRef<{ account: string; listed: Listed } | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  // Before the screen is painted, so a new row is never shown before it slides in.
  useLayoutEffect(() => {
    if (!loaded || !account) return;
    const next = arrivals(listed.current?.account === account.id ? listed.current.listed : null, history, Date.now());
    listed.current = { account: account.id, listed: next.listed };
    if (next.arrived.length > 0) setArrived(new Set(next.arrived));
  }, [history, loaded, account]);
  useEffect(() => {
    if (arrived.size === 0) return;
    const t = setTimeout(() => setArrived(new Set()), 1000);
    return () => clearTimeout(t);
  }, [arrived]);
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
  // The entry whose details are open, read from History as it is now: a
  // send that confirms while its sheet is open says so there and then.
  const [opened, setDetail] = useState<HistoryEntry | null>(null);
  const detail = opened ? (entries.find((e) => e.record.key === opened.record.key) ?? opened) : null;
  const [why, setWhy] = useState(false);
  // The sheet's technical rows are folded until asked for, and fold again for the next entry.
  const [tech, setTech] = useState(false);
  useEffect(() => setTech(false), [opened]);
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
  // The send as History has it now. One that stopped waiting while the
  // dialog was open, or that the engine found no longer pending, is not
  // given up, and the dialog says why.
  const givingUpNow = givingUp ? (history.find((h) => h.key === givingUp.key) ?? givingUp) : null;
  const [notPending, setNotPending] = useState(false);
  const nothingToGiveUp = givingUpNow !== null && (notPending || givingUpNow.status !== 'pending');
  const closeGiveUp = () => {
    if (givingUp) focusRow(givingUp.key);
    setGivingUp(null);
    setGiveUpError(null);
    setNotPending(false);
  };
  const giveUp = async () => {
    if (!account || !givingUp) return;
    const key = givingUp.key;
    setGiveUpBusy(true);
    setGiveUpError(null);
    let given: boolean;
    try {
      given = await services.sendService(account.id).forget(givingUp.txid);
    } catch (e) {
      setGiveUpError((e as Error).message);
      return;
    } finally {
      setGiveUpBusy(false);
    }
    if (!given) {
      await refresh();
      setNotPending(true);
      return;
    }
    setGivingUp(null);
    await refresh();
    focusRow(key);
  };
  // A send given up on, or expired, can still go through until a block spends one of its coins.
  const spentCoins = new Set(utxos.filter((u) => u.spentHeight !== null).map((u) => u.hash));
  const stillGoes = (h: HistoryRecord) => mayStillGo(h, (coin) => spentCoins.has(coin));
  // A send that was not sent leaves History once it can no longer go
  // through; confirmed first.
  const [removing, setRemoving] = useState<HistoryRecord | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const historyTitle = useRef<HTMLHeadingElement>(null);
  const canRemove = detail ? removable(detail.record, (coin) => spentCoins.has(coin)) : null;
  const closeRemove = () => {
    if (removing) focusRow(removing.key);
    setRemoving(null);
    setRemoveError(null);
  };
  const remove = async () => {
    if (!account || !removing) return;
    // Focus goes to the row that takes its place, or else to History's heading.
    const at = entries.findIndex((e) => e.record.key === removing.key);
    const next = (entries[at + 1] ?? entries[at - 1])?.record.key;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await services.sendService(account.id).remove(removing);
    } catch (e) {
      setRemoveError((e as Error).message);
      return;
    } finally {
      setRemoveBusy(false);
    }
    setRemoving(null);
    await refresh();
    if (next && rowRefs.current.has(next)) focusRow(next);
    else setTimeout(() => historyTitle.current?.focus(), 0);
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
  // Not one a block confirmed before that block was rolled back: it went through once.
  const isStuck = (h: HistoryRecord) =>
    h.kind === 'sent' && h.status === 'pending' && h.key.includes(':sent:') && !h.rolledBack && Date.now() - (h.stampMs ?? h.timestampMs) > MEMPOOL_KEEPS_MS && nodeHolds(h) !== 'has';
  /** A pending send's words: waiting again when a block had confirmed it and was then rolled back. */
  const waitingOf = (h: HistoryRecord) => (h.rolledBack ? `${WAITING_FOR_BLOCK} again` : WAITING_FOR_BLOCK);
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
  // How far a long pass has got, and how long the rest should take at the
  // pace measured since it was first seen here: from 15 s in, so one slow
  // first request does not set it. A short catch-up says neither.
  const pace = useRef<{ phase: string; at: number; done: number } | null>(null);
  const work = (sync?.phase === 'scanning' || sync?.phase === 'restoring') && sync.work && sync.work.total >= 20 ? sync.work : null;
  if (!work || !sync) pace.current = null;
  else if (!pace.current || pace.current.phase !== sync.phase || work.done < pace.current.done) pace.current = { phase: sync.phase, at: Date.now(), done: work.done };
  const elapsedMs = pace.current ? Date.now() - pace.current.at : 0;
  const leftS = work && pace.current && elapsedMs >= 15_000 && work.done > pace.current.done ? ((work.total - work.done) * elapsedMs) / (work.done - pace.current.done) / 1000 : null;
  const progressText = work ? ` · ${Math.min(99, Math.floor((100 * work.done) / work.total))}%${leftS !== null ? ` · ${formatAbout(leftS)} left` : ''}` : '';
  const syncText =
    sync === null
      ? 'Not synced yet'
      : sync.phase === 'checking'
        ? 'Checking the chain'
        : sync.phase === 'restoring'
          ? (sync.message ?? 'Finding your payments') + progressText
          : sync.phase === 'scanning'
          ? `Scanning block ${showBlock(sync.syncedHeight)} of ${showBlock(sync.tipHeight)}${progressText}`
          : sync.phase === 'done'
            ? behind
              ? `Synced to block ${showBlock(sync.tipHeight)}, but that block is ${Math.round(behindMs / 3_600_000)} h old, so the node may be behind`
              : `Up to date · block ${showBlock(sync.syncedHeight)}${lastSyncedAt ? ` · ${timeAgo(lastSyncedAt)}` : ''}`
            : sync.message ?? 'Sync failed';
  // What the status line says is announced after the person asked for a
  // sync, and a payment arriving is announced as it arrives: once each, in
  // a region that is always there, never on every render.
  const [said, setSaid] = useState('');
  // While all is well the status is a chip; the block and the time are a tap away.
  const calmStatus = online && sync?.phase === 'done' && !behind;
  const [statusOpen, setStatusOpen] = useState(false);
  const asked = useRef(false);
  const askSync = () => {
    asked.current = true;
    void syncNow();
  };
  // In the phone apps a pull down from the top syncs, as Sync does.
  const pull = usePullToSync(MOBILE && online, () => {
    if (!busy) askSync();
  });
  // Unasked, the end of a restore or a long scan is said too, and so is a
  // sync that fails or going offline, once each until something else is said.
  const longRun = useRef(false);
  const failureSaid = useRef('');
  useEffect(() => {
    if (sync?.phase === 'restoring' || (sync?.phase === 'scanning' && sync.tipHeight - sync.syncedHeight > 100)) longRun.current = true;
    const failed = !online ? 'You are offline. The balance shown is from the last sync.' : sync?.phase === 'error' ? syncText : '';
    if (asked.current && (sync?.phase === 'done' || failed)) {
      asked.current = false;
      longRun.current = false;
      failureSaid.current = failed;
      setSaid(failed || syncText);
    } else if (sync?.phase === 'done' && longRun.current) {
      longRun.current = false;
      failureSaid.current = '';
      setSaid(syncText);
    } else if (failed && failed !== failureSaid.current) {
      failureSaid.current = failed;
      setSaid(failed);
    } else if (!failed) {
      failureSaid.current = '';
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
  // And when a block confirms a payment seen on its way here, that is said
  // too: the confirmed total rising within a quarter of an hour of a pending
  // one (a pending row and its confirmed row do not share a key; a restore
  // or a rescan finding old payments is not news).
  const receivedNau = history.filter((h) => h.kind === 'received' && h.status === 'confirmed').reduce((sum, h) => sum + BigInt(h.amountNau), 0n);
  const incomingAt = useRef(0);
  useEffect(() => {
    if (incomingNau > 0n) incomingAt.current = Date.now();
  }, [incomingNau]);
  const receivedSeen = useRef<bigint | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (receivedSeen.current !== null && receivedNau > receivedSeen.current && Date.now() - incomingAt.current < 15 * 60_000) {
      setSaid(hidden ? 'A payment to you is confirmed.' : `${speakNau(receivedNau - receivedSeen.current)} NPT received.`);
    }
    receivedSeen.current = receivedNau;
  }, [receivedNau, loaded, hidden]);
  // The sentence behind the readings under the balance opens from an ⓘ at
  // the end of the last one. A pending send without change shows no
  // reading; a link opens it then.
  const readings = [incomingNau > 0n && 'incoming', loaded && ownReady && onHoldNau > 0n && 'held', balance.lockedNau > 0n && 'locked'].filter(Boolean);
  const explained = incomingNau > 0n || balance.reservedNau > 0n || balance.lockedNau > 0n;
  const explainAfter = (reading: string) =>
    explained && readings[readings.length - 1] === reading ? (
      <Tooltip label="What does this mean?" interactive>
        <ActionIcon variant="transparent" size="sm" className="vault-tap vault-info-button" aria-label="What does this mean?" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
          <IconInfoCircle size={16} />
        </ActionIcon>
      </Tooltip>
    ) : null;
  /** A send that failed, or was given up on and can no longer go through: nothing left the wallet. */
  const notSent = (e: HistoryEntry) => e.kind !== 'received' && e.record.status === 'failed' && !stillGoes(e.record);
  /** A send given up on, or expired, that may still go through: nothing has left the wallet yet. */
  const mayGo = (e: HistoryEntry) => e.kind !== 'received' && stillGoes(e.record);
  /** The payments of a send built here, when it paid more than one recipient. */
  const severalOf = (e: HistoryEntry) => ((e.record.payments?.length ?? 0) > 1 ? (e.record.payments ?? []) : null);
  // A row says who, when and how much. Who: the contact a send went to, the
  // name of the address a payment came in through, or how many a send paid;
  // without one, the title says what happened. The line under it is the
  // time, the state only while it is not final and the title does not
  // already say it, and the note, last, so a long one is what the line cuts
  // short. Block counts and the fee are in the sheet.
  const whoOf = (e: HistoryEntry): string | null => {
    if (e.kind === 'received') return labelOf(e.record);
    if (e.kind === 'self' || e.record.txid === '' || e.record.recipient === null) return null;
    const several = severalOf(e);
    if (several) return `${several.length} recipients`;
    return contactFor(e.record.recipient)?.name ?? null;
  };
  /** A send's note to self, or the person's note on a payment received, when it has one. */
  const noteOf = (e: HistoryEntry): string | null => {
    if (e.kind !== 'received') return sentNoteOf(e.record, sentNotes);
    const coin = receivedCoinOf(e.record);
    return coin ? (receivedNotes[coin] ?? null) : null;
  };
  /** What happened, in a word or two: a send reads Sent once the node has it (with Waiting for a block beside its time until a block confirms it), or Not going through once nodes dropped it. */
  const stateTitleOf = (e: HistoryEntry): string => {
    if (mayGo(e)) return e.record.expired ? 'Expired' : 'Given up';
    if (notSent(e)) return 'Not sent';
    if (e.kind === 'received') return e.record.status === 'failed' ? 'Failed' : 'Received';
    if (e.kind === 'self') return e.record.status === 'pending' ? 'Moving to yourself' : 'Moved to yourself';
    if (isStuck(e.record)) return 'Not going through';
    return 'Sent';
  };
  /**
   * The state beside the time, unless the title already says it: in the
   * row's own muted colour while it simply waits for a block (Waiting for a
   * block, Pending), amber where something is asked of the person (Not
   * going through) or a send given up on may still go through, red where
   * it did not happen.
   */
  const stateWordOf = (e: HistoryEntry): { word: string; tone: 'muted' | 'warn' | 'failed' } | null => {
    // A send waiting for a block says so even where its title is the state: the title says only Sent.
    if (e.kind === 'sent' && e.record.status === 'pending' && !notSent(e) && !isStuck(e.record)) return { word: waitingOf(e.record), tone: 'muted' };
    const saidInTitle = !whoOf(e) && e.kind !== 'received';
    if (mayGo(e)) return { word: saidInTitle ? 'May still go through' : `${e.record.expired ? 'Expired' : 'Given up'}: may still go through`, tone: 'warn' };
    if (saidInTitle) return null;
    if (notSent(e)) return { word: 'Not sent', tone: 'failed' };
    if (e.record.status === 'pending') {
      if (e.kind === 'received') return { word: 'Pending', tone: 'muted' };
      if (isStuck(e.record)) return { word: 'Not going through', tone: 'warn' };
      return { word: waitingOf(e.record), tone: 'muted' };
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
  /** A send to a contact starts with the contact's circle, the direction as its badge; any other row with its direction in a plain circle. */
  const rowAvatarOf = (e: HistoryEntry) => {
    const contact = e.kind === 'sent' && !severalOf(e) && e.record.recipient ? contactFor(e.record.recipient) : undefined;
    if (contact) return <Avatar name={contact.name} address={contact.address} badge={<IconArrowUpRight size={16} />} />;
    return <span className={`vault-row-icon${e.kind === 'received' ? '' : ' out'}`}>{rowIconOf(e)}</span>;
  };
  /** What a screen reader says for a row, list or table alike. */
  const rowLabelOf = (e: HistoryEntry) => {
    const who = whoOf(e);
    const whom = !who ? '' : e.kind === 'received' ? `, ${who}'s address` : `, to ${who}`;
    const money = notSent(e) || mayGo(e) ? `${spoken(e.shownNau)} NPT, not taken from your balance` : `${e.kind === 'received' ? 'plus' : 'minus'} ${spoken(e.shownNau)} NPT`;
    // A send says its state in its first word (Sent, Not sent, Given up), and that it waits for a block or may still go through; a payment in says pending.
    const word = stateWordOf(e)?.word ?? '';
    const pending = mayGo(e) ? ', may still go through' : e.record.status !== 'pending' ? '' : e.kind === 'received' ? ', pending' : word.startsWith(WAITING_FOR_BLOCK) ? `, ${word.toLowerCase()}` : '';
    const release = lockOf(e.record);
    const note = noteOf(e);
    // When, as the list shows it by its day heading and the row's time: rows alike in all else are told apart.
    const when = `${dayLabel(e.record.timestampMs)} ${formatTime(e.record.timestampMs)}`;
    return `${stateTitleOf(e)}${whom}, ${money}${pending}${release !== null ? `, spendable from ${showDate(release)}` : ''}${note ? `, note: ${note}` : ''}, ${when}, details`;
  };
  /** The full title, for the detail sheet and for screen readers. */
  const titleOf = (e: HistoryEntry) => {
    const word = stateTitleOf(e);
    if (e.kind !== 'sent' || notSent(e) || mayGo(e) || e.record.txid === '' || e.record.recipient === null) return word;
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

  // Where a payment stands, under its amount in the details: confirmed, and
  // how many blocks have come since (what "wait for several blocks" is
  // counted in), or a payment still coming in, as a pill. A send on its way
  // shows its steps instead (SendSteps). One that did not go out is named
  // by its title already ("Not sent", "Given up"); a sentence says why.
  const stateOf = (h: HistoryRecord): { pill: string; tone: 'ok' | 'wait' } | { note: string; tone: 'warn' | 'bad' } | null => {
    const since = blocksSince(h);
    if (h.status === 'confirmed') {
      const block = h.height !== null ? showBlock(h.height) : null;
      const pill =
        block === null
          ? 'Confirmed'
          : since === null
            ? `Confirmed in block ${block}`
            : since === 0
              ? `Confirmed in the newest block · block ${block}`
              : `Confirmed ${showBlock(since)} ${since === 1 ? 'block' : 'blocks'} ago · block ${block}`;
      return { pill, tone: 'ok' };
    }
    if (h.status === 'pending') return h.kind === 'received' ? { pill: 'Pending', tone: 'wait' } : null;
    if (h.kind !== 'sent') return null;
    if (stillGoes(h)) return { note: 'It may still go through: until one of its coins is spent, a block can take it, and then it shows here as Sent.', tone: 'warn' };
    return { note: h.givenUp || h.expired ? 'One of its coins has since been spent by another transaction, so it can no longer go through.' : 'Nothing left this wallet.', tone: 'bad' };
  };
  /** The figure at the top of the details: what came in, or what a send paid, its fee apart. */
  const headNauOf = (e: HistoryEntry) => (e.kind === 'received' ? e.shownNau : BigInt(e.record.amountNau));
  /** The circle at the top of the details, as on the row: a contact's, or the direction in a plain one. */
  const headCircleOf = (e: HistoryEntry) => {
    const contact = e.kind === 'sent' && !severalOf(e) && e.record.recipient ? contactFor(e.record.recipient) : undefined;
    if (contact) return <Avatar big name={contact.name} address={contact.address} badge={<IconArrowUpRight size={16} />} />;
    return <span className={`vault-row-icon${e.kind === 'received' ? '' : ' out'}`}>{rowIconOf(e)}</span>;
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
      {/* The pull's mark, out of sight under the header until a pull brings it down, turning as it comes. */}
      {MOBILE && (
        <div
          className="vault-pull"
          data-pulling={pull.pulled > 0 || undefined}
          data-ready={pull.ready || undefined}
          style={{ '--pulled': `${pull.pulled}px`, '--pull': Math.min(1, pull.pulled / PULL_READY_PX) } as CSSProperties}
          aria-hidden
        >
          <IconRefresh size={20} />
        </div>
      )}
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
        {calmStatus ? (
          <button type="button" className="vault-status-chip" aria-expanded={statusOpen} onClick={() => setStatusOpen((v) => !v)}>
            <span className="vault-status-pill">
              <span className="vault-status-dot ok" aria-hidden />
              <Spoken text={statusOpen ? syncText : 'Up to date'} />
            </span>
          </button>
        ) : (
          <span className="vault-status-text">
            <span className={`vault-status-dot ${!online || sync?.phase === 'error' ? 'bad' : sync?.phase === 'done' ? (behind ? 'warn' : 'ok') : 'busy'}`} aria-hidden />
            {!online && <IconWifiOff size={16} />}
            {busy && <IconRefresh size={16} className="vault-spin" />}
            <Spoken text={syncText} />
          </span>
        )}
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
        <Text size="sm" c="dimmed" mt={-8}>
          {screenAwake === 'held' ? 'Keep the app open until the scan finishes. It pauses if the wallet locks, and goes on at the next unlock.' : 'Keep the app open with the screen on: the scan pauses when the screen turns off, and goes on at the next unlock.'}
        </Text>
      )}
      {/* On a phone a card, the actions under the balance; on a wide screen a
          band, the actions to its right. */}
      <Paper className="vault-balance-card">
        <div className="vault-balance-layout">
          <Stack gap="xs">
            {/* The eye keeps its 40 px target but is pulled into the row's
                margins, so the label sits where every other card's title does.
                One name, and the pressed state says whether amounts are hidden. */}
            <div className="vault-balance-head">
              <span className="vault-eyebrow">Balance</span>
              <Tooltip label={hidden ? 'Show amounts' : 'Hide amounts'} interactive>
                <ActionIcon variant="subtle" size="lg" className="vault-tap" my={-10} mr={-8} aria-label="Hide amounts" aria-pressed={hidden} onClick={toggleHidden}>
                  {hidden ? <IconEyeOff size={20} /> : <IconEye size={20} />}
                </ActionIcon>
              </Tooltip>
            </div>
            {/* The figure on screen is grouped; a screen reader is given plain digits, or "hidden". */}
            <div className="vault-balance">
              <span aria-hidden>
                {loaded && ownReady ? <Figure text={balanceText} /> : '…'} <span className="vault-unit">NPT</span>
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
                  ≈ <Spoken text={hidden ? '••••' : fiat.figure} /> <span className="vault-unit">{fiat.code}</span>
                </span>
                {Date.now() - quote.at > QUOTE_OLD_MS && <span className="vault-balance-fiat-source">price from <Spoken text={timeAgo(quote.at)} /></span>}
              </div>
            )}
            {/* Money on the way and money held, as two readings; the sentence behind them is one tap away. */}
            {incomingNau > 0n && (
              <Group gap={6} wrap="nowrap">
                <IconArrowDownLeft size={16} className="vault-balance-note-in" aria-hidden />
                <Text size="sm" c="dimmed">
                  <span className="vault-figure"><Spoken text={amount(incomingNau)} /></span> NPT pending
                  {explainAfter('incoming')}
                </Text>
              </Group>
            )}
            {/* The two figures add up to the balance above. */}
            {loaded && ownReady && onHoldNau > 0n && (
              <Group gap={6} wrap="nowrap" align="flex-start">
                <IconHourglass size={16} className="vault-balance-note-held" aria-hidden style={{ marginTop: 4 }} />
                <Text size="sm" c="dimmed">
                  Spendable <span className="vault-figure"><Spoken text={amount(balance.spendableNau)} /></span> NPT · <span className="vault-figure"><Spoken text={amount(onHoldNau)} /></span> NPT on hold
                  {explainAfter('held')}
                </Text>
              </Group>
            )}
            {balance.lockedNau > 0n && (
              <Group gap={6} wrap="nowrap">
                <IconClockPause size={16} className="vault-balance-note-held" aria-hidden />
                <Text size="sm" c="dimmed">
                  <span className="vault-figure"><Spoken text={amount(balance.lockedNau)} /></span> NPT {balance.nextReleaseMs ? `spendable from ${showDate(balance.nextReleaseMs)}` : 'not spendable yet'}
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
                    {incomingNau > 0n && <Spoken text={`${amount(incomingNau)} NPT is pending: it becomes spendable once a block confirms it. `} />}
                    {balance.lockedNau > 0n && <Spoken text={`${amount(balance.lockedNau)} NPT is yours, but the sender set a date before which it cannot be spent, so it is not counted as spendable. `} />}
                    {balance.reservedNau > 0n && <Spoken text={`${pendingExplained()} `} />}
                  </Text>
                )}
              </>
            )}
          </Stack>
          <div className="vault-balance-actions">
            <Button className="vault-pill" leftSection={<IconArrowUpRight size={16} />} onClick={() => navigate('/send')}>
              Send
            </Button>
            <Button className="vault-pill" variant="light" leftSection={<IconArrowDownLeft size={16} />} onClick={() => navigate('/receive')}>
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
                Your <Spoken text={amount(BigInt(lastSend.amountNau))} /> NPT to {who} {MAY_HAVE_GONE_OUT}
              </span>
            </Caution>
          ) : (
            <Info title={SENT_WAITING} onClose={dismiss} closeLabel="Dismiss">
              <span>
                <Spoken text={amount(BigInt(lastSend.amountNau))} /> NPT to {who}, plus a <Spoken text={amount(BigInt(lastSend.feeNau))} /> NPT fee. {SENDING_UNTIL_CONFIRMED}
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
            <Spoken text={hidden ? '••••' : failure.amount} /> NPT to <bdi>{contactFor(failure.recipient.toLowerCase())?.name ?? abbreviateAddress(failure.recipient)}</bdi>
            {failure.others ? ` and ${failure.others} more` : ''}. {notSentReason(failure.message)}
          </Text>
          {/* While the send is still known in full (not after a reload), Send can take it up again. */}
          {sendJob?.ending === 'failed' && (
            <UnstyledButton onClick={() => navigate('/send', { state: { refill: true } })} c="var(--v-accent-text)" fz="sm" display="block" mt={4} className="vault-tap-link vault-tap-link-start">
              Fill in the form again
            </UnstyledButton>
          )}
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
            Giving up on your <Spoken text={amount(BigInt(stuck.amountNau))} />&nbsp;NPT to {stuck.recipient ? <bdi>{contactFor(stuck.recipient)?.name ?? abbreviateAddress(stuck.recipient)}</bdi> : 'a recipient'} makes <Spoken text={amount(reservedFor(stuck))} />&nbsp;NPT spendable now; otherwise it becomes spendable {dayAhead(expiresAt(stuck)).replace(/ (?=\S+$)/, ' ')}.
          </span>
          <Group mt={4}>
            <Button variant="light" size="compact-sm" className="vault-tap" onClick={() => setGivingUp(stuck)}>
              Give up on this send
            </Button>
          </Group>
        </Caution>
      )}
      {/* One notice at a time: while the backup warning above shows, the install offer waits, and the storage warning shows only where there is no install offer. */}
      {!showBackupNudge && <InstallNudge />}
      {!showBackupNudge && <StorageNotice />}

      <Paper>
        <Stack>
        <Title order={3} ref={historyTitle} tabIndex={-1}>
          History
        </Title>
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
            // As a wallet starts: what happens next, and the way to begin.
            <div className="vault-empty">
              <svg className="vault-empty-art" viewBox="0 0 140 104" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="70" cy="54" r="24" fill="var(--v-accent-soft)" />
                <path d="M57 45a14 14 0 0 1 17 -6" strokeOpacity="0.55" />
                <ellipse cx="70" cy="54" rx="54" ry="15" transform="rotate(-14 70 54)" strokeOpacity="0.75" />
                <circle cx="121" cy="40" r="4.5" fill="currentColor" stroke="none" />
                <circle cx="24" cy="72" r="2.5" fill="currentColor" stroke="none" opacity="0.6" />
              </svg>
              <Text fw={600}>Your wallet is ready</Text>
              <Text c="dimmed" size="sm" maw={320}>
                Share your address. A payment shows here as soon as the node sees it, and is confirmed by the next block, usually within about 10 minutes.
              </Text>
              <Button mt={4} leftSection={<IconArrowDownLeft size={16} />} onClick={() => navigate('/receive')}>
                Receive
              </Button>
              {account && <SearchedFrom account={account} />}
            </div>
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
                        className={arrived.has(h.key) ? 'vault-row vault-row-button vault-row-arrived' : 'vault-row vault-row-button'}
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
                        <Group gap="sm" wrap="nowrap" className="vault-row-who">
                          {rowAvatarOf(e)}
                          <div style={{ minWidth: 0 }}>
                            {/* A send not going through says so in its title when nothing else names it, in the caution colour. */}
                            <Text size="sm" fw={600} className={!whoOf(e) && isStuck(h) ? 'vault-row-title vault-state-warn' : 'vault-row-title'}>
                              {whoOf(e) ? <bdi>{whoOf(e)}</bdi> : stateTitleOf(e)}
                            </Text>
                            <Text size="xs" c="dimmed" className="vault-row-meta vault-tabular">
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
                              {noteOf(e) && (
                                <>
                                  {' · '}
                                  <bdi>{noteOf(e)}</bdi>
                                </>
                              )}
                            </Text>
                          </div>
                        </Group>
                        <div className="vault-row-amount">
                          {/* Nothing left the wallet: the figure is struck through, with no sign. A send that may
                              still go through has not left it either, but may: dimmed, with no sign, not struck through. */}
                          <Text size="sm" fw={600} c={notSent(e) || mayGo(e) ? 'dimmed' : undefined} td={notSent(e) ? 'line-through' : undefined} className={incoming ? 'vault-amount-in vault-tabular' : 'vault-tabular'}>
                            {notSent(e) || mayGo(e) ? '' : incoming ? '+' : '−'}
                            <Figure text={amount(e.shownNau)} />{' '}
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
              <UnstyledButton
                c="var(--v-accent-text)"
                fz="sm"
                display="flex"
                w="fit-content"
                mt={4}
                className="vault-tap-link vault-tap-link-start"
                onClick={() => {
                  firstNew.current = entries[shown]?.record.key ?? null;
                  setShown((n) => n + PAGE);
                }}
              >
                Show {Math.min(PAGE, entries.length - shown)} older
              </UnstyledButton>
            )}
          </div>
        )}
        </Stack>
      </Paper>

      {/* The title is the dialog's name; on screen it is part of the receipt's head. */}
      <Sheet opened={detail !== null} onClose={() => setDetail(null)} title={detail ? titleOf(detail) : ''} classNames={{ title: 'sr-only', header: 'vault-close-end' }}>
        {detail && (
          <Stack gap="sm">
            {/* Opens as the review and the sent moment do: who, how much,
                large, and where it stands. A send on its way shows the
                steps it takes. */}
            <div className="vault-receipt vault-detail-head">
              {headCircleOf(detail)}
              <Text fw={600} c="var(--v-text-2)" aria-hidden>
                <bdi>{titleOf(detail)}</bdi>
              </Text>
              {/* Nothing left the wallet: struck through, as on its row; one that may still go through, dimmed. */}
              <div className={notSent(detail) ? 'vault-receipt-amount struck' : mayGo(detail) ? 'vault-receipt-amount dim' : 'vault-receipt-amount'}>
                <Amount nau={headNauOf(detail)} hidden={hidden} />
              </div>
              {detail.record.kind === 'sent' && detail.record.status === 'pending' ? (
                <SendSteps sentAt={detail.record.timestampMs} stuck={isStuck(detail.record)} again={Boolean(detail.record.rolledBack)} />
              ) : (
                (() => {
                  const state = stateOf(detail.record);
                  if (!state) return null;
                  return 'pill' in state ? (
                    <span className={`vault-receipt-state ${state.tone}`}>
                      {state.tone === 'ok' ? <IconCheck size={16} aria-hidden /> : <IconHourglass size={16} aria-hidden />}
                      {state.pill}
                    </span>
                  ) : (
                    <Text size="sm" className={state.tone === 'warn' ? 'vault-state-warn' : 'vault-state-failed'} maw={340}>
                      {state.note}
                    </Text>
                  );
                })()
              )}
            </div>
            <DetailRow label="When" value={formatDateTime(detail.record.timestampMs)} />
            {/* The fee and the total, as the review showed them, the total set off beneath. */}
            {detail.kind !== 'received' && detail.record.feeNau && (
              <div className="vault-review">
                <ReceiptRow label="Fee" figure={amount(BigInt(detail.record.feeNau))} />
                {/* What left the wallet. When some of it paid this wallet's own addresses, the amounts and the fee add up to more than what left, so the row says which it is. */}
                {detail.kind === 'sent' && <ReceiptRow total label={detail.ownPayments.length > 0 ? 'Left this wallet' : 'Total'} figure={amount(detail.shownNau)} />}
              </div>
            )}
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
                    copyName={`Copy the address of recipient ${i + 1}`}
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
                copyName="Copy the recipient's address"
              />
            )}
            {detail.kind === 'sent' && !detail.record.recipient && (
              <DetailRow label="Recipient" value="Not recorded. The send was made on another device or before a restore, so the amount above includes the fee." />
            )}
            {/* A note can be added or changed once the payment's coin is known; until then it is only shown. */}
            {account && detail.kind === 'received' && receivedCoinOf(detail.record) ? (
              <NoteEditor
                key={detail.record.key}
                note={noteOf(detail)}
                onSave={async (text: string) => setReceivedNotes(await writeReceivedNote(services.core, services.accounts.engine, account.id, receivedCoinOf(detail.record)!, text))}
              />
            ) : account && detail.kind !== 'received' && sentCoinOf(detail.record) ? (
              <NoteEditor key={detail.record.key} note={noteOf(detail)} onSave={async (text: string) => setSentNotes(await writeSentNote(services.core, services.accounts.engine, account.id, detail.record, text))} />
            ) : (
              noteOf(detail) && <DetailRow label="Note" value={noteOf(detail) as string} isolate />
            )}
            {(detail.record.expired ? EXPIRED_NOTE : detail.record.error) && <DetailRow label="What happened" value={detail.record.expired ? EXPIRED_NOTE : (detail.record.error as string)} />}
            {(outputsOf(detail).length > 0 || nodeStatusOf(detail.record) !== null || (detail.kind !== 'received' && detail.changeNau !== null && detail.changeNau > 0n)) && (
              <>
                {/* A section of the sheet, not a link beside the address's own
                    link: a line above it, the muted colour, a chevron that turns. */}
                <UnstyledButton onClick={() => setTech((v) => !v)} className="vault-detail-section" aria-expanded={tech}>
                  <IconChevronRight size={16} aria-hidden className={tech ? 'vault-chevron open' : 'vault-chevron'} />
                  <span>Technical details</span>
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
                    <DetailRow key={o.commitment} label={o.label} value={o.commitment} mono copy="Identifier copied" copyName={`Copy the identifier of ${o.label.toLowerCase()}`} href={explorer ? explorer + o.commitment : undefined} />
                  ))}
              </>
            )}
            {/* Calm, as on Home's notice: the dialog it opens says why and holds the red button. */}
            {detail.kind !== 'received' && detail.record.status === 'pending' && (
              <Button
                variant="light"
                mt={4}
                onClick={() => {
                  setGivingUp(detail.record);
                  setDetail(null);
                }}
              >
                Give up on this send
              </Button>
            )}
            {/* Once it can no longer go through, a send that was not sent can go; until then, it stays. */}
            {canRemove !== null &&
              (canRemove ? (
                <Button
                  variant="light"
                  mt={4}
                  onClick={() => {
                    setRemoving(detail.record);
                    setDetail(null);
                  }}
                >
                  Remove from History
                </Button>
              ) : (
                <Text size="sm" c="dimmed">
                  It stays in History while it can still go through: until one of its coins is spent.
                </Text>
              ))}
          </Stack>
        )}
      </Sheet>

      <Sheet opened={removing !== null} onClose={closeRemove} returnFocus={false} title="Remove from History?">
        {removing && (
          <Stack>
            <Text size="sm">This send was not sent and can no longer go through, so removing it changes nothing in your balance. Its amount, recipient and note go with it.</Text>
            <Group grow>
              <Button variant="default" onClick={closeRemove}>
                Cancel
              </Button>
              <Button color="red" loading={removeBusy} onClick={() => void remove()}>
                {removeError ? 'Try again' : 'Remove'}
              </Button>
            </Group>
            {removeError && <ErrorLine title="It was not removed">{removeError}</ErrorLine>}
          </Stack>
        )}
      </Sheet>

      <Sheet opened={givingUp !== null} onClose={closeGiveUp} returnFocus={false} title={nothingToGiveUp ? 'Nothing to give up' : 'Give up on this send?'}>
        {givingUpNow &&
          (nothingToGiveUp ? (
            <Stack>
              <Text size="sm">
                {givingUpNow.status === 'confirmed'
                  ? 'A block has just confirmed this send, so it went through and there is nothing to give up. History shows it as Sent.'
                  : 'This send is no longer waiting for a block, so there is nothing to give up. History shows what became of it.'}
              </Text>
              <Group grow>
                <Button variant="default" onClick={closeGiveUp}>
                  Close
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack>
              <Text size="sm">
                {nodeHolds(givingUpNow) === 'has'
                  ? 'The node still has this send, so it may still go through. Giving up makes its coins spendable here, but if it confirms anyway, it shows up as Sent.'
                  : nodeHolds(givingUpNow) === null
                    ? 'Giving up makes its coins spendable, but it does not call the send back: it stays in History as Given up, and if it confirms anyway, it shows up as Sent.'
                    : 'The node no longer has this send. Giving up makes its coins spendable, and the send stays in History as Given up until one of its coins is spent.'}{' '}
                Your next send, to anyone, spends one of its coins, so the two cannot both go through.
              </Text>
              <Text size="sm" c="dimmed">
                <Spoken text={`This send: ${showNau(BigInt(givingUpNow.amountNau))} NPT${givingUpNow.feeNau ? ` plus a ${showNau(BigInt(givingUpNow.feeNau))} NPT fee` : ''}. Giving up makes ${showNau(reservedFor(givingUpNow))} NPT spendable again.`} />
              </Text>
              <Group grow>
                <Button variant="default" onClick={closeGiveUp}>
                  Cancel
                </Button>
                <Button color="red" loading={giveUpBusy} onClick={() => void giveUp()}>
                  {giveUpError ? 'Try again' : 'Give up'}
                </Button>
              </Group>
              {giveUpError && <ErrorLine title="This send was not given up">{giveUpError}</ErrorLine>}
            </Stack>
          ))}
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
        <Spoken text={figure} /> <span className="vault-unit">NPT</span>
      </b>
    </div>
  );
}

/**
 * A send on its way, as the steps it takes: proved on this device and
 * handed to the node (the send is kept from then on), then in a block. A
 * send the node no longer keeps stops at the last step, in the caution
 * colour, in the words its row uses.
 */
function SendSteps({ sentAt, stuck, again }: { sentAt: number; stuck: boolean; again: boolean }) {
  const time = formatTime(sentAt);
  return (
    <>
      <ol className="vault-steps vault-send-steps">
        <li className="done">
          <IconCircleCheck size={20} aria-hidden />
          <span>
            Signed and proved<span className="sr-only">, done</span>
          </span>
          <span className="vault-step-when">{time}</span>
        </li>
        <li className="done">
          <IconCircleCheck size={20} aria-hidden />
          <span>
            Taken by the node<span className="sr-only">, done</span>
          </span>
          <span className="vault-step-when">{time}</span>
        </li>
        {stuck ? (
          <li className="warn" aria-current="step">
            <IconAlertCircle size={20} aria-hidden />
            <span>Not going through</span>
          </li>
        ) : (
          <li className="now" aria-current="step">
            <IconCircleDot size={20} aria-hidden />
            <span>In a block</span>
            <span className="vault-step-when">{again ? 'again, usually within an hour' : 'usually within an hour'}</span>
          </li>
        )}
      </ol>
      {again && (
        <Text size="sm" c="dimmed">
          A block had confirmed it, but that block is no longer on the node's chain.
        </Text>
      )}
    </>
  );
}

/** A label and its value in the detail sheet; long values wrap and can be copied. */
function DetailRow({ label, value, mono, copy, copyName, href, abbreviate, isolate }: { label: string; value: string; mono?: boolean; copy?: string; copyName?: string; href?: string; abbreviate?: boolean; isolate?: boolean }) {
  // Long values (a generation address is about 3,500 characters) show
  // abbreviated with a toggle; copying always takes the full value.
  const [full, setFull] = useState(false);
  const shown = abbreviate && !full ? abbreviateAddress(value) : value;
  return (
    <div className="vault-detail-row">
      <Text size="sm" c="dimmed" className="vault-detail-label">
        <Spoken text={label} />
      </Text>
      {/* Copy and the explorer sit on the line they act on. */}
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <Text size="sm" className={mono ? 'vault-detail-mono vault-tabular' : isolate ? 'vault-bidi vault-link-meta-text vault-tabular' : 'vault-tabular'} dir={isolate ? 'auto' : undefined} style={{ minWidth: 0 }}>
          <Spoken text={shown} />
        </Text>
        {(copy || href) && (
          <Group gap={2} wrap="nowrap" className="vault-detail-actions">
            {copy && (
              <Tooltip label="Copy" interactive>
                <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label={copyName ?? `Copy ${spokenText(label.toLowerCase())}`} onClick={() => void copyText(value, copy)}>
                  <IconCopy size={20} />
                </ActionIcon>
              </Tooltip>
            )}
            {href && (
              <Tooltip label="Open in the explorer" interactive>
                <ActionIcon component="a" href={href} target="_blank" rel="noreferrer" variant="subtle" size="lg" className="vault-tap" aria-label={`Open ${spokenText(label.toLowerCase())} in the explorer`}>
                  <IconExternalLink size={20} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        )}
      </Group>
      {abbreviate && (
        // Named for its row too: a send to several people shows one per recipient.
        <UnstyledButton
          onClick={() => setFull((v) => !v)}
          aria-label={`${full ? 'Hide' : 'Show'} full address, ${spokenText(label)}`}
          c="var(--v-accent-text)"
          fz="sm"
          className="vault-tap-link vault-tap-link-start"
        >
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
        <Button
          variant="light"
          size="compact-sm"
          className="vault-tap"
          loading={busy}
          onClick={(e) => {
            // The notice goes once the rebuild starts.
            const heading = headingNear(e.currentTarget);
            void rebuild().then(() => heading?.isConnected && heading.focus({ preventScroll: true }));
          }}
        >
          Rebuild from the chain
        </Button>
      </Group>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Caution>
  );
}

/**
 * Under an empty history: where this wallet looks for payments from. A
 * restore aimed at too late a date shows nothing, and this says how to look
 * further back. After a fast restore, which asks about the whole chain, it
 * says that instead. A wallet that starts on the day it was made, as one
 * from a new seed phrase does, has nothing older to look for: nothing.
 */
function SearchedFrom({ account }: { account: AccountRecord }) {
  const { services } = useApp();
  const navigate = useNavigate();
  // The start block's date: undefined while the node is asked, null when it cannot say.
  const [date, setDate] = useState<number | null | undefined>(undefined);
  const from = account.birthdayHeight;
  useEffect(() => {
    if (account.restoredAt || from <= 1) return;
    let live = true;
    void services
      .node()
      .blockHeaderAt(from)
      .then(
        (h) => live && setDate(h?.timestamp ?? null),
        () => live && setDate(null),
      );
    return () => {
      live = false;
    };
  }, [services, from, account.restoredAt]);
  if (account.restoredAt) {
    return (
      <Text c="dimmed" size="sm">
        A fast restore checked the whole chain and found no payments to this wallet.
      </Text>
    );
  }
  if (from <= 1 || date === undefined) return null;
  if (date !== null && dayKey(date) === dayKey(account.createdAt)) return null;
  return (
    <Text c="dimmed" size="sm">
      This wallet looks for payments from block <Spoken text={showBlock(from)} />
      {date ? ` (${formatDate(date)})` : ''}. Expecting an older one?{' '}
      <UnstyledButton onClick={() => navigate('/settings/advanced#rescan', { state: { from: 'home' } })} fz="sm" className="vault-inline-link">
        Rescan from an earlier date
      </UnstyledButton>
    </Text>
  );
}

/**
 * The person's note on a payment, in its details: Add note, or the note
 * with Edit; saved empty, it goes. Worded as a send's note on Send.
 */
function NoteEditor({ note, onSave }: { note: string | null; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form goes with Save or Cancel: the focus goes back to the button that opened it.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const backToButton = useRef(false);
  useEffect(() => {
    if (editing || !backToButton.current) return;
    backToButton.current = false;
    buttonRef.current?.focus();
  }, [editing]);
  const close = () => {
    backToButton.current = true;
    setEditing(false);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
      close();
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
          ref={buttonRef}
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
          <Button variant="default" onClick={close}>
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
