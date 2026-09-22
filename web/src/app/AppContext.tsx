// App-wide state: the services, the current account, lock state, sync
// progress, and the derived balance and history. Screens subscribe here.

import { notifications } from '@mantine/notifications';
import { groupDigits, showInt } from '../util/format';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { byCreation, type AccountRecord, type HistoryRecord, type Network, type UtxoRecord } from '../storage/db';
import type { ScanSettings, SendRequest } from '../backend/types';
import type { SyncEngine, SyncProgress } from '../wallet/sync';
import { RequiresLustrationError, SendBusyError, SendCancelledError, SendUnconfirmedError, type SendOutcome, type SendProgress } from './send';
import type { Services } from './services';

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
  /** Run one sync pass now (also runs on a timer while unlocked). */
  syncNow: () => Promise<void>;
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
  /** Lock and show another wallet, on whichever network it belongs to. */
  switchAccount: (accountId: string) => Promise<void>;
  /** Remove a wallet from this device and show the next one on its network, or onboarding. */
  removeAccount: (accountId: string) => Promise<void>;
  /** End the running sync pass, before the account changes under it. */
  pauseSync: () => Promise<void>;
  /** The running or last send. */
  sendJob: SendJob | null;
  /** Run a send as a job: wake lock held, auto-lock deferred, toast at the end. */
  /** `note` is the payment link's message, kept with the send for the payer's own record. */
  startSend: (request: SendRequest, note?: string | null) => Promise<SendOutcome>;
  cancelSend: () => void;
  dismissSendJob: () => void;
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
      // The removal promises that nothing of the wallet stays on the device:
      // that includes the note about its last failed send, which names a
      // recipient and an amount, and the mempool watcher kept for it.
      if (services.settings.lastSendFailure?.accountId === id) await services.updateSettings({ lastSendFailure: undefined });
      services.forgetAccount(id);
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

  useEffect(() => services.accounts.onLockChange(setLocked), [services]);
  useEffect(() => services.accounts.installVisibilityLock(), [services]);

  // Depends on the account id, not the object: refresh replaces the object,
  // and depending on it would re-trigger refresh forever.
  const accountId = account?.id ?? null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loaded = loadedFor === accountId;
  const refresh = useCallback(async () => {
    if (!accountId) {
      setUtxos([]);
      setHistory([]);
      return;
    }
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
    setLoadedFor(accountId);
    // A finished send whose row has confirmed no longer needs its notice.
    setSendJob((job) => {
      if (!job?.done || !job.outcome) return job;
      const row = rows.find((h) => h.kind === 'sent' && h.txid === job.outcome?.txid);
      return row && row.status === 'confirmed' ? null : job;
    });
  }, [services, accountId]);

  // One send at a time, decided before anything else happens: a second tap
  // on "Send now" must not touch the job, the wake lock or the deferred
  // lock of the send already running.
  const sending = useRef(false);
  const sendAbort = useRef<AbortController | null>(null);

  const startSend = useCallback(
    async (request: SendRequest, note: string | null = null): Promise<SendOutcome> => {
      if (!accountId) throw new Error('no account');
      if (sending.current) throw new SendBusyError();
      sending.current = true;
      services.window.busy = true;
      const abort = new AbortController();
      sendAbort.current = abort;
      const service = services.sendService(accountId);
      let wake: WakeLockSentinel | null = null;
      try {
        wake = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        wake = null;
      }
      services.accounts.setLockDeferred(true);
      setSendJob({ request, startedAt: Date.now(), provingSince: null, progress: { stage: 'planning' }, done: false, outcome: null, error: null });
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
          note,
          abort.signal,
        );
        if (outcome.proving.seconds > 0) {
          void services.updateSettings({
            lastProving: { at: Date.now(), claimVersion: outcome.claimVersion, threads: outcome.proving.threads, peakMb: outcome.proving.memoryMb, seconds: outcome.proving.seconds, error: null },
          });
        }
        setSendJob((job) => (job ? { ...job, done: true, outcome } : job));
        if (services.settings.lastSendFailure) void services.updateSettings({ lastSendFailure: undefined });
        if (window.location.pathname !== '/send' && document.visibilityState === 'visible') {
          notifications.show({ color: 'green', title: 'Sent', message: `${request.amount} NPT submitted. It shows as pending until it is confirmed.` });
        }
        await refresh();
        return outcome;
      } catch (e) {
        // The person cancelled in time: nothing went out, nothing to report.
        if (e instanceof SendCancelledError) {
          setSendJob((job) => (job ? { ...job, done: true, error: e.message } : job));
          throw e;
        }
        // Handed over without an answer: the pending row is in History.
        if (e instanceof SendUnconfirmedError) await refresh();
        const message = e instanceof RequiresLustrationError ? null : (e as Error).message;
        if (message && provingSince !== null) {
          void services.updateSettings({
            lastProving: { at: Date.now(), claimVersion, threads, peakMb, seconds: (Date.now() - provingSince) / 1000, error: message },
          });
        }
        setSendJob((job) => (job ? { ...job, done: true, error: message } : job));
        if (message) void services.updateSettings({ lastSendFailure: { at: Date.now(), accountId, amount: request.amount, recipient: request.recipient, message } });
        if (message && window.location.pathname !== '/send' && document.visibilityState === 'visible') notifications.show({ color: 'red', title: 'Not sent', message });
        throw e;
      } finally {
        sending.current = false;
        services.window.busy = false;
        sendAbort.current = null;
        await wake?.release().catch(() => undefined);
        services.accounts.setLockDeferred(false);
      }
    },
    [services, accountId, refresh],
  );

  // Cancel asks; the send answers. The screen says "cancelled" only when
  // the send service confirms nothing went out, never on the tap alone.
  const cancelSend = useCallback(() => {
    sendAbort.current?.abort();
    services.prover.cancel();
  }, [services]);

  const dismissSendJob = useCallback(() => {
    setSendJob(null);
    if (services.settings.lastSendFailure) void services.updateSettings({ lastSendFailure: undefined });
  }, [services]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      if (r.incoming > 0 && document.visibilityState === 'visible' && window.location.pathname !== '/') {
        notifications.show({ color: 'green', title: 'Incoming payment', message: `${formatNau(BigInt(r.incomingNau))} NPT is on its way to you, waiting for a block.${BigInt(r.lockedNau) > 0n ? ` ${formatNau(BigInt(r.lockedNau))} NPT of it is time-locked by the payer and cannot be spent before its release date.` : ''}` });
      }
    } catch (e) {
      console.debug('mempool watch', (e as Error).message);
    } finally {
      watching.current = false;
    }
  }, [services, accountId, locked, refresh]);

  const syncNow = useCallback(async () => {
    if (!accountId || locked || syncing.current) return;
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
        await e.syncOnce();
        await refresh();
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
      if (document.visibilityState === 'visible') void syncNow();
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

  const value = useMemo<AppState>(
    () => ({ services, ready, account, locked, sync, balance, history, utxos, refresh, loaded, syncNow, rescan, lastSyncedAt, online, setAccount, network, switchNetwork, switchAccount, removeAccount, pauseSync: stopSync, sendJob, startSend, cancelSend, dismissSendJob }),
    [services, ready, account, locked, sync, balance, history, utxos, refresh, loaded, syncNow, rescan, lastSyncedAt, online, network, switchNetwork, switchAccount, removeAccount, stopSync, sendJob, startSend, cancelSend, dismissSendJob],
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

/** A block height for people to read, grouped like an amount. */
export function showBlock(height: number): string {
  return showInt(height);
}
