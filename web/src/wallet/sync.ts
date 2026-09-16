// Sync engine: brings one account up to the node's tip.
//
// One pass: check the last scanned block is still canonical (roll back if
// not), then fetch blocks in batches from the height after the last scanned
// one, hand each batch to the wallet core, and persist what it found.
// Everything the core returns is stored as-is; this file only does
// bookkeeping (UTXO records, block records, history, sync state).

import type { NodeClient } from '../node/rpc';
import type { AccountRecord, BlockRecord, HistoryRecord, UtxoRecord, VaultDb } from '../storage/db';
import { nextKeyIndicesOf } from '../storage/db';
import type { NextKeyIndices, ScannedBlock, StoredUtxo, WalletCore } from './core';

export interface SyncProgress {
  phase: 'checking' | 'restoring' | 'scanning' | 'done' | 'error';
  syncedHeight: number;
  tipHeight: number;
  message?: string;
}

export interface SyncOptions {
  batchSize?: number;
  /** How many recent block records to keep for reorg detection. */
  keepBlocks?: number;
  onProgress?: (p: SyncProgress) => void;
}

function isMethodNotFound(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /method not found|-32601/i.test(message);
}

export class SyncEngine {
  private readonly batchSize: number;
  private readonly keepBlocks: number;
  private readonly onProgress: (p: SyncProgress) => void;
  private running = false;
  private stopRequested = false;
  private current: Promise<SyncProgress> | null = null;

  constructor(
    private readonly db: VaultDb,
    private readonly node: NodeClient,
    private readonly core: WalletCore,
    private readonly accountId: string,
    options: SyncOptions = {},
  ) {
    // Mainnet blocks are large (about 170 KB of JSON each); 25 keeps a
    // batch under 5 MB on a phone.
    this.batchSize = options.batchSize ?? 25;
    this.keepBlocks = options.keepBlocks ?? 1000;
    this.onProgress = options.onProgress ?? (() => {});
  }

