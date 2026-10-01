// App-wide state: the services, the current account, lock state, sync
// progress, and the derived balance and history. Screens subscribe here.

import { notifications } from '@mantine/notifications';
import { groupDigits, showInt } from '../util/format';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { byCreation, type AccountRecord, type HistoryRecord, type Network, type SendFailure, type UtxoRecord } from '../storage/db';
import type { ScanSettings, SendRequest } from '../backend/types';
import type { SyncEngine, SyncProgress } from '../wallet/sync';
import { paymentsTotalNau, RequiresLustrationError, SendBusyError, SendCancelledError, SendNotApprovedError, SendUnconfirmedError, type LastSend, type SendOutcome, type SendProgress } from './send';
import type { Services } from './services';
import { useScreenWakeLock, type WakeLockState } from './wakeLock';
import { clearSendDraft } from './sendDraft';
import { forgetOwnAddresses } from './ownAddresses';
import { notSentReason, SENDING_UNTIL_CONFIRMED } from './words';

/** A send in flight, or just finished; lives here so it survives the
 * Send screen unmounting when the app locks on backgrounding. */
export interface SendJob {
  request: SendRequest;
  startedAt: number;
  /** When proving began, so the elapsed time survives leaving the Send screen. */
  provingSince: number | null;
  progress: SendProgress;
  done: boolean;
  outcome: SendOutcome | null;
  error: string | null;
  /**
   * How it ended, once done: sent; handed to the node without an answer
   * (it may have gone through); stopped by the person before anything went
   * out; or failed with nothing sent.
   */
  ending: 'sent' | 'unconfirmed' | 'stopped' | 'failed' | null;
}

export interface Balance {
  /** Confirmed and spendable, in nau. */
  spendableNau: bigint;
  /** Reserved by pending outgoing transactions, in nau. */
  reservedNau: bigint;
  /** Owned but time-locked by whoever paid it: not spendable before its release date. */
  lockedNau: bigint;
  /** The earliest release among the locked coins, or null. */
  nextReleaseMs: number | null;
}

