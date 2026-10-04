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

import { NodeError, nodeNetworkLabel, type NodeClient } from '../node/rpc';
import { networkLabel } from '../util/network';
import type { Network, VaultDb } from '../storage/db';
import { NOT_LINKED, type LedgerAnswer, type LedgerOp, type ScanSettings, type WalletCore } from '../backend/types';

export interface SyncProgress {
  phase: 'checking' | 'restoring' | 'scanning' | 'done' | 'error';
  syncedHeight: number;
  tipHeight: number;
  message?: string;
  /** When the node's newest block was made, by the chain's clock. */
  tipTimestampMs?: number;
  /** An error because the node did not answer as a node, rather than a problem with the wallet. */
  nodeDown?: boolean;
  /** The node answered too slowly to sync; the app waits longer before trying again. */
  slow?: boolean;
  /** Sends this pass found no block can take any more: their ids. */
  expired?: string[];
  /** How much of the pass under way is done, in blocks: for its percentage and the time left. */
  work?: { done: number; total: number };
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
const NO_INDEX = 'This node does not support fast restore. Rescan from a block or a date instead, or choose another node in Settings.';

/** A fast restore stops asking after this many rounds and says so, rather than reporting a restore it cannot vouch for. */
const RESTORE_ROUNDS = 40;

/** Where a wallet made while the node could not be reached starts: this long before it was made. */
const START_MARGIN_MS = 24 * 60 * 60 * 1000;

/** The fast restore's progress, kept in the sealed log so an interrupted one carries on where it was. */
const RESTORE_PROGRESS = 'fastRestoreProgress';

/** What the full-storage message says, whatever the storage underneath called it. */
export const STORAGE_FULL = 'This device is out of storage space for the wallet. Your coins are safe on the chain; free some space, then sync again.';

/** Storage refusing a write for want of space: IndexedDB's quota, or a full disk under the desktop app. */
function isStorageFull(message: string): boolean {
  return /quota|no space left|not enough space|disk (is )?full|os error (28|112)/i.test(message);
}

/** A short digest of a text: to tell two sets of coins apart without keeping either. */
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Blocks asked for in one batch, per wallet, across passes: halved after a
 * batch the node was too slow to send, grown back after batches that came.
 */
const batchFor = new Map<string, number>();

/** Forget how slow a wallet's node was: the wallet was removed, or the tests start afresh. */
export function forgetBatchSize(accountId?: string): void {
  if (accountId === undefined) batchFor.clear();
  else batchFor.delete(accountId);
}

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
  /** The node's newest block time, as last seen: for telling a node that has fallen behind. */
  private tipTimestampMs: number | undefined;

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
          throw new Error(`This node runs ${nodeNetworkLabel(theirs)}, and this wallet is on ${networkLabel(ours)}. Check the node URL in Settings.`);
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
      this.tipTimestampMs = typeof tip.timestamp === 'number' ? tip.timestamp : undefined;
      // The engine sets a missing start height to the block of the wallet's
      // creation (less a margin) when that can be found, else to the tip,
      // and a too-high one to the tip, but only before the first scan; and
      // refuses a node whose tip is below what this wallet has already scanned.
      let position = await this.ledger({ op: 'startPass', tipHeight: tip.height, startHint: await this.startHint(account.createdAt) });

      this.progress('checking', position.syncedHeight, tip.height);
      const rolledBackTo = await this.rollBackIfForked(position.syncedHeight, position.syncedHash);
      if (rolledBackTo !== null) position = await this.ledger({ op: 'startPass', tipHeight: tip.height });