  /**
   * Ask a running pass to end, and wait until it has. It ends after the
   * batch in flight, which is not written: a rescan or a lock that follows
   * sees the database exactly as the pass left it before the call.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.current?.catch(() => undefined);
  }

  /** One full pass to the tip. Safe to call repeatedly; overlapping calls are ignored. */
  async syncOnce(): Promise<SyncProgress> {
    if (this.running) return this.progress('scanning', await this.syncedHeight(), 0, 'already running');
    this.running = true;
    this.stopRequested = false;
    this.current = this.pass();
    try {
      return await this.current;
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  private async pass(): Promise<SyncProgress> {
    try {
      let account = await this.db.get('accounts', this.accountId);
      if (!account) throw new Error('account not found');

      const tip = await this.node.tipHeader();
      if (account.restore === 'fast') {
        const outcome = await this.restoreFast(account, tip.height);
        if (outcome === 'stopped') return { phase: 'restoring', syncedHeight: 0, tipHeight: tip.height };
        if (outcome !== 'done') return this.progress('error', 0, tip.height, outcome);
        account = (await this.db.get('accounts', this.accountId)) ?? account;
      }
      // An account created while the node was unreachable has no start
      // height yet; it starts at the tip seen now, tip block included.
      // A start height above the chain (a typo at import, or a rescan aimed
      // too far ahead) would leave the sync state in the future and skip
      // every block until the chain caught up; it means "from now".
      if (account.birthdayHeight === 0 || account.birthdayHeight > tip.height) {
        account.birthdayHeight = tip.height;
        await this.db.put('accounts', account);
      }
      let state = await this.db.get('syncState', this.accountId);
      if (!state) {
        state = { accountId: this.accountId, syncedHeight: account.birthdayHeight - 1, syncedHash: null, updatedAt: Date.now() };
      }

      this.progress('checking', state.syncedHeight, tip.height);
      const rolledBackTo = await this.rollBackIfForked(state.syncedHeight, state.syncedHash);
      if (rolledBackTo !== null) {
        state = await this.db.get('syncState', this.accountId) ?? state;
      }

      let nextKeyIndices = nextKeyIndicesOf(account);
      let height = state.syncedHeight + 1;
      while (height <= tip.height && !this.stopRequested) {
        const to = Math.min(height + this.batchSize - 1, tip.height);
        this.progress('scanning', height - 1, tip.height);
        const blocksResponse = await this.node.getBlocksRaw(height, to);
        // Asked to stop while the batch was in flight: leave it unwritten,
        // and say nothing, since whoever asked is about to start over.
        if (this.stopRequested) return { phase: 'scanning', syncedHeight: height - 1, tipHeight: tip.height };
        const unspent = await this.unspentStored();
        const result = await this.core.scanBlocks(blocksResponse, unspent, nextKeyIndices);
        if (result.blocks.length === 0) break;
        nextKeyIndices = result.next_key_indices;
        await this.persist(result.blocks, nextKeyIndices);
        const last = result.blocks[result.blocks.length - 1];
        height = last.height + 1;
      }
      const finalState = await this.db.get('syncState', this.accountId);
      if (this.stopRequested) return { phase: 'scanning', syncedHeight: finalState?.syncedHeight ?? state.syncedHeight, tipHeight: tip.height };
      return this.progress('done', finalState?.syncedHeight ?? state.syncedHeight, tip.height);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.progress('error', await this.syncedHeight(), 0, message);
    }
  }

  /**
   * Restore from the node's coin index instead of the chain: ask which
   * blocks carry announcements for this wallet's keys, scan only those,
   * ask where the coins found were spent, scan those blocks too, and go
   * round again while new keys or coins turn up. Ends with the sync
   * position at the tip seen at the start, so the ordinary pass takes
   * over from there. The node learns the wallet's identifiers and coins.
   * Returns 'done', 'stopped', or the reason it could not run.
   */
  private async restoreFast(account: AccountRecord, tipHeight: number): Promise<'done' | 'stopped' | string> {
    const tipHash = await this.node.tipDigest();
    const scanned = new Set<number>();
    let nextKeyIndices = nextKeyIndicesOf(account);
    let lowest = tipHeight;
    for (let round = 0; round < 12; round++) {
      this.progress('restoring', scanned.size, tipHeight, 'Asking the node which blocks are yours');
      let heights: number[];
      try {
        heights = await this.node.blockHeightsByFlags(await this.core.announcementFlags(nextKeyIndices));
      } catch (e) {
        if (isMethodNotFound(e)) return 'This node has no coin index, so a fast restore cannot run here. Rescan from a block or a date instead, or choose another node in Settings.';
        throw e;
      }
      const unspent = await this.unspentStored();
      if (unspent.length > 0) heights.push(...(await this.node.blockHeightsBySpends(await this.core.absoluteIndexSets(unspent))));
      const todo = [...new Set(heights)].filter((h) => h >= 1 && h <= tipHeight && !scanned.has(h)).sort((a, b) => a - b);
      if (todo.length === 0) break;
      for (const [i, height] of todo.entries()) {
        if (this.stopRequested) return 'stopped';
        this.progress('restoring', scanned.size, tipHeight, 'Fast restore: block ' + (i + 1) + ' of ' + todo.length);
        const blocksResponse = await this.node.getBlocksRaw(height, height);
        if (this.stopRequested) return 'stopped';
        const result = await this.core.scanBlocks(blocksResponse, await this.unspentStored(), nextKeyIndices);
        scanned.add(height);
        if (result.blocks.length === 0) continue;
        nextKeyIndices = result.next_key_indices;
        await this.persist(result.blocks, nextKeyIndices);
        lowest = Math.min(lowest, height);
      }
    }
    await this.db.put('syncState', { accountId: this.accountId, syncedHeight: tipHeight, syncedHash: tipHash, updatedAt: Date.now() });
    const { restore: _done, ...fresh } = (await this.db.get('accounts', this.accountId)) ?? account;
    await this.db.put('accounts', { ...fresh, birthdayHeight: lowest, restoredAt: Date.now() });
    return 'done';
  }

  private progress(phase: SyncProgress['phase'], syncedHeight: number, tipHeight: number, message?: string): SyncProgress {
    const p: SyncProgress = { phase, syncedHeight, tipHeight, message };
    this.onProgress(p);
    return p;
  }

  private async syncedHeight(): Promise<number> {
    const s = await this.db.get('syncState', this.accountId);
    return s?.syncedHeight ?? 0;
  }

  /** The wallet's unspent UTXOs in the core's own representation. */
  private async unspentStored(): Promise<StoredUtxo[]> {
    const rows = await this.db.getAllFromIndex('utxos', 'byAccount', this.accountId);
    return rows.filter((r) => r.spentHeight === null).map((r) => r.stored as StoredUtxo);
  }

  /**
   * If the last scanned block is no longer canonical, find the newest stored
   * block that still is and roll the account back to it. Returns the height
   * rolled back to, or null when nothing was forked.
   */
  private async rollBackIfForked(syncedHeight: number, syncedHash: string | null): Promise<number | null> {
    if (!syncedHash) return null;
    if (await this.node.isBlockCanonical(syncedHash)) return null;

    const range = IDBKeyRange.bound([this.accountId, 0], [this.accountId, Infinity]);
    const stored = await this.db.getAllFromIndex('blocks', 'byAccountHeight', range);
    let target: BlockRecord | null = null;
    for (let i = stored.length - 1; i >= 0; i--) {
      if (stored[i].height >= syncedHeight) continue;
      if (await this.node.isBlockCanonical(stored[i].hash)) {
        target = stored[i];
        break;
      }
    }
    const account = await this.db.get('accounts', this.accountId);
    const floor = (account?.birthdayHeight ?? 1) - 1;
    const height = target?.height ?? floor;
    await this.rollBack(height, target?.hash ?? null);
    return height;
  }

  /** Forget everything above `height`, including spends recorded above it. */
  async rollBack(height: number, hash: string | null): Promise<void> {
    const tx = this.db.transaction(['utxos', 'blocks', 'history', 'syncState'], 'readwrite');
    const utxos = await tx.objectStore('utxos').index('byAccount').getAll(this.accountId);
    for (const u of utxos) {
      if (u.confirmedHeight > height) {
        await tx.objectStore('utxos').delete(u.key);
      } else if (u.spentHeight !== null && u.spentHeight > height) {
        await tx.objectStore('utxos').put({ ...u, spentHeight: null, spentTxid: null });
      }
    }
    const blocks = await tx.objectStore('blocks').index('byAccountHeight').getAll(IDBKeyRange.bound([this.accountId, height + 1], [this.accountId, Infinity]));
    for (const b of blocks) await tx.objectStore('blocks').delete(b.key);
    const history = await tx.objectStore('history').index('byAccount').getAll(this.accountId);
    for (const h of history) {
      if (h.height !== null && h.height > height) {
        // Rows the chain produced go; a send this device built goes back to pending.
        if (h.kind === 'received' || h.txid === '') await tx.objectStore('history').delete(h.key);
        else await tx.objectStore('history').put({ ...h, status: 'pending', height: null });
      }
    }
    await tx.objectStore('syncState').put({ accountId: this.accountId, syncedHeight: height, syncedHash: hash, updatedAt: Date.now() });
    await tx.done;
  }

  private async persist(blocks: ScannedBlock[], nextKeyIndices: NextKeyIndices): Promise<void> {
    if (blocks.length === 0) return;
    const tx = this.db.transaction(['utxos', 'blocks', 'history', 'syncState', 'accounts'], 'readwrite');
    const utxoStore = tx.objectStore('utxos');
    const historyStore = tx.objectStore('history');

    for (const block of blocks) {
      for (const u of block.incoming) {
        const record: UtxoRecord = {
          key: `${this.accountId}:${u.hash}`,
          accountId: this.accountId,
          hash: u.hash,
          stored: u,
          amountNau: u.amount_nau,
          amount: u.amount,
          confirmedHeight: u.confirmed_height,
          confirmedTimestampMs: u.confirmed_timestamp_ms,
          releaseDateMs: u.release_date_ms,
          spentHeight: null,
          spentTxid: null,
          pendingTxid: null,
        };
        await utxoStore.put(record);
        const received: HistoryRecord = {
          key: `${this.accountId}:recv:${u.hash}`,
          accountId: this.accountId,
          kind: 'received',
          status: 'confirmed',
          txid: '',
          amountNau: u.amount_nau,
          feeNau: null,
          timestampMs: u.confirmed_timestamp_ms,
          height: u.confirmed_height,
          inputHashes: [],
          recipient: null,
          error: null,
        };
        await historyStore.put(received);
        // The same output was perhaps seen in the mempool first.
        if (u.commitment) await historyStore.delete(`${this.accountId}:incoming:${u.commitment}`);
      }

      // Inputs spent by a transaction this device did not build, such as a
      // send from another device with the same phrase.
      const elsewhere: string[] = [];
      let spentNau = 0n;
      for (const hash of block.spent) {
        const key = `${this.accountId}:${hash}`;
        const existing = await utxoStore.get(key);
        if (!existing) continue;
        await utxoStore.put({ ...existing, spentHeight: block.height, spentTxid: existing.pendingTxid });
        const sent = existing.pendingTxid ? await historyStore.get(`${this.accountId}:sent:${existing.pendingTxid}`) : undefined;
        if (sent) {
          if (sent.status === 'pending') await historyStore.put({ ...sent, status: 'confirmed', height: block.height });
        } else {
          // Not a send this device built (a coin the mempool watcher held
          // for a transaction seen elsewhere lands here too).
          elsewhere.push(hash);
          spentNau += BigInt(existing.amountNau);
        }
      }
      if (elsewhere.length > 0) {
        // One "sent" row for the block. The recipient and the fee are not
        // known here; what came back in the same block is taken as change.
        // Outputs this seed built (change, a payment to itself) come back;
        // a third party's payment in the same block is a receipt.
        const back = block.incoming.filter((u) => u.own_build_height !== null && u.own_build_height !== undefined);
        const backNau = back.reduce((sum, u) => sum + BigInt(u.amount_nau), 0n);
        const change = backNau <= spentNau ? backNau : 0n;
        const elsewhereRow: HistoryRecord = {
          key: `${this.accountId}:spent:${block.height}`,
          accountId: this.accountId,
          kind: 'sent',
          status: 'confirmed',
          txid: '',
          amountNau: (spentNau - change).toString(),
          feeNau: null,
          timestampMs: block.timestamp_ms,
          height: block.height,
          inputHashes: elsewhere,
          recipient: null,
          error: null,
          changeNau: change > 0n ? change.toString() : null,
          outputs: back.filter((u) => u.commitment).map((u) => ({ commitment: u.commitment as string, role: 'change' as const })),
        };
        await historyStore.put(elsewhereRow);
        // The watcher's pending row for the same spend, if any.
        const spentSet = new Set(elsewhere);
        const rows = await historyStore.index('byAccount').getAll(this.accountId);
        for (const r of rows) {
          if (r.status === 'pending' && r.key.includes(':outgoing:') && r.inputHashes.some((h) => spentSet.has(h))) await historyStore.delete(r.key);
        }
      }

      await tx.objectStore('blocks').put({
        key: `${this.accountId}:${block.height}`,
        accountId: this.accountId,
        height: block.height,
        hash: block.hash,
        prevHash: block.prev_hash,
        timestampMs: block.timestamp_ms,
      });
    }

    // Trim old block records; deep reorgs beyond this fall back to a rescan.
    const last = blocks[blocks.length - 1];
    const cutoff = last.height - this.keepBlocks;
    if (cutoff > 0) {
      const old = await tx.objectStore('blocks').index('byAccountHeight').getAll(IDBKeyRange.bound([this.accountId, 0], [this.accountId, cutoff]));
      for (const b of old) await tx.objectStore('blocks').delete(b.key);
    }

    await tx.objectStore('syncState').put({ accountId: this.accountId, syncedHeight: last.height, syncedHash: last.hash, updatedAt: Date.now() });
    const account = await tx.objectStore('accounts').get(this.accountId);
    if (account && JSON.stringify(nextKeyIndicesOf(account)) !== JSON.stringify(nextKeyIndices)) {
      await tx.objectStore('accounts').put({ ...account, nextKeyIndices });
    }
    await tx.done;
  }
}
