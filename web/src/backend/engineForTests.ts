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

import type { VaultDb } from '../storage/db';
import { LogStore } from '../storage/logStore';
import { EngineHost, KEYED_OPS } from './browser/engineHost';
import type { LedgerAnswer, LedgerOp, StoredUtxo, WalletChange, WalletCore, WalletPart } from './types';

/**
 * A coin as the core reports it, from the core's own serialisation
 * (ledger::tests::print_the_wire_shape_of_a_coin). The recovery data is a
 * native-currency coin under a zero lock script: enough for bookkeeping.
 * Fields of the report can be replaced; `commitment` is empty unless given.
 */
export function coin(hash: string, height: number, fields: Partial<StoredUtxo> = {}): StoredUtxo {
  const zero = '0'.repeat(80);
  return {
    hash,
    commitment: '',
    recovery: {
      utxo: { lock_script_hash: zero, coins: [{ type_script_hash: '35ab20eaca74e39c97b1b1c6eeb337853babec0d1b4152b6218f12ab673618df11bb3a534af30f64', state: [1, 0, 0, 0] }] },
      sender_randomness: zero,
      receiver_preimage: zero,
      aocl_index: height,
    },
    amount_nau: '1',
    amount: '1',
    key_kind: 'generation',
    key_index: 0,
    release_date_ms: null,
    confirmed_height: height,
    confirmed_block: `hash-${height}`,
    confirmed_timestamp_ms: height * 1000,
    own_build_height: null,
    ...fields,
  } as unknown as StoredUtxo;
}

type CoreModule = typeof import('../../public/wasm/core/vault_core');

let loaded: CoreModule | null = null;

async function core(): Promise<CoreModule> {
  if (loaded) return loaded;
  const m = (await import('../../public/wasm/core/vault_core.js')) as CoreModule;
  m.initSync({ module: readFileSync(new URL('../../public/wasm/core/vault_core_bg.wasm', import.meta.url)) });
  loaded = m;
  return m;
}

/**
 * Answers for the operations that scan, in place of keys and blocks the
 * tests do not have. Any other operation can be answered too, where a test
 * needs to stand in for something the node would compute from real data.
 */
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
    const answer = (scans as Record<string, ((o: O) => unknown) | undefined>)[op.op];
    if (answer) return (await answer(op)) as LedgerAnswer<O>;
    if (KEYED_OPS.has(op.op)) throw new Error('wallet is locked');
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

type Row = Record<string, unknown> & { key?: string };

/**
 * The old stores, as a test reads and writes them, answered from the engine.
 * The tests of the sync, the mempool watcher and a send were written against
 * the app's database; this lets their bodies stay as they were while what
 * they check is what the engine did. The account record keeps living in the
 * database, with how it is scanned laid over it from the engine, as the app
 * shows it.
 */
export function chainView(engine: TestEngine, db: VaultDb, accountId: string) {
  const all = async (part: WalletPart) => (await engine.store.storeRead(accountId, part)) as Row[];
  const put = (change: Record<string, unknown>) => engine.store.storeCommit(accountId, [change as unknown as WalletChange]);
  return {
    async get(store: string, key: string): Promise<any> {
      if (store === 'accounts') {
        const record = await db.get('accounts', key);
        const [scan] = await all('scan');
        if (!record || !scan) return record;
        const { restore: _stale, restoredAt: _staleToo, ...rest } = record;
        return { ...rest, ...scan };
      }
      if (store === 'syncState') return (await all('sync'))[0];
      return (await all(store as WalletPart)).find((r) => r.key === key);
    },
    async getAllFromIndex(store: string, ..._index: unknown[]): Promise<any[]> {
      return all(store as WalletPart);
    },
    async put(store: string, record: any): Promise<void> {
      if (store === 'accounts') {
        await db.put('accounts', record);
        const { birthdayHeight, nextKeyIndices, restore, restoredAt } = record;
        await put({ op: 'putScan', scan: { birthdayHeight, nextKeyIndices, ...(restore ? { restore } : {}), ...(restoredAt ? { restoredAt } : {}) } });
        return;
      }
      if (store === 'utxos') return put({ op: 'putUtxo', utxo: record });
      if (store === 'history') return put({ op: 'putHistory', entry: record });
      if (store === 'syncState') return put({ op: 'putSync', sync: record });
      if (store === 'blocks') return put({ op: 'putBlock', block: record });
      throw new Error(`chainView: no store ${store}`);
    },
  };
}
