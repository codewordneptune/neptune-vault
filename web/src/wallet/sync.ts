// Sync engine: brings one account up to the node's tip.
//
// One pass: check the last scanned block is still canonical (roll back if
// not), then fetch blocks in batches from the height after the last scanned
// one, hand each batch to the wallet core to scan, and have the core write
// down what it found.
//
// This file asks the node and keeps count. Every decision about the
// wallet's coins, history and position is the engine's (the ledger), made
// against the wallet as it is at that moment and written before the next
// one begins, so that this pass, the mempool watcher and a send cannot
// undo one another's work.

import type { NodeClient } from '../node/rpc';
import type { Network, VaultDb } from '../storage/db';
import { NOT_LINKED, type LedgerAnswer, type LedgerOp, type ScanSettings, type WalletCore } from '../backend/types';

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

/** What a fast restore says on a node with no coin index. */
const NO_INDEX = 'This node has no coin index, so a fast restore cannot run here. Rescan from a block or a date instead, or choose another node in Settings.';

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

  private ledger<O extends LedgerOp>(op: O): Promise<LedgerAnswer<O>> {
    if (!this.core.ledger) return Promise.reject(new Error('This build of the wallet core keeps no wallet data.'));
    return this.core.ledger(this.accountId, op);
  }

  /** How this wallet is scanned, as the engine keeps it. */
  private async scanSettings(): Promise<ScanSettings> {
    const [scan] = (await this.core.storeRead!(this.accountId, 'scan')) as ScanSettings[];
    if (!scan) throw new Error('This wallet has no scan state.');
    return scan;
  }

  /**
   * Ask a running pass to end, and wait until it has. It ends after the
   * batch in flight, which is not written: a rescan or a lock that follows
   * sees the wallet exactly as the pass left it before the call.
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
   * would scan the same blocks twice. Where the browser has no Web Locks
   * the pass runs as before.
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
      const account = await this.db.get('accounts', this.accountId);
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
      const restore = (await this.scanSettings()).restore;
      if (restore === 'fast' || restore === 'rebuild') {
        const outcome = await this.restoreFast(tip.height);
        if (outcome === 'stopped') return { phase: 'restoring', syncedHeight: 0, tipHeight: tip.height };
        // A rebuild nobody asked for does not stop at a node without an
        // index: it goes on as a plain scan from the start height.
        if (outcome === NO_INDEX && restore === 'rebuild') await this.ledger({ op: 'clearRestore' });
        else if (outcome !== 'done') return this.progress('error', 0, tip.height, outcome);
      }
      // The engine sets a missing or too-high start height to the tip, but
      // only before the first scan, and refuses a node whose tip is below
      // what this wallet has already scanned.
      let position = await this.ledger({ op: 'startPass', tipHeight: tip.height });

      this.progress('checking', position.syncedHeight, tip.height);
      const rolledBackTo = await this.rollBackIfForked(position.syncedHeight, position.syncedHash);
      if (rolledBackTo !== null) position = await this.ledger({ op: 'startPass', tipHeight: tip.height });

      let height = position.syncedHeight + 1;
      // The block each batch must follow: the core refuses an answer that
      // does not link to it, so a reorganisation between the check above
      // and the fetch, or a node on another chain, cannot leave orphaned
      // blocks in the wallet.
      let prevHash = position.syncedHash;
      let unlinked = 0;
      while (height <= tip.height && !this.stopRequested) {
        const to = Math.min(height + this.batchSize - 1, tip.height);
        this.progress('scanning', height - 1, tip.height);
        const blocksResponse = await this.node.getBlocksRaw(height, to);
        // Asked to stop while the batch was in flight: leave it unwritten,
        // and say nothing, since whoever asked is about to start over.
        if (this.stopRequested) return { phase: 'scanning', syncedHeight: height - 1, tipHeight: tip.height };
        let result;
        try {
          // Scanned against the wallet's coins and keys as they are now.
          result = await this.ledger({ op: 'scanBlocks', blocksResponse, from: height, to, prevHash });
        } catch (e) {
          if (!(e instanceof Error) || !e.message.includes(NOT_LINKED)) throw e;
          // The chain moved under the wallet. Find the newest stored block
          // the node still has and go on from there; give up after a few
          // rounds rather than chase a node that never agrees with itself.
          unlinked += 1;
          if (unlinked > 3) throw new Error('The node keeps answering with blocks that do not follow the ones this wallet has scanned. Try again later, or choose another node in Settings.');
          await this.rollBackIfForked(height - 1, prevHash, true);
          const rolled = await this.ledger({ op: 'startPass', tipHeight: tip.height });
          height = rolled.syncedHeight + 1;
          prevHash = rolled.syncedHash;
          continue;
        }
        if (result.blocks.length === 0) break;
        await this.ledger({ op: 'persistScan', result, keepBlocks: this.keepBlocks, now: Date.now() });
        const last = result.blocks[result.blocks.length - 1];
        height = last.height + 1;
        prevHash = last.hash;
      }
      const synced = await this.syncedHeight();
      if (this.stopRequested) return { phase: 'scanning', syncedHeight: synced, tipHeight: tip.height };
      return this.progress('done', synced, tip.height);
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
   * position a little below the tip seen at the start, so the ordinary
   * pass takes over from there. The node learns the wallet's identifiers
   * and coins. Returns 'done', 'stopped', or the reason it could not run.
   */
  private async restoreFast(tipHeight: number): Promise<'done' | 'stopped' | string> {
    // Each height scanned, with the coins known at that moment. A block
    // can need a second look: it was scanned for a payment before a coin
    // it spends was known, because that coin sits on a key the first round
    // did not ask about. It gets that look once the known coins change.
    const scanned = new Map<number, string>();
    const known = async () => (await this.ledger({ op: 'unspentHashes' })).sort().join(',');
    let lowest = tipHeight;
    let settled = false;
    for (let round = 0; round < RESTORE_ROUNDS; round++) {
      this.progress('restoring', scanned.size, tipHeight, 'Asking the node which blocks are yours');
      let heights: number[];
      try {
        heights = await this.node.blockHeightsByFlags(await this.ledger({ op: 'announcementFlags' }));
      } catch (e) {
        if (isMethodNotFound(e)) return NO_INDEX;
        throw e;
      }
      const unspent = await this.ledger({ op: 'unspentHashes' });
      const knownNow = [...unspent].sort().join(',');
      const spendHeights = unspent.length > 0 ? await this.node.blockHeightsBySpends(await this.ledger({ op: 'absoluteIndexSets' })) : [];
      const again = new Set(spendHeights.filter((h) => scanned.has(h) && scanned.get(h) !== knownNow));
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
        const before = await known();
        const result = await this.ledger({ op: 'scanBlocks', blocksResponse, from: height, to: height, prevHash: null });
        scanned.set(height, before);
        if (result.blocks.length === 0) continue;
        await this.ledger({ op: 'persistScan', result, keepBlocks: this.keepBlocks, now: Date.now() });
        lowest = Math.min(lowest, height);
      }
    }
    if (!settled) return 'The fast restore kept finding more after ' + RESTORE_ROUNDS + ' rounds and stopped, so it cannot vouch for the balance. Rescan from a block or a date instead.';
    // Hand over a little below the tip: the ordinary scan then walks the
    // last blocks, checks that they link, and leaves the block records a
    // later reorganisation is measured against. Ending at the tip itself
    // left nothing to roll back to if that tip was orphaned.
    const handover = Math.max(0, tipHeight - RESTORE_HANDOVER);
    await this.ledger({ op: 'finishFastRestore', handover, lowest, now: Date.now() });
    return 'done';
  }

  private progress(phase: SyncProgress['phase'], syncedHeight: number, tipHeight: number, message?: string): SyncProgress {
    const p: SyncProgress = { phase, syncedHeight, tipHeight, message };
    this.onProgress(p);
    return p;
  }

  /** How far this wallet has scanned, for progress; 0 when that cannot be read (a locked wallet). */
  private async syncedHeight(): Promise<number> {
    try {
      const [sync] = (await this.core.storeRead!(this.accountId, 'sync')) as { syncedHeight: number }[];
      return sync?.syncedHeight ?? 0;
    } catch {
      return 0;
    }
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

    const stored = await this.ledger({ op: 'forkCandidates', below: syncedHeight });
    // Blocks are canonical up to the fork and not after it, so the newest
    // canonical one is found by halving: about ten questions for a thousand
    // stored blocks, where walking down could take a thousand.
    let target: [number, string] | null = null;
    let low = 0;
    let high = stored.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (await this.node.isBlockCanonical(stored[mid][1])) {
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
    const height = target?.[0] ?? (await this.ledger({ op: 'rollbackFloor' }));
    await this.rollBack(height, target?.[1] ?? null);
    return height;
  }

  /** Forget everything above `height`, including spends recorded above it. */
  async rollBack(height: number, hash: string | null): Promise<void> {
    await this.ledger({ op: 'rollBack', height, hash, now: Date.now() });
  }
}
