// App-wide state: the services, the current account, lock state, sync
// progress, and the derived balance and history. Screens subscribe here.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AccountRecord, HistoryRecord, UtxoRecord } from '../storage/db';
import type { SyncProgress } from '../wallet/sync';
import type { Services } from './services';

export interface Balance {
  /** Confirmed and spendable, in nau. */
  spendableNau: bigint;
  /** Reserved by pending outgoing transactions, in nau. */
  reservedNau: bigint;
}

export interface AppState {
  services: Services;
  account: AccountRecord | null;
  locked: boolean;
  sync: SyncProgress | null;
  balance: Balance;
  history: HistoryRecord[];
  utxos: UtxoRecord[];
  /** Re-read account, balance and history from the database. */
  refresh: () => Promise<void>;
  /** Run one sync pass now (also runs on a timer while unlocked). */
  syncNow: () => Promise<void>;
  setAccount: (account: AccountRecord | null) => void;
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
  const [locked, setLocked] = useState(true);
  const [sync, setSync] = useState<SyncProgress | null>(null);
  const [utxos, setUtxos] = useState<UtxoRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const syncing = useRef(false);

  // Initial account: the one settings point at, else the only one on this network.
  useEffect(() => {
    void (async () => {
      const all = await services.db.getAllFromIndex('accounts', 'byNetwork', services.settings.network);
      const chosen = all.find((a) => a.id === services.settings.currentAccountId) ?? all[0] ?? null;
      setAccount(chosen);
    })();
  }, [services]);

  useEffect(() => services.accounts.onLockChange(setLocked), [services]);
  useEffect(() => services.accounts.installVisibilityLock(), [services]);

  const refresh = useCallback(async () => {
    if (!account) {
      setUtxos([]);
      setHistory([]);
      return;
    }
    const fresh = await services.db.get('accounts', account.id);
    if (fresh) setAccount(fresh);
    setUtxos(await services.db.getAllFromIndex('utxos', 'byAccount', account.id));
    const rows = await services.db.getAllFromIndex('history', 'byAccount', account.id);
    rows.sort((a, b) => b.timestampMs - a.timestampMs);
    setHistory(rows);
  }, [services, account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const syncNow = useCallback(async () => {
    if (!account || locked || syncing.current) return;
    syncing.current = true;
    try {
      const engine = services.syncEngine(account.id, setSync);
      await engine.syncOnce();
      await refresh();
    } finally {
      syncing.current = false;
    }
  }, [services, account, locked, refresh]);

  // Poll the node while unlocked and visible.
  useEffect(() => {
    if (!account || locked) return;
    void syncNow();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void syncNow();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [account, locked, syncNow]);

  const balance = useMemo<Balance>(() => {
    let spendable = 0n;
    let reserved = 0n;
    for (const u of utxos) {
      if (u.spentHeight !== null) continue;
      if (u.pendingTxid) reserved += BigInt(u.amountNau);
      else spendable += BigInt(u.amountNau);
    }
    return { spendableNau: spendable, reservedNau: reserved };
  }, [utxos]);

  const value = useMemo<AppState>(
    () => ({ services, account, locked, sync, balance, history, utxos, refresh, syncNow, setAccount }),
    [services, account, locked, sync, balance, history, utxos, refresh, syncNow],
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
