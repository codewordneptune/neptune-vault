// Sync engine: brings one account up to the node's tip.
//
// One pass: check the last scanned block is still canonical (roll back if
// not), then fetch blocks in batches from the height after the last scanned
// one, hand each batch to the wallet core, and persist what it found.
// Everything the core returns is stored as-is; this file only does
// bookkeeping (UTXO records, block records, history, sync state).

import type { NodeClient } from '../node/rpc';
import type { AccountRecord, BlockRecord, HistoryRecord, Network, UtxoRecord, VaultDb } from '../storage/db';
import { nextKeyIndicesOf } from '../storage/db';
import { NOT_LINKED, type NextKeyIndices, type ScannedBlock, type StoredUtxo, type WalletCore } from './core';

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

/** How many blocks below the tip a fast restore hands over to the ordinary scan. */
export const RESTORE_HANDOVER = 10;

/** A fast restore stops asking after this many rounds and says so, rather than reporting a restore it cannot vouch for. */
const RESTORE_ROUNDS = 40;

export class SyncEngine {
  private node!: NodeClient;
  private readonly batchSize: number;
  private readonly keepBlocks: number;
  private readonly onProgress: (p: SyncProgress) => void;
  /** The node URL that has said it runs this account's network; asked once per node, again when the URL changes. */
  private networkCheckedFor: string | null = null;
  private running = false;
  private stopRequested = false;
  private current: Promise<SyncProgress> | null = null;

  /**
   * `nodeSource` is a node, or how to get the node for a network. The
   * second form lets the engine ask for the node of the account's own
   * network, read from the database, rather than whatever network the
   * settings name at that moment: while the app switches network or wallet
   * those two can differ for an instant, and a pass begun then would hold
   * one wallet's blocks against another network's chain.
   */
  constructor(
    private readonly db: VaultDb,
    private readonly nodeSource: NodeClient | ((network: Network) => NodeClient),
    private readonly core: WalletCore,
    private readonly accountId: string,
    options: SyncOptions = {},
  ) {
    // Mainnet blocks are large (about 170 KB of JSON each); 25 keeps a
    // batch under 5 MB on a phone.
    this.batchSize = options.batchSize ?? 25;
    this.keepBlocks = options.keepBlocks ?? 1000;
    this.onProgress = options.onProgress ?? (() => {});
    if (typeof nodeSource !== 'function') this.node = nodeSource;
  }

