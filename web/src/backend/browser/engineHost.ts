// The engine's store as the wallet worker runs it: each unlocked wallet's
// sealed log, the key it is sealed under, the storage it lives in, and the
// order things happen in.
//
// Kept apart from the worker so that the app's tests can run exactly this
// code against the real engine, compiled to wasm, and not a stand-in for
// it. The worker makes one; a test makes another, with storage in memory.
//
// The order is what matters. An operation reads the wallet as it is and
// decides; its batch is written down; only then does it take effect; and
// only then does the next operation on that wallet begin. Nothing reads a
// coin, waits, and writes it back over whatever changed in between.

import type { LedgerOp, WalletPart } from '../types';
import type { LogStore } from '../../storage/logStore';

type CoreModule = typeof import('../../../public/wasm/core/vault_core');
type WalletLog = InstanceType<CoreModule['WalletLog']>;
type Account = InstanceType<CoreModule['Account']>;

/** Batches kept between snapshots; the engine's COMPACT_EVERY. */
const COMPACT_EVERY = 256;

/** Operations that need the wallet's keys, which the worker keeps apart from its data. */
export const KEYED_OPS = new Set<LedgerOp['op']>(['announcementFlags', 'scanBlocks', 'scanMempoolKernel']);

interface Held {
  log: WalletLog;
  sinceSnapshot: number;
}

export class EngineHost {
  private contentKey: Uint8Array | null = null;
  private readonly logs = new Map<string, Held>();
  // Requests arrive while earlier ones wait on storage, so two writes to one
  // log could both be prepared as entry n. One at a time, per log.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly m: CoreModule,
    private readonly storage: () => Promise<LogStore>,
    /** The unlocked wallet's keys, for the operations that need them. */
    private readonly keys: () => Account | null,
  ) {}

  /** Keep the content key of the wallet just unlocked, or none on locking. Every open log goes with the old key. */
  keep(key: Uint8Array | null): void {
    this.contentKey?.fill(0);
    this.contentKey = key;
    for (const held of this.logs.values()) held.log.free();
    this.logs.clear();
  }

  private inTurn<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(accountId) ?? Promise.resolve()).then(run, run);
    this.queues.set(accountId, next.catch(() => undefined));
    return next;
  }

  private held(accountId: string): Held {
    const held = this.logs.get(accountId);
    if (!held) throw new Error('wallet is locked');
    return held;
  }

  /** Write the batch the log has prepared, and only then let it take effect. */
  private async write(held: Held): Promise<void> {
    const seq = held.log.pending_seq();
    const bytes = held.log.pending_bytes();
    if (seq === undefined || bytes === undefined) return;
    const store = await this.storage();
    try {
      await store.append(held.log.name(), seq, bytes);
    } catch (e) {
      held.log.abandon();
      throw e;
    }
    held.log.confirm();
    held.sinceSnapshot += 1;
    if (held.sinceSnapshot >= COMPACT_EVERY) {
      // Best effort: a log longer than it needs to be is still a correct log.
      try {
        await store.compact(held.log.name(), held.log.seq(), held.log.snapshot());
        held.sinceSnapshot = 0;
      } catch {
        // Tried again after the next write.
      }
    }
  }

  /** Open the unlocked wallet's log. Returns the parts that live in it. */
  open(accountId: string): Promise<WalletPart[]> {
    return this.inTurn(accountId, async () => {
      if (!this.logs.has(accountId)) {
        if (!this.contentKey) throw new Error('wallet is locked');
        const entries = await (await this.storage()).load(`wallet:${accountId}`);
        this.logs.set(accountId, { log: new this.m.WalletLog(accountId, this.contentKey, entries), sinceSnapshot: entries.length });
      }
      return this.held(accountId).log.migrated() as WalletPart[];
    });
  }

  /** Move parts over from the app's database, together, checked record for record first. */
  migrate(accountId: string, parts: WalletPart[], dump: unknown): Promise<void> {
    return this.inTurn(accountId, async () => {
      const held = this.held(accountId);
      const moved = new Set(held.log.migrated());
      const todo = parts.filter((p) => !moved.has(p));
      if (todo.length === 0) return;
      held.log.prepare_migration(JSON.stringify(dump), JSON.stringify(todo));
      await this.write(held);
    });
  }

  /** Start the chain afresh, for the sync to rebuild it from the chain. */
  rebuild(accountId: string, dump: unknown): Promise<void> {
    return this.inTurn(accountId, async () => {
      const held = this.held(accountId);
      held.log.prepare_rebuild(JSON.stringify(dump));
      await this.write(held);
    });
  }

  read(accountId: string, part: WalletPart): Promise<unknown[]> {
    return this.inTurn(accountId, async () => JSON.parse(this.held(accountId).log.read(part)) as unknown[]);
  }

  commit(accountId: string, changes: unknown[]): Promise<void> {
    return this.inTurn(accountId, async () => {
      const held = this.held(accountId);
      held.log.prepare(JSON.stringify(changes));
      await this.write(held);
    });
  }

  /** One ledger operation: decided against the wallet as it is, written, then applied. */
  ledger(accountId: string, op: LedgerOp): Promise<unknown> {
    return this.inTurn(accountId, async () => {
      const held = this.held(accountId);
      let answer: string;
      if (KEYED_OPS.has(op.op)) {
        const keys = this.keys();
        if (!keys) throw new Error('wallet is locked');
        answer = held.log.run_with_keys(keys, JSON.stringify(op));
      } else {
        answer = held.log.run(JSON.stringify(op));
      }
      await this.write(held);
      return JSON.parse(answer) as unknown;
    });
  }

  /** Forget a wallet's log entirely. Needs no key. */
  remove(accountId: string): Promise<void> {
    return this.inTurn(accountId, async () => {
      this.logs.get(accountId)?.log.free();
      this.logs.delete(accountId);
      await (await this.storage()).remove(`wallet:${accountId}`);
    });
  }
}
