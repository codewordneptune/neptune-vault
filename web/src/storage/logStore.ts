// Where the engine's logs are kept in a browser.
//
// The engine holds the wallet and writes it down as numbered entries, per
// log: one log for the device, one sealed log for each wallet. This keeps
// those entries and gives them back, and is told nothing about what is in
// them. For a wallet's log it could not find out: the bytes are sealed
// under a key that never comes here.
//
// It is a database of its own, beside the app's old one and not inside it.
// The old one is left exactly as it was while wallets move over, so there
// is always something to fall back to, and so that taking this away again
// would be deleting one database and nothing more.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const LOG_DB_NAME = 'neptune-vault-log';
const LOG_DB_VERSION = 1;

type Kind = 'changes' | 'snapshot';

interface EntryRow {
  log: string;
  seq: number;
  kind: Kind;
  bytes: Uint8Array;
}

interface LogSchema extends DBSchema {
  entries: { key: [string, number, Kind]; value: EntryRow; indexes: { byLog: string } };
}

export class LogStore {
  private constructor(private readonly db: IDBPDatabase<LogSchema>) {}

  static async open(name = LOG_DB_NAME): Promise<LogStore> {
    const db = await openDB<LogSchema>(name, LOG_DB_VERSION, {
      upgrade(db) {
        const entries = db.createObjectStore('entries', { keyPath: ['log', 'seq', 'kind'] });
        entries.createIndex('byLog', 'log');
      },
    });
    return new LogStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** The names of every log held. */
  async logs(): Promise<string[]> {
    const names: string[] = [];
    let cursor = await this.db.transaction('entries').store.index('byLog').openKeyCursor(null, 'nextunique');
    while (cursor) {
      names.push(cursor.key);
      cursor = await cursor.continue();
    }
    return names;
  }

  /** Every entry of one log, in any order. Empty when there is no such log. */
  async load(log: string): Promise<Uint8Array[]> {
    return (await this.db.getAllFromIndex('entries', 'byLog', log)).map((row) => row.bytes);
  }

  /**
   * Keep `bytes` as entry `seq` of `log`, on disk by the time this resolves.
   * A number that is already taken is refused: two writers would each
   * believe they had written entry n, and one of them would be wrong.
   */
  async append(log: string, seq: number, bytes: Uint8Array): Promise<void> {
    const tx = this.db.transaction('entries', 'readwrite', { durability: 'strict' });
    // Together: when the add is refused the transaction aborts too, and a
    // rejection nobody is waiting for is reported as an error of its own.
    await Promise.all([tx.store.add({ log, seq, kind: 'changes', bytes }), tx.done]);
  }

  /**
   * Keep `snapshot` as of `seq` and drop everything it covers. The engine
   * asks only that the snapshot lands before anything is dropped; here both
   * happen in one transaction, so there is no in-between to crash in.
   */
  async compact(log: string, seq: number, snapshot: Uint8Array): Promise<void> {
    const tx = this.db.transaction('entries', 'readwrite', { durability: 'strict' });
    await tx.store.put({ log, seq, kind: 'snapshot', bytes: snapshot });
    for (const key of await tx.store.index('byLog').getAllKeys(log)) {
      const [, entrySeq, kind] = key;
      const covered = kind === 'changes' ? entrySeq <= seq : entrySeq < seq;
      if (covered) await tx.store.delete(key);
    }
    await tx.done;
  }

  /** Forget a log entirely. */
  async remove(log: string): Promise<void> {
    const tx = this.db.transaction('entries', 'readwrite', { durability: 'strict' });
    for (const key of await tx.store.index('byLog').getAllKeys(log)) await tx.store.delete(key);
    await tx.done;
  }
}