      let height = position.syncedHeight + 1;
      const passStart = position.syncedHeight;
      // The block each batch must follow: the core refuses an answer that
      // does not link to it, so a reorganisation between the check above
      // and the fetch, or a node on another chain, cannot leave orphaned
      // blocks in the wallet.
      let prevHash = position.syncedHash;
      let unlinked = 0;
      let batch = batchFor.get(this.accountId) ?? this.batchSize;
      let good = 0;
      while (height <= tip.height && !this.stopRequested) {
        const to = Math.min(height + batch - 1, tip.height);
        this.progress('scanning', height - 1, tip.height, undefined, { work: { done: Math.max(0, height - 1 - passStart), total: Math.max(1, tip.height - passStart) } });
        let blocksResponse: string;
        try {
          blocksResponse = await this.node.getBlocksRaw(height, to);
        } catch (e) {
          // Too slow to arrive in time: ask for fewer blocks at once, here
          // and on the passes that follow, rather than fetching the same
          // megabytes again and again. At one block, the node is too slow
          // to reach from here, and the app waits longer before retrying.
          if (!(e instanceof NodeError) || e.code !== 'timeout' || this.stopRequested) throw e;
          if (batch > 1) {
            batch = Math.max(1, Math.floor(batch / 2));
            batchFor.set(this.accountId, batch);
            continue;
          }
          return this.progress('error', height - 1, tip.height, 'The node is too slow to reach from here, so syncing is paused. It tries again in a few minutes, or retry now.', { nodeDown: true, slow: true });
        }
        // Batches that arrive earn back their size, a step at a time.
        if (batch < this.batchSize && ++good >= 4) {
          batch = Math.min(this.batchSize, batch * 2);
          good = 0;
          if (batch >= this.batchSize) batchFor.delete(this.accountId);
          else batchFor.set(this.accountId, batch);
        }
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
      // Sends of this device no block can take any more, by the chain's
      // clock: their coins are released and they are marked as expired.
      const expired = typeof tip.timestamp === 'number' && tip.timestamp > 0 ? await this.ledger({ op: 'expireSends', tipTimestampMs: tip.timestamp }) : [];
      return this.progress('done', synced, tip.height, undefined, expired.length > 0 ? { expired } : {});
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // A lock ends the core's worker under a running pass. That is the lock
      // doing its job, not a sync failure to show on the next unlock; the
      // batch in flight was not written.
      if (/wallet is locked/i.test(raw)) return { phase: 'scanning', syncedHeight: await this.syncedHeight(), tipHeight: 0 };
      const message = isStorageFull(raw) ? STORAGE_FULL : raw;
      const nodeDown = e instanceof NodeError && typeof e.code !== 'number';
      return this.progress('error', await this.syncedHeight(), 0, message, nodeDown ? { nodeDown, slow: e.code === 'timeout' } : {});
    }
  }

  /**
   * Where a wallet made while the node could not be reached starts: the
   * block of the day before it was made, looked up once, before its first
   * scan. Null when the start is known, or the node cannot say.
   */
  private async startHint(createdAt: number): Promise<number | null> {
    try {
      const scan = await this.scanSettings();
      const [sync] = (await this.core.storeRead!(this.accountId, 'sync')) as unknown[];
      if (scan.birthdayHeight !== 0 || sync || !(createdAt > START_MARGIN_MS) || typeof this.node.heightForDate !== 'function') return null;
      return await this.node.heightForDate(createdAt - START_MARGIN_MS);
    } catch {
      return null;
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
    // Carried over from an earlier attempt that was cut short (a locked
    // screen, a closed app), so the restore goes on where it was.
    const scanned = await this.restoreProgress();
    const known = async () => digest((await this.ledger({ op: 'unspentHashes' })).sort().join(','));
    let unsaved = 0;
    let lowest = tipHeight;
    let settled = false;
    // One count across the rounds, so a later round does not start again at block 1.
    let doneBefore = 0;
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
      const knownNow = await digest([...unspent].sort().join(','));
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
        this.progress('restoring', scanned.size, tipHeight, 'Finding your payments: block ' + (doneBefore + i + 1) + ' of ' + (doneBefore + todo.length), { work: { done: doneBefore + i, total: doneBefore + todo.length } });
        const blocksResponse = await this.node.getBlocksRaw(height, height);
        if (this.stopRequested) return 'stopped';
        // A single block has no neighbour here to link to; the core still
        // checks it is the height asked for and that it was mined.
        const before = await known();
        const result = await this.ledger({ op: 'scanBlocks', blocksResponse, from: height, to: height, prevHash: null });
        if (result.blocks.length > 0) {
          await this.ledger({ op: 'persistScan', result, keepBlocks: this.keepBlocks, now: Date.now() });
          lowest = Math.min(lowest, height);
        }
        scanned.set(height, before);
        if (++unsaved >= 10) {
          await this.keepRestoreProgress(scanned);
          unsaved = 0;
        }
      }
      await this.keepRestoreProgress(scanned);
      unsaved = 0;
      doneBefore += todo.length;
    }
    if (!settled) return 'Fast restore stopped after ' + RESTORE_ROUNDS + ' rounds without finishing, so the balance may be incomplete. Rescan from a block or a date instead.';
    // Hand over a little below the tip: the ordinary scan then walks the
    // last blocks, checks that they link, and leaves the block records a
    // later reorganisation is measured against. Ending at the tip itself
    // left nothing to roll back to if that tip was orphaned.
    const handover = Math.max(0, tipHeight - RESTORE_HANDOVER);
    await this.ledger({ op: 'finishFastRestore', handover, lowest, now: Date.now() });
    await this.core.storeCommit?.(this.accountId, [{ op: 'deletePrivate', key: RESTORE_PROGRESS }]).catch(() => undefined);
    return 'done';
  }

  /** The heights an interrupted fast restore had scanned, each with the coins known then (as a digest). */
  private async restoreProgress(): Promise<Map<number, string>> {
    try {
      const notes = (await this.core.storeRead!(this.accountId, 'private')) as { key: string; value: { scanned?: [number, string][] } }[];
      const saved = notes.find((n) => n.key === RESTORE_PROGRESS)?.value.scanned;
      return new Map(Array.isArray(saved) ? saved.filter((e) => Array.isArray(e) && Number.isSafeInteger(e[0]) && typeof e[1] === 'string') : []);
    } catch {
      return new Map();
    }
  }

  private async keepRestoreProgress(scanned: Map<number, string>): Promise<void> {
    await this.core.storeCommit?.(this.accountId, [{ op: 'putPrivate', key: RESTORE_PROGRESS, value: { scanned: [...scanned] } }]).catch(() => undefined);
  }

  private progress(phase: SyncProgress['phase'], syncedHeight: number, tipHeight: number, message?: string, more: Partial<SyncProgress> = {}): SyncProgress {
    const p: SyncProgress = { phase, syncedHeight, tipHeight, message, tipTimestampMs: this.tipTimestampMs, ...more };
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
      throw new Error('None of the blocks this wallet has scanned are on this node\'s chain. The node may be on another chain or out of date. Nothing was changed. If you trust this node, rescan in Settings.');
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