  /**
   * Ask a running pass to end, and wait until it has. It ends after the
   * batch in flight, which is not written: a rescan or a lock that follows
   * sees the database exactly as the pass left it before the call.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // A request stalled on a dead connection would keep the pass, and with
    // it whoever waits here (a wallet switch, a rescan, a removal), waiting
    // for the full timeout. Cut it; the batch in flight is unwritten anyway.
    this.node?.abortInFlight?.();
    await this.current?.catch(() => undefined);
  }

  /** One full pass to the tip. Safe to call repeatedly; overlapping calls are ignored. */
  async syncOnce(): Promise<SyncProgress> {
    if (this.running) return this.progress('scanning', await this.syncedHeight(), 0, 'already running');
    this.running = true;
    this.stopRequested = false;
    this.current = this.exclusively(() => this.pass());
    try {
      return await this.current;
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  /**
   * One scanner per wallet across tabs and the installed app. Two at once
   * would interleave their writes to the same coins. Where the browser has
   * no Web Locks the pass runs as before.
   */
  private async exclusively(run: () => Promise<SyncProgress>): Promise<SyncProgress> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return run();
    return locks.request('neptune-vault-sync:' + this.accountId, { ifAvailable: true }, async (lock) => {
      if (lock === null) return { phase: 'scanning' as const, syncedHeight: await this.syncedHeight(), tipHeight: 0, message: 'Another window of this app is syncing this wallet.' };
      return run();
    });
  }

  private async pass(): Promise<SyncProgress> {
    try {
      let account = await this.db.get('accounts', this.accountId);
      if (!account) throw new Error('account not found');
      if (typeof this.nodeSource === 'function') this.node = this.nodeSource(account.network);

      // A node on another network would make every stored block look
      // orphaned and wipe the local view; ask before trusting anything.
      if (this.networkCheckedFor !== this.node.url) {
        const theirs = await this.node.network();
        const ours = account.network;
        if (theirs !== null && !(theirs === ours || (ours === 'testnet' && theirs.startsWith('testnet')))) {
          throw new Error(`This node runs the ${theirs} network and this wallet is on ${ours}. Check the node URL in Settings.`);
        }
        this.networkCheckedFor = this.node.url;
      }

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
      // Only before the first scan: once the wallet has a position on the
      // chain, a node reporting a low tip (stale, wrong, or lying) must not
      // rewrite where this wallet's history starts.
      let state = await this.db.get('syncState', this.accountId);
      if (!state && (account.birthdayHeight === 0 || account.birthdayHeight > tip.height)) {
        const tx = this.db.transaction('accounts', 'readwrite');
        const current = await tx.store.get(this.accountId);
        if (current) await tx.store.put({ ...current, birthdayHeight: tip.height });
        await tx.done;
        account = { ...account, birthdayHeight: tip.height };
      }
      if (state && state.syncedHeight > tip.height) {
        throw new Error(`The node's chain ends at block ${tip.height}, below block ${state.syncedHeight} that this wallet has already scanned. The node may be out of date or on another chain; nothing was changed.`);
      }
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
      // The block each batch must follow: the core refuses an answer that
      // does not link to it, so a reorganisation between the check above
      // and the fetch, or a node on another chain, cannot leave orphaned
      // blocks in the wallet.
      let prevHash = state.syncedHash;
      let unlinked = 0;
      while (height <= tip.height && !this.stopRequested) {
        const to = Math.min(height + this.batchSize - 1, tip.height);
        this.progress('scanning', height - 1, tip.height);
        const blocksResponse = await this.node.getBlocksRaw(height, to);
        // Asked to stop while the batch was in flight: leave it unwritten,
        // and say nothing, since whoever asked is about to start over.
        if (this.stopRequested) return { phase: 'scanning', syncedHeight: height - 1, tipHeight: tip.height };
        const unspent = await this.unspentStored();
        let result;
        try {
          result = await this.core.scanBlocks(blocksResponse, unspent, nextKeyIndices, { from: height, to, prev_hash: prevHash, watch: await this.watchedCommitments() });
        } catch (e) {
          if (!(e instanceof Error) || !e.message.includes(NOT_LINKED)) throw e;
          // The chain moved under the wallet. Find the newest stored block
          // the node still has and go on from there; give up after a few
          // rounds rather than chase a node that never agrees with itself.
          unlinked += 1;
          if (unlinked > 3) throw new Error('The node keeps answering with blocks that do not follow the ones this wallet has scanned. Try again later, or choose another node in Settings.');
          await this.rollBackIfForked(height - 1, prevHash, true);
          const rolled = await this.db.get('syncState', this.accountId);
          height = (rolled?.syncedHeight ?? height - 1) + 1;
          prevHash = rolled?.syncedHash ?? null;
          continue;
        }
        if (result.blocks.length === 0) break;
        nextKeyIndices = result.next_key_indices;
        await this.persist(result.blocks, nextKeyIndices);
        const last = result.blocks[result.blocks.length - 1];
        height = last.height + 1;
        prevHash = last.hash;
      }
      const finalState = await this.db.get('syncState', this.accountId);
      if (this.stopRequested) return { phase: 'scanning', syncedHeight: finalState?.syncedHeight ?? state.syncedHeight, tipHeight: tip.height };
      return this.progress('done', finalState?.syncedHeight ?? state.syncedHeight, tip.height);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A lock ends the core's worker under a running pass. That is the lock
      // doing its job, not a sync failure to show on the next unlock; the
      // batch in flight was not written.
      if (/wallet is locked/i.test(message)) return { phase: 'scanning', syncedHeight: await this.syncedHeight(), tipHeight: 0 };
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
    // Each height scanned, with the coins known at that moment. A block
    // can need a second look: it was scanned for a payment before a coin
    // it spends was known, because that coin sits on a key the first round
    // did not ask about. It gets that look once the known coins change.
    const scanned = new Map<number, string>();
    let nextKeyIndices = nextKeyIndicesOf(account);
    let lowest = tipHeight;
    let settled = false;
    for (let round = 0; round < RESTORE_ROUNDS; round++) {
      this.progress('restoring', scanned.size, tipHeight, 'Asking the node which blocks are yours');
      let heights: number[];
      try {
        heights = await this.node.blockHeightsByFlags(await this.core.announcementFlags(nextKeyIndices));
      } catch (e) {
        if (isMethodNotFound(e)) return 'This node has no coin index, so a fast restore cannot run here. Rescan from a block or a date instead, or choose another node in Settings.';
        throw e;
      }
      const unspent = await this.unspentStored();
      const known = unspent.map((u) => u.hash).sort().join(',');
      const spendHeights = unspent.length > 0 ? await this.node.blockHeightsBySpends(await this.core.absoluteIndexSets(unspent)) : [];
      const again = new Set(spendHeights.filter((h) => scanned.has(h) && scanned.get(h) !== known));
      const todo = [...new Set([...heights, ...spendHeights])]
        .filter((h) => Number.isSafeInteger(h) && h >= 1 && h <= tipHeight && (!scanned.has(h) || again.has(h)))
        .sort((a, b) => a - b);
      if (todo.length === 0) {
        settled = true;
        break;
      }
      for (const [i, height] of todo.entries()) {
        if (this.stopRequested) return 'stopped';
        this.progress('restoring', scanned.size, tipHeight, 'Fast restore: block ' + (i + 1) + ' of ' + todo.length);
        const blocksResponse = await this.node.getBlocksRaw(height, height);
        if (this.stopRequested) return 'stopped';
        // A single block has no neighbour here to link to; the core still
        // checks it is the height asked for and that it was mined.
        const before = await this.unspentStored();
        const result = await this.core.scanBlocks(blocksResponse, before, nextKeyIndices, { from: height, to: height, prev_hash: null, watch: await this.watchedCommitments() });
        scanned.set(height, before.map((u) => u.hash).sort().join(','));
        if (result.blocks.length === 0) continue;
        nextKeyIndices = result.next_key_indices;
        await this.persist(result.blocks, nextKeyIndices);
        lowest = Math.min(lowest, height);
      }
    }
    if (!settled) return 'The fast restore kept finding more after ' + RESTORE_ROUNDS + ' rounds and stopped, so it cannot vouch for the balance. Rescan from a block or a date instead.';
    // Hand over a little below the tip: the ordinary scan then walks the
    // last blocks, checks that they link, and leaves the block records a
    // later reorganisation is measured against. Ending at the tip itself
    // left nothing to roll back to if that tip was orphaned.
    const handover = Math.max(0, tipHeight - RESTORE_HANDOVER);
    const tx = this.db.transaction(['syncState', 'accounts'], 'readwrite');
    await tx.objectStore('syncState').put({ accountId: this.accountId, syncedHeight: handover, syncedHash: null, updatedAt: Date.now() });
    const { restore: _done, ...fresh } = (await tx.objectStore('accounts').get(this.accountId)) ?? account;
    await tx.objectStore('accounts').put({ ...fresh, birthdayHeight: Math.max(1, Math.min(lowest, handover + 1)), restoredAt: Date.now() });
    await tx.done;
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

  /** Output commitments of this wallet's pending sends: a block that carries one has that send in it. */
  private async watchedCommitments(): Promise<string[]> {
    const rows = await this.db.getAllFromIndex('history', 'byAccount', this.accountId);
    return rows.filter((r) => r.kind === 'sent' && r.status === 'pending').flatMap((r) => (r.outputs ?? []).map((o) => o.commitment));
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
  private async rollBackIfForked(syncedHeight: number, syncedHash: string | null, knownForked = false): Promise<number | null> {
    if (!knownForked) {
      if (!syncedHash) return null;
      if (await this.node.isBlockCanonical(syncedHash)) return null;
    }

    const range = IDBKeyRange.bound([this.accountId, 0], [this.accountId, Infinity]);
    const stored = (await this.db.getAllFromIndex('blocks', 'byAccountHeight', range)).filter((b) => b.height < syncedHeight);
    // Blocks are canonical up to the fork and not after it, so the newest
    // canonical one is found by halving: about ten questions for a thousand
    // stored blocks, where walking down could take a thousand.
    let target: BlockRecord | null = null;
    let low = 0;
    let high = stored.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (await this.node.isBlockCanonical(stored[mid].hash)) {
        target = stored[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    // Not one block this wallet knows is on the node's chain. A real
    // reorganisation never goes that deep; a node on another chain, out of
    // date, or lying does exactly this. Dropping the whole local view on
    // its word would be the node deciding; the person decides, by rescanning.
    if (target === null && stored.length > 0) {
      throw new Error('None of the blocks this wallet has scanned are on this node\'s chain. The node may be on another chain or out of date. Nothing was changed. If you trust this node, rescan from Settings.');
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
    // Coins held by this device's pending sends. A coin written afresh (after
    // a rollback removed it) is held again, or it would look spendable while
    // a transaction that spends it is still out there.
    const heldBy = new Map<string, string>();
    for (const h of await historyStore.index('byAccount').getAll(this.accountId)) {
      if (h.kind === 'sent' && h.status === 'pending' && h.txid !== '' && !h.key.includes(':outgoing:')) for (const input of h.inputHashes) heldBy.set(input, h.txid);
    }

    for (const block of blocks) {
      for (const u of block.incoming) {
        // The same block can be written twice: a fast restore looks again at
        // a block once it knows more coins, and two tabs can scan at once.
        // What is already known about the coin (spent, or held) stays.
        const existing = await utxoStore.get(`${this.accountId}:${u.hash}`);
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
          spentHeight: existing?.spentHeight ?? null,
          spentTxid: existing?.spentTxid ?? null,
          pendingTxid: existing ? existing.pendingTxid : (heldBy.get(u.hash) ?? null),
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
          releaseDateMs: u.release_date_ms,
        };
        await historyStore.put(received);
        // The same output was perhaps seen in the mempool first.
        if (u.commitment) await historyStore.delete(`${this.accountId}:incoming:${u.commitment}`);
      }

      // Inputs spent by a transaction this device did not build, such as a
      // send from another device with the same phrase.
      const elsewhere: string[] = [];
      let spentNau = 0n;
      const seen = new Set(block.seen ?? []);
      for (const hash of block.spent) {
        const key = `${this.accountId}:${hash}`;
        const existing = await utxoStore.get(key);
        if (!existing) continue;
        const sent = existing.pendingTxid ? await historyStore.get(`${this.accountId}:sent:${existing.pendingTxid}`) : undefined;
        // A send is in this block when the block carries its outputs. Its
        // inputs being spent is not enough: another device with the same
        // seed phrase can spend the same coins in another transaction, and
        // then this send never reached its recipient. Rows from before
        // outputs were recorded have nothing to compare and keep the old rule.
        const recorded = sent?.outputs ?? [];
        const mine = sent !== undefined && (recorded.length === 0 || recorded.some((o) => seen.has(o.commitment)));
        await utxoStore.put({ ...existing, spentHeight: block.height, spentTxid: mine ? existing.pendingTxid : null, pendingTxid: mine ? existing.pendingTxid : null });
        if (sent && mine) {
          if (sent.status === 'pending') await historyStore.put({ ...sent, status: 'confirmed', height: block.height });
        } else {
          if (sent && sent.status === 'pending') {
            await historyStore.put({ ...sent, status: 'failed', height: block.height, error: 'Not sent: its coins were spent by another transaction, made elsewhere with this seed phrase.' });
            // Whatever else it held is free again.
            for (const other of await utxoStore.index('byAccount').getAll(this.accountId)) {
              if (other.pendingTxid === sent.txid && other.spentHeight === null && other.key !== key) await utxoStore.put({ ...other, pendingTxid: null });
            }
          }
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