export interface AppState {
  services: Services;
  /** False until the stored account (if any) has been looked up. */
  ready: boolean;
  account: AccountRecord | null;
  locked: boolean;
  sync: SyncProgress | null;
  balance: Balance;
  history: HistoryRecord[];
  utxos: UtxoRecord[];
  /** Re-read account, balance and history from the database. */
  refresh: () => Promise<void>;
  /** False until the current account's coins and history have been read once. */
  loaded: boolean;
  /** Run one sync pass now (also runs on a timer while unlocked, as `auto`, which waits out a slow node). */
  syncNow: (options?: { auto?: boolean }) => Promise<void>;
  /**
   * Scan again from `height`: the running pass is stopped first, so the
   * local view is rebuilt from the new start and not from where the old
   * pass happened to be.
   */
  rescan: (height: number, fast?: boolean) => Promise<void>;
  /** When the last sync pass finished without error. */
  lastSyncedAt: number | null;
  /** The browser's own view of connectivity. */
  online: boolean;
  setAccount: (account: AccountRecord | null) => void;
  /** The selected network; accounts are bound to one. */
  network: Network;
  /** Lock, select the network, and show its account (or onboarding). */
  switchNetwork: (network: Network) => Promise<void>;
  /** The app is on this network now, its wallet already open (a backup file restored from another network). */
  adoptNetwork: (network: Network) => void;
  /** Lock and show another wallet, on whichever network it belongs to. */
  switchAccount: (accountId: string) => Promise<void>;
  /** Remove a wallet from this device and show the next one on its network, or onboarding. */
  removeAccount: (accountId: string) => Promise<void>;
  /** End the running sync pass, before the account changes under it. */
  pauseSync: () => Promise<void>;
  /** The running or last send. */
  sendJob: SendJob | null;
  /** Whether the screen is being kept on for the running send: 'refused' when the browser would not. */
  screenAwake: WakeLockState;
  /** Run a send as a job: screen kept on, auto-lock deferred, toast at the end. */
  /**
   * `note` is the person's note to self, kept with the send in History
   * on this device. With `confirm`, the send waits for `approveSend`
   * before anything reaches the node; the proof runs meanwhile.
   */
  startSend: (request: SendRequest, note?: string | null, options?: { confirm?: boolean }) => Promise<SendOutcome>;
  cancelSend: () => void;
  /** The running send waits for the person's confirmation (a password or passkey). */
  awaitingApproval: boolean;
  /** The person confirmed; the screen has checked the password or passkey. */
  approveSend: () => void;
  /** The person declined: the proof stops and nothing is sent. */
  declineSend: () => void;
  dismissSendJob: () => void;
  /** The current wallet's last failed send, while it is unlocked, until dismissed or a later send goes through. */
  sendFailure: SendFailure | null;
  dismissSendFailure: () => void;
  /** The current wallet's last send that reached the node, until dismissed or confirmed. */
  lastSend: LastSend | null;
  dismissLastSend: () => void;
  /** Look in the node's mempool for payments on their way in, now (Receive asks while it is open). */
  checkIncoming: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

const SYNC_INTERVAL_MS = 15_000;

export function AppProvider({ services, children }: { services: Services; children: ReactNode }) {
  const [account, setAccount] = useState<AccountRecord | null>(null);
  const [ready, setReady] = useState(false);
  const [lockedFlag, setLocked] = useState(true);
  // Unlocked means this wallet's keys are the ones loaded. The flag alone
  // is not trusted: if it ever disagreed with the account on screen, one
  // wallet's keys would scan, receive and send under another's name.
  const locked = lockedFlag || services.accounts.currentAccountId !== (account?.id ?? null);
  const [sync, setSync] = useState<SyncProgress | null>(null);
  const [utxos, setUtxos] = useState<UtxoRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const [lastSend, setLastSend] = useState<LastSend | null>(null);
  const [network, setNetwork] = useState<Network>(services.settings.network);
  const [sendJob, setSendJob] = useState<SendJob | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [online, setOnline] = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  const syncing = useRef(false);
  const engine = useRef<SyncEngine | null>(null);
  const syncRun = useRef<Promise<void> | null>(null);

  // End the running pass, if any, and wait for syncNow to let go.
  const stopSync = useCallback(async () => {
    await engine.current?.stop();
    await syncRun.current;
  }, []);

  const switchNetwork = useCallback(
    async (next: Network) => {
      await stopSync();
      await services.updateSettings({ network: next, currentAccountId: null });
      await services.accounts.lock();
      const all = byCreation(await services.db.getAllFromIndex('accounts', 'byNetwork', next));
      setAccount(all[0] ?? null);
      setNetwork(next);
    },
    [services, stopSync],
  );

  const switchAccount = useCallback(
    async (id: string) => {
      const record = await services.db.get('accounts', id);
      if (!record) return;
      await stopSync();
      await services.accounts.lock();
      await services.updateSettings({ network: record.network, currentAccountId: id });
      setNetwork(record.network);
      setAccount(record);
    },
    [services, stopSync],
  );

  const removeAccount = useCallback(
    async (id: string) => {
      const record = await services.db.get('accounts', id);
      if (!record) return;
      await stopSync();
      await services.accounts.deleteAccount(id);
      // The removal promises that nothing of the wallet stays on the device.
      // Its note about a failed send goes with its sealed log; an older
      // version may have left one in the settings, which goes too, and so
      // does the mempool watcher kept for it.
      if (services.settings.lastSendFailure?.accountId === id) await services.updateSettings({ lastSendFailure: undefined });
      services.forgetAccount(id);
      // What this session kept of it in memory: a half-filled send, and its addresses.
      clearSendDraft(id);
      forgetOwnAddresses(id);
      const rest = byCreation(await services.db.getAllFromIndex('accounts', 'byNetwork', record.network));
      const next = rest[0] ?? null;
      await services.updateSettings({ currentAccountId: next?.id ?? null });
      if (account?.id === id) setAccount(next);
    },
    [services, stopSync, account],
  );

  // Initial account: the one settings point at, else the only one on this network.
  useEffect(() => {
    void (async () => {
      const all = byCreation(await services.db.getAllFromIndex('accounts', 'byNetwork', services.settings.network));
      const chosen = all.find((a) => a.id === services.settings.currentAccountId) ?? all[0] ?? null;
      setAccount(chosen);
      setReady(true);
    })();
  }, [services]);

  // Without Developer networks every new wallet goes on Mainnet, so the app
  // does not stay on a test network that has no wallet: left there (by an
  // older version's setup, or by removing the last wallet there), it goes
  // back to Mainnet and its wallet, or to setup.
  useEffect(() => {
    if (ready && !account && network !== 'main' && services.settings.developerNetworks !== true) void switchNetwork('main');
  }, [ready, account, network, services, switchNetwork]);

  useEffect(() => services.accounts.onLockChange(setLocked), [services]);
  useEffect(() => services.accounts.installVisibilityLock(), [services]);

  // One send at a time, decided before anything else happens: a second tap
  // on Send must not touch the job, the wake lock or the deferred
  // lock of the send already running.
  const sending = useRef(false);
  const sendAbort = useRef<AbortController | null>(null);
  // The running send's confirmation, while it waits for one.
  const approval = useRef<((ok: boolean) => void) | null>(null);
  const declined = useRef(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  // A note about a send stopped by a lock cannot be written to the locked
  // wallet's log; it waits here and is written at the next unlock.
  const unsavedFailure = useRef<SendFailure | null>(null);
  // The note on screen about the last send, for refreshes during a send.
  const lastSendRef = useRef<LastSend | null>(null);
  lastSendRef.current = lastSend;

  // Depends on the account id, not the object: refresh replaces the object,
  // and depending on it would re-trigger refresh forever.
  const accountId = account?.id ?? null;
  // Loaded means read with the wallet unlocked. A locked wallet reads as
  // empty, which is not its history: a screen that keeps what was already
  // there when it opened (Receive's notes on payments arriving) would take
  // every earlier payment for a new one, and Home would show an empty wallet
  // for a moment after unlocking.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loaded = loadedFor === accountId;
  const refresh = useCallback(async () => {
    if (!accountId) {
      setUtxos([]);
      setHistory([]);
      return;
    }
    const unlockedAtStart = services.accounts.currentAccountId === accountId;
    const record = await services.db.get('accounts', accountId);
    // Where the wallet's chain data is kept: the engine's sealed log, or,
    // on a core without one, the app's database. A locked wallet's is not
    // readable at all, and shows nothing rather than a stale copy.
    let where: 'engine' | 'database' | null;
    try {
      where = services.accounts.engine.where(accountId, 'utxos');
    } catch {
      where = null;
    }
    let fresh = record;
    let coins: UtxoRecord[] = [];
    let rows: HistoryRecord[] = [];
    if (where === 'engine') {
      // How the wallet is scanned (start height, key counters, restore) is
      // the engine's now; the copy on the account record is left behind.
      const [scan] = (await services.core.storeRead!(accountId, 'scan')) as ScanSettings[];
      if (record && scan) {
        const { restore: _stale, restoredAt: _staleToo, ...rest } = record;
        fresh = { ...rest, ...scan };
      }
      coins = (await services.core.storeRead!(accountId, 'utxos')) as UtxoRecord[];
      rows = (await services.core.storeRead!(accountId, 'history')) as HistoryRecord[];
    } else if (where === 'database') {
      coins = await services.db.getAllFromIndex('utxos', 'byAccount', accountId);
      rows = await services.db.getAllFromIndex('history', 'byAccount', accountId);
    }
    if (fresh) {
      const next = fresh;
      setAccount((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }
    setUtxos(coins);
    rows.sort((a, b) => b.timestampMs - a.timestampMs);
    setHistory(rows);
    // The note about the wallet's last failed send, from its sealed log. An
    // older version kept it in the clear in the settings; once the log has
    // taken it over (at this unlock), that copy is removed.
    let failure: SendFailure | null = null;
    try {
      failure = await services.accounts.lastSendFailure(accountId);
      if (services.settings.lastSendFailure?.accountId === accountId && services.accounts.engine.where(accountId, 'private') === 'engine') {
        await services.updateSettings({ lastSendFailure: undefined });
      }
    } catch {
      // Locked: nothing to show until it is unlocked.
    }
    // Notes made while the wallet was locked (a send stopped by a lock) are
    // written now that its log can be.
    const unsaved = unsavedFailure.current;
    if (unsaved && unsaved.accountId === accountId) {
      try {
        await services.accounts.setLastSendFailure(accountId, unsaved);
        unsavedFailure.current = null;
        if (!failure || failure.at < unsaved.at) failure = unsaved;
      } catch {
        // Still locked.
      }
    }
    // The note about the last send that reached the node. It has done its
    // work once its row settles: confirmed, given up on, or dropped. While a
    // send of this session runs, the note is that send's own and not news.
    let sent: LastSend | null = sending.current ? lastSendRef.current : null;
    try {
      if (!sending.current) {
        sent = await services.accounts.lastSend(accountId);
        // A send the app was closed during: the note it left at the start
        // says so, and the rows say how far it got.
        const started = await services.accounts.sendInProgress(accountId);
        if (started) {
          const row = rows.find((h) => h.kind === 'sent' && h.status === 'pending' && h.key.includes(':sent:') && h.timestampMs >= started.at);
          if (row && sent?.txid !== row.txid) {
            // It reached the point of being handed to the node: it may have gone.
            sent = { ...started, at: row.timestampMs, txid: row.txid, state: 'unconfirmed' };
            await services.accounts.setLastSend(accountId, sent);
          } else if (!row && !(failure && failure.at >= started.at)) {
            failure = {
              at: started.at,
              accountId,
              amount: showNau(BigInt(started.amountNau)),
              recipient: started.recipient,
              others: started.others,
              message: 'The send stopped before it reached the node, when the app was closed or the wallet locked. Nothing left this wallet.',
            };
            await services.accounts.setLastSendFailure(accountId, failure);
          }
          await services.accounts.setSendInProgress(accountId, null);
        }
      }
      const row = sent ? rows.find((h) => h.kind === 'sent' && h.txid === sent?.txid) : undefined;
      if (sent && row && row.status !== 'pending' && !sending.current) {
        // Settled. A send that failed without the person giving up on it
        // did not go through: after "Sent", that is news, so it becomes the
        // note about a send that did not go through, in the engine's words
        // for why (it expired, or its coins went in another transaction).
        if (row.status === 'failed' && !row.givenUp && !/gave up/i.test(row.error ?? '')) {
          failure = {
            at: Date.now(),
            accountId,
            amount: showNau(BigInt(sent.amountNau)),
            recipient: sent.recipient,
            others: sent.others,
            message: row.error ?? 'Not sent. Nothing left this wallet, and its coins are spendable again.',
          };
          await services.accounts.setLastSendFailure(accountId, failure);
        }
        await services.accounts.setLastSend(accountId, null);
        sent = null;
      } else if (sent && row && sent.state === 'unconfirmed' && row.mempoolSeenAt && !sending.current) {
        // The node was seen holding a send it never answered about: it went.
        sent = { ...sent, state: 'submitted' };
        await services.accounts.setLastSend(accountId, sent);
      }
    } catch {
      // Locked, as above.
    }
    setSendFailure(failure);
    setLastSend(sent);
    // Unlocked from start to end, or the read is not the wallet's history.
    setLoadedFor(unlockedAtStart && services.accounts.currentAccountId === accountId ? accountId : null);
    // A finished send whose row has confirmed no longer needs its notice.
    setSendJob((job) => {
      if (!job?.done || !job.outcome) return job;
      const row = rows.find((h) => h.kind === 'sent' && h.txid === job.outcome?.txid);
      return row && row.status === 'confirmed' ? null : job;
    });
  }, [services, accountId]);

  // The note about a failed send: shown on Home until dismissed, and kept in
  // the wallet's sealed log, so it survives a reload and is never readable
  // while the wallet is locked. A send that fails after the wallet was
  // locked keeps its note here until the next unlock, and is written then.
  const noteSendFailure = useCallback(
    (forAccount: string, failure: SendFailure | null) => {
      setSendFailure(failure);
      void services.accounts.setLastSendFailure(forAccount, failure).catch(() => {
        if (failure) unsavedFailure.current = failure;
      });
    },
    [services],
  );
  // The note about a send that reached the node, kept the same way: a send
  // that ends while the app is locked, or after it was closed, still says
  // how it ended at the next unlock.
  const noteLastSend = useCallback(
    (forAccount: string, note: LastSend | null) => {
      setLastSend(note);
      void services.accounts.setLastSend(forAccount, note).catch(() => {});
    },
    [services],
  );

  const startSend = useCallback(
    async (request: SendRequest, note: string | null = null, options: { confirm?: boolean } = {}): Promise<SendOutcome> => {
      if (!accountId) throw new Error('no account');
      if (sending.current) throw new SendBusyError();
      sending.current = true;
      services.window.busy = true;
      const abort = new AbortController();
      sendAbort.current = abort;
      const service = services.sendService(accountId);
      services.accounts.setLockDeferred(true);
      setSendJob({ request, startedAt: Date.now(), provingSince: null, progress: { stage: 'planning' }, done: false, outcome: null, error: null, ending: null });
      const noteOf = (txid: string, state: LastSend['state']): LastSend => ({
        at: Date.now(),
        accountId,
        txid,
        amountNau: paymentsTotalNau(request).toString(),
        feeNau: request.fee_nau ?? '0',
        recipient: request.payments[0]?.recipient ?? '',
        others: request.payments.length - 1,
        state,
      });
      // Written before anything else: should the app be closed during the
      // send, the next unlock finds it and says how far the send got.
      const started = Date.now();
      await services.accounts
        .setSendInProgress(accountId, { at: started, accountId, amountNau: paymentsTotalNau(request).toString(), feeNau: request.fee_nau ?? '0', recipient: request.payments[0]?.recipient ?? '', others: request.payments.length - 1 })
        .catch(() => {});
      // The note about the send before this one, put back should this one
      // be refused after its own note was written.
      const earlierNote = lastSendRef.current;
      let recorded = false;
      // The person's confirmation, asked for while the proof runs.
      declined.current = false;
      let approved: Promise<boolean> | undefined;
      if (options.confirm) {
        approved = new Promise<boolean>((resolve) => {
          approval.current = resolve;
        });
        setAwaitingApproval(true);
      }
      // What Diagnostics shows about the last proof, whichever way it ends.
      let claimVersion = 0;
      let threads = 0;
      let peakMb = 0;
      let provingSince: number | null = null;
      try {
        const outcome = await service.send(
          request,
          (progress) => {
          // The sub-proof name is for bug reports, not for the screen.
          if (progress.proving?.name) console.debug('proving', progress.proving.index + 1, 'of', progress.proving.total, progress.proving.name);
          if (progress.claimVersion) claimVersion = progress.claimVersion;
          if (progress.stage === 'proving') provingSince ??= Date.now();
          if (progress.proving) {
            threads = progress.proving.threads;
            peakMb = Math.max(peakMb, progress.proving.memoryMb);
          }
          setSendJob((job) => (job ? { ...job, progress, provingSince } : job));
          },
          {
            note,
            signal: abort.signal,
            approved,
            // From the moment the node may hear of it, the sealed note says
            // the send may have gone, in case the answer never comes back to
            // this app (closed, or the tab killed). Not shown meanwhile.
            onRecorded: async (txid) => {
              recorded = true;
              await services.accounts.setLastSend(accountId, noteOf(txid, 'unconfirmed')).catch(() => {});
              await services.accounts.setSendInProgress(accountId, null).catch(() => {});
            },
          },
        );
        if (outcome.proving.seconds > 0) {
          void services.updateSettings({
            lastProving: { at: Date.now(), claimVersion: outcome.claimVersion, threads: outcome.proving.threads, peakMb: outcome.proving.memoryMb, seconds: outcome.proving.seconds, error: null },
          });
        }
        setSendJob((job) => (job ? { ...job, done: true, outcome, ending: 'sent' } : job));
        noteSendFailure(accountId, null);
        clearSendDraft(accountId);
        // Seen as it happened (on Send, or as the toast below), it needs no
        // note on Home; ended out of sight (backgrounded, or about to lock
        // because a lock waited for the send), it gets one, so it still
        // says how it ended.
        const seen = document.visibilityState === 'visible' && services.accounts.currentAccountId === accountId && !services.accounts.lockWaiting;
        noteLastSend(accountId, seen ? null : noteOf(outcome.txid, 'submitted'));
        if (window.location.pathname !== '/send' && document.visibilityState === 'visible') {
          notifications.show({ color: 'green', title: 'Sending', message: `${sentText(paymentsTotalNau(request), BigInt(request.fee_nau ?? '0'), services.settings.hideBalance)} ${SENDING_UNTIL_CONFIRMED}` });
        }
        await refresh();
        return outcome;
      } catch (e) {
        // The person cancelled in time, or did not confirm: nothing went
        // out, nothing to report beyond saying so.
        if (e instanceof SendCancelledError || e instanceof SendNotApprovedError) {
          const said = declined.current ? new SendNotApprovedError().message : e.message;
          setSendJob((job) => (job ? { ...job, done: true, error: said, ending: 'stopped' } : job));
          throw e;
        }
        // Handed over without an answer: it may have gone through, so it is
        // no failure. The pending row is in History with its coins held, and
        // the note says to wait, until the row settles.
        if (e instanceof SendUnconfirmedError) {
          setSendJob((job) => (job ? { ...job, done: true, error: e.message, ending: 'unconfirmed' } : job));
          noteSendFailure(accountId, null);
          clearSendDraft(accountId);
          // Always noted: until the row settles, it says not to send again.
          noteLastSend(accountId, noteOf(e.txid, 'unconfirmed'));
          await refresh();
          if (window.location.pathname !== '/send' && document.visibilityState === 'visible') {
            notifications.show({ color: 'yellow', title: UNANSWERED_TITLE, message: e.message, autoClose: 10_000 });
          }
          throw e;
        }
        // A lock during a send ends it before the node hears of it: the
        // failure is the lock, whatever the step that noticed it said.
        const lockedOut = services.accounts.currentAccountId !== accountId;
        const message = e instanceof RequiresLustrationError ? null : lockedOut ? 'Nothing was sent: the wallet was locked before the send was finished. Unlock and send again.' : (e as Error).message;
        if (message && provingSince !== null) {
          // Diagnostics keeps the technical account, where there is one.
          const detail = (e as Error & { detail?: string }).detail;
          void services.updateSettings({
            lastProving: { at: Date.now(), claimVersion, threads, peakMb, seconds: (Date.now() - provingSince) / 1000, error: detail ?? message },
          });
        }
        setSendJob((job) => (job ? { ...job, done: true, error: message, ending: message ? 'failed' : null } : job));
        // Refused by the node after its note was written: the note goes back to what it was.
        if (recorded) noteLastSend(accountId, earlierNote);
        if (message) noteSendFailure(accountId, { at: Date.now(), accountId, amount: showNau(paymentsTotalNau(request)), recipient: request.payments[0]?.recipient ?? '', others: request.payments.length - 1, message });
        if (message && window.location.pathname !== '/send' && document.visibilityState === 'visible') notifications.show({ color: 'red', title: 'Not sent', message: notSentReason(message) });
        throw e;
      } finally {
        // However it ended, it is no longer running: the note that said so goes.
        await services.accounts.setSendInProgress(accountId, null).catch(() => {});
        approval.current?.(false);
        approval.current = null;
        setAwaitingApproval(false);
        sending.current = false;
        services.window.busy = false;
        sendAbort.current = null;
        services.accounts.setLockDeferred(false);
      }
    },
    [services, accountId, refresh, noteSendFailure, noteLastSend],
  );

  // Cancel asks; the send answers. The screen says "cancelled" only when
  // the send service confirms nothing went out, never on the tap alone.
  const cancelSend = useCallback(() => {
    sendAbort.current?.abort();
    services.prover.cancel();
  }, [services]);

  const approveSend = useCallback(() => {
    approval.current?.(true);
    approval.current = null;
    setAwaitingApproval(false);
  }, []);

  // Declining stops the proof at once: its only use was this send.
  const declineSend = useCallback(() => {
    declined.current = true;
    approval.current?.(false);
    approval.current = null;
    setAwaitingApproval(false);
    cancelSend();
  }, [cancelSend]);

  // Only a finished job is dismissed: a note about an earlier send closed
  // while another proves must not take the running one with it.
  const dismissSendJob = useCallback(() => {
    setSendJob((job) => (job && !job.done ? job : null));
  }, []);

  const dismissSendFailure = useCallback(() => {
    if (accountId) noteSendFailure(accountId, null);
  }, [accountId, noteSendFailure]);

  const dismissLastSend = useCallback(() => {
    if (accountId) noteLastSend(accountId, null);
  }, [accountId, noteLastSend]);

  // Read again whenever the wallet locks or unlocks: unlocked, its own
  // records show at once, before the node has been asked anything (offline
  // too); locked, what was shown goes.
  useEffect(() => {
    void refresh();
  }, [refresh, locked]);

  // Incoming payments show before they are mined: the mempool is scanned
  // after every sync and on its own timer. Failures are quiet; the block
  // sync is the source of truth.
  const watching = useRef(false);
  const watchMempool = useCallback(async () => {
    if (!accountId || locked || watching.current || !navigator.onLine) return;
    watching.current = true;
    try {
      const r = await services.mempoolWatcher(accountId).poll();
      await refresh();
      // Home and Receive say it where the payment shows; elsewhere a toast
      // does, without the amount while amounts are hidden.
      if (r.incoming > 0 && document.visibilityState === 'visible' && window.location.pathname !== '/' && window.location.pathname !== '/receive') {
        const hide = services.settings.hideBalance;
        notifications.show({
          color: 'green',
          title: 'Payment pending',
          message: hide
            ? 'A payment to you is pending until a block confirms it.'
            : `${formatNau(BigInt(r.incomingNau))} NPT to you is pending until a block confirms it.${BigInt(r.lockedNau) > 0n ? ` ${formatNau(BigInt(r.lockedNau))} NPT of it cannot be spent before a date the sender set.` : ''}`,
        });
      }
    } catch (e) {
      console.debug('mempool watch', (e as Error).message);
    } finally {
      watching.current = false;
    }
  }, [services, accountId, locked, refresh]);

  // After a node too slow to sync from, the timer waits longer before the
  // next try (doubling, up to five minutes), so a phone on a poor connection
  // does not fetch the same blocks over and over. Sync and Retry do not wait.
  const pauseUntil = useRef(0);
  const pauseFor = useRef(0);
  const syncNow = useCallback(async (options: { auto?: boolean } = {}) => {
    if (!accountId || locked || syncing.current) return;
    if (options.auto && Date.now() < pauseUntil.current) return;
    if (!navigator.onLine) {
      // No point asking the node; the online event below retries.
      setSync((prev) => ({ phase: 'error', syncedHeight: prev?.syncedHeight ?? 0, tipHeight: prev?.tipHeight ?? 0, message: 'You are offline. The balance shown is from the last sync.' }));
      return;
    }
    syncing.current = true;
    const run = (async () => {
      try {
        const e = services.syncEngine(accountId, (p) => {
          setSync(p);
          if (p.phase === 'done') setLastSyncedAt(Date.now());
        });
        engine.current = e;
        const result = await e.syncOnce();
        if (result.slow) {
          pauseFor.current = Math.min(5 * 60_000, Math.max(60_000, pauseFor.current * 2));
          pauseUntil.current = Date.now() + pauseFor.current;
        } else if (result.phase === 'done') {
          pauseFor.current = 0;
          pauseUntil.current = 0;
        }
        await refresh();
        // A send no block can take any more has been released: said once,
        // here, since the person may have dismissed every other note about it.
        if (result.expired?.length && document.visibilityState === 'visible') {
          notifications.show({
            color: 'yellow',
            title: result.expired.length === 1 ? 'A send expired' : `${result.expired.length} sends expired`,
            message: 'No block can take it any more, so nothing went out, and its coins are spendable again. It is marked Not sent in History.',
            autoClose: 10_000,
          });
        }
        await watchMempool();
      } finally {
        engine.current = null;
        syncing.current = false;
      }
    })();
    syncRun.current = run;
    await run;
  }, [services, accountId, locked, refresh, watchMempool]);

  const rescan = useCallback(
    async (height: number, fast = false) => {
      if (!accountId) return;
      await stopSync();
      await services.accounts.rescanFrom(accountId, height, fast);
      await refresh();
      void syncNow();
    },
    [services, accountId, stopSync, refresh, syncNow],
  );

  // A lock ends the running pass; the next unlock starts a fresh one.
  useEffect(() => {
    if (locked) void engine.current?.stop();
  }, [locked]);

  // Follow the connection: mark offline at once, sync again when it returns.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const goOffline = () => {
      setOnline(false);
      setSync((prev) => ({ phase: 'error', syncedHeight: prev?.syncedHeight ?? 0, tipHeight: prev?.tipHeight ?? 0, message: 'You are offline. The balance shown is from the last sync.' }));
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [syncNow]);

  // Watch the mempool while unlocked and visible.
  useEffect(() => {
    if (!accountId || locked) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void watchMempool();
    }, 30_000);
    return () => clearInterval(timer);
  }, [accountId, locked, watchMempool]);

  // Poll the node while unlocked and visible.
  useEffect(() => {
    if (!accountId || locked) return;
    void syncNow();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void syncNow({ auto: true });
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [accountId, locked, syncNow]);

  const balance = useMemo<Balance>(() => {
    let spendable = 0n;
    let reserved = 0n;
    let locked = 0n;
    let nextRelease: number | null = null;
    const now = Date.now();
    for (const u of utxos) {
      if (u.spentHeight !== null) continue;
      if (u.pendingTxid) reserved += BigInt(u.amountNau);
      else if (u.releaseDateMs !== null && u.releaseDateMs !== undefined && u.releaseDateMs > now) {
        // A time-locked coin is owned but cannot be spent yet: a payer can
        // lock a payment for years, so it must never read as spendable.
        locked += BigInt(u.amountNau);
        nextRelease = nextRelease === null ? u.releaseDateMs : Math.min(nextRelease, u.releaseDateMs);
      } else spendable += BigInt(u.amountNau);
    }
    return { spendableNau: spendable, reservedNau: reserved, lockedNau: locked, nextReleaseMs: nextRelease };
  }, [utxos]);

  // The screen stays on for as long as a send runs, whichever screen is showing:
  // a phone that locks mid-proof suspends the page, and with it the proof.
  // And during a long restore or scan: a locked screen locks the wallet and
  // stops the scan, which then starts again on the next unlock.
  const longScan = (sync?.phase === 'scanning' && sync.tipHeight - sync.syncedHeight > 100) || sync?.phase === 'restoring';
  const screenAwake = useScreenWakeLock(Boolean(sendJob && !sendJob.done) || longScan);

  const value = useMemo<AppState>(
    () => ({ services, ready, account, locked, sync, balance, history, utxos, refresh, loaded, syncNow, rescan, lastSyncedAt, online, setAccount, network, switchNetwork, switchAccount, removeAccount, pauseSync: stopSync, sendJob, screenAwake, startSend, cancelSend, awaitingApproval, approveSend, declineSend, dismissSendJob, sendFailure, dismissSendFailure, lastSend, dismissLastSend, checkIncoming: watchMempool, adoptNetwork: setNetwork }),
    [services, ready, account, locked, sync, balance, history, utxos, refresh, loaded, syncNow, rescan, lastSyncedAt, online, network, switchNetwork, switchAccount, removeAccount, stopSync, sendJob, screenAwake, startSend, cancelSend, awaitingApproval, approveSend, declineSend, dismissSendJob, sendFailure, dismissSendFailure, lastSend, dismissLastSend, watchMempool],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One NPT in nau: the consensus type defines 1 coin = 4 * 10^30 nau. */
export const NAU_PER_COIN = 4n * 10n ** 30n;

/** Format nau as NPT for display, up to 8 decimals, trailing zeros trimmed. */
export function formatNau(nau: bigint): string {
  const negative = nau < 0n;
  const abs = negative ? -nau : nau;
  const unit = NAU_PER_COIN;
  const whole = abs / unit;
  const frac = ((abs % unit) * 10n ** 8n) / unit;
  let text = whole.toString();
  if (frac > 0n) text += '.' + frac.toString().padStart(8, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + text;
}

/**
 * An amount for people to read: the plain form with the whole part grouped
 * in threes by a narrow no-break space (locale-neutral, never wraps). Links
 * and inputs keep the plain form, which NIP-002 requires.
 */
export function showNau(nau: bigint): string {
  return groupDigits(formatNau(nau));
}

/**
 * A send as its confirmation says it, the fee included, so the figure
 * matches the one History shows for it: "5 NPT, plus a 0.3 NPT fee."
 * Masked when amounts are hidden.
 */
export function sentText(amountNau: bigint, feeNau: bigint, hidden = false): string {
  const show = (nau: bigint) => (hidden ? '••••' : showNau(nau));
  return `${show(amountNau)} NPT, plus a ${show(feeNau)} NPT fee.`;
}

/** The title of a send the node took without answering: it has ended, and may have gone through. */
export const UNANSWERED_TITLE = 'The node did not answer';

/** A block height for people to read, grouped like an amount. */
export function showBlock(height: number): string {
  return showInt(height);
}
