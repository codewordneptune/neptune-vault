// The real engine, compiled to wasm, for the app's tests.
//
// The sync, the mempool watcher and a send used to write the database
// themselves, and their tests checked what they wrote. Those writes now
// happen in the engine, so the same tests run against the engine itself:
// this loads the wasm core the app ships, puts its store on an in-memory
// IndexedDB, and runs it through the very class the wallet worker uses.
//
// What it does not do is scan. Scanning needs real blocks and real keys,
// and the tests have neither: they describe what a scan found, and that is
// handed in as the answer to the keyed operations. Everything the wallet
// then does with it is the engine's own doing.
//
// Tests only. It reads the built wasm from disk, so `npm run wasm:core`
// must have run, as it has in CI before the tests.

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import { LogStore } from '../storage/logStore';
import { EngineHost, KEYED_OPS } from './browser/engineHost';
import type { LedgerAnswer, LedgerOp, WalletChange, WalletCore, WalletPart } from './types';

type CoreModule = typeof import('../../public/wasm/core/vault_core');

let loaded: CoreModule | null = null;

async function core(): Promise<CoreModule> {
  if (loaded) return loaded;
  const m = (await import('../../public/wasm/core/vault_core.js')) as CoreModule;
  m.initSync({ module: readFileSync(new URL('../../public/wasm/core/vault_core_bg.wasm', import.meta.url)) });
  loaded = m;
  return m;
}

/** Answers for the operations that scan, in place of keys and blocks the tests do not have. */
export type Scans = Partial<{ [K in LedgerOp['op']]: (op: Extract<LedgerOp, { op: K }>) => unknown }>;

export interface TestEngine {
  /** The store and ledger methods of the core, backed by the real engine. */
  store: Required<Pick<WalletCore, 'storeOpen' | 'storeMigrate' | 'storeRead' | 'storeCommit' | 'storeRemove' | 'ledger'>>;
  /** Unlock: hand over a content key, as the worker is handed one. */
  unlock(contentKey?: Uint8Array): void;
  lock(): void;
  close(): void;
}

let count = 0;

/**
 * A fresh engine with its own storage. `scans` answers the keyed
 * operations; left out, they fail as a locked wallet's would.
 */
export async function testEngine(scans: Scans = {}): Promise<TestEngine> {
  const m = await core();
  const name = `engine-test-${++count}-${Date.now()}`;
  const logStore = LogStore.open(name);
  const host = new EngineHost(m, () => logStore, () => null);
  const ledger = async <O extends LedgerOp>(accountId: string, op: O): Promise<LedgerAnswer<O>> => {
    if (KEYED_OPS.has(op.op)) {
      const answer = (scans as Record<string, ((o: O) => unknown) | undefined>)[op.op];
      if (!answer) throw new Error('wallet is locked');
      return answer(op) as LedgerAnswer<O>;
    }
    return host.ledger(accountId, op) as Promise<LedgerAnswer<O>>;
  };
  return {
    store: {
      storeOpen: (accountId: string) => host.open(accountId),
      storeMigrate: (accountId: string, parts: WalletPart[], dump: unknown) => host.migrate(accountId, parts, dump),
      storeRead: (accountId: string, part: WalletPart) => host.read(accountId, part),
      storeCommit: (accountId: string, changes: WalletChange[]) => host.commit(accountId, changes),
      storeRemove: (accountId: string) => host.remove(accountId),
      ledger,
    },
    unlock(contentKey = new Uint8Array(32).fill(7)) {
      host.keep(contentKey.slice());
    },
    lock() {
      host.keep(null);
    },
    close() {
      host.keep(null);
      void logStore.then((s) => s.close());
      indexedDB.deleteDatabase(name);
    },
  };
}
