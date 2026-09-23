// Watching the node's mempool for what concerns this wallet: payments on
// their way in, and whether the wallet's own pending sends are still held.
//
// The node lists transaction ids and hands out kernels one by one; the
// wallet scans each unseen kernel with its keys, the same way it scans
// blocks. Rows are keyed by output commitment, not by transaction id: the
// node rewrites kernels (and their ids) as blocks arrive, but the
// commitment of an output never changes, and the block scan carries the
// same commitment when the output is finally confirmed.
//
// What this watcher sees it keeps in memory; what it writes, the engine
// writes, deciding against the wallet as it is at that moment. A row it
// means to add is added only if it is not there already, and a coin it
// means to hold is held only if nothing has spent or taken it meanwhile.

import type { HistoryRecord, UtxoRecord } from '../storage/db';
import type { LedgerAnswer, LedgerOp, WalletCore } from '../backend/types';

export interface MempoolNode {
  mempoolTransactions(): Promise<string[]>;
  mempoolKernelRaw(id: string): Promise<string>;
  mempoolHasOutputs(commitments: string[]): Promise<Set<string>>;
}

export interface MempoolWatcherOptions {
  /** Kernels fetched per poll; the rest wait for the next poll. */
  batchSize?: number;
  /** Polls a commitment may be absent before its pending row is dropped. */
  patience?: number;
  now?: () => number;
  /** Whether this wallet's keys are still the ones loaded in the core. Asked around every scan. */
  isCurrent?: () => boolean;
}

export const INCOMING_KEY_PREFIX = 'incoming:';
export const incomingKey = (accountId: string, commitment: string) => `${accountId}:${INCOMING_KEY_PREFIX}${commitment}`;
/** A pending spend of this wallet's coins by a transaction it did not build (another device, same phrase). */
export const OUTGOING_KEY_PREFIX = 'outgoing:';
export const outgoingKey = (accountId: string, firstInputHash: string) => `${accountId}:${OUTGOING_KEY_PREFIX}${firstInputHash}`;

export class MempoolWatcher {
  private readonly seenIds = new Set<string>();
  /** Poll number at which each pending commitment was last seen in the mempool. */
  private readonly lastSeen = new Map<string, number>();
  private polls = 0;
  /** Set once the node says the mempool namespace is not enabled. */
  disabled = false;
  private readonly batchSize: number;
  private readonly patience: number;
  private readonly now: () => number;
  private readonly isCurrent: () => boolean;

  constructor(
    private readonly node: MempoolNode,
    private readonly core: Pick<WalletCore, 'ledger' | 'storeRead'>,
    private readonly accountId: string,
    options: MempoolWatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 30;
    this.patience = options.patience ?? 2;
    this.now = options.now ?? (() => Date.now());
    this.isCurrent = options.isCurrent ?? (() => true);
  }

  private ledger<O extends LedgerOp>(op: O): Promise<LedgerAnswer<O>> {
    if (!this.core.ledger) return Promise.reject(new Error('This build of the wallet core keeps no wallet data.'));
    return this.core.ledger(this.accountId, op);
  }

  private async rows(): Promise<HistoryRecord[]> {
    return (await this.core.storeRead!(this.accountId, 'history')) as HistoryRecord[];
  }

  /** One round: new kernels scanned, pending rows kept in step, own sends checked. */
  async poll(): Promise<{ scanned: number; incoming: number; incomingNau: string; lockedNau: string }> {
    if (this.disabled) return { scanned: 0, incoming: 0, incomingNau: '0', lockedNau: '0' };
    let ids: string[];
    try {
      ids = await this.node.mempoolTransactions();
    } catch (e) {
      if (isMethodNotFound(e)) {
        this.disabled = true;
        return { scanned: 0, incoming: 0, incomingNau: '0', lockedNau: '0' };
      }
      throw e;
    }
    this.polls += 1;
    const current = new Set(ids);

    const utxoRows = (await this.core.storeRead!(this.accountId, 'utxos')) as UtxoRecord[];

    // Unseen kernels, a batch at a time so a busy mempool never means one
    // long burst of downloads; the rest are picked up by the next polls.
    const fresh = ids.filter((id) => !this.seenIds.has(id)).slice(0, this.batchSize);
    // Outputs of this wallet's own pending sends (their change, or a payment
    // to itself) are addressed to this wallet too, and are not incoming.
    const allHistory = await this.rows();
    const ownOutputs = new Set(
      allHistory.filter((h) => h.kind === 'sent' && h.status === 'pending' && h.recipient !== null).flatMap((h) => (h.outputs ?? []).map((o) => o.commitment)),
    );
    const amountOf = new Map(utxoRows.map((r) => [r.hash, BigInt(r.amountNau)] as const));
    let incoming = 0;
    let incomingNau = 0n;
    let lockedNau = 0n;
    for (const id of fresh) {
      // The core scans with whatever keys are loaded. If the wallet was
      // switched or locked since this poll began, those are not this
      // wallet's keys, and nothing they find belongs in its rows.
      if (!this.isCurrent()) break;
      let scan;
      try {
        const kernelResponse = await this.node.mempoolKernelRaw(id);
        // Against the wallet's coins, keys and synced tip as they are now.
        scan = await this.ledger({ op: 'scanMempoolKernel', kernelResponse });
      } catch (e) {
        // The node not answering ends this round; the id is tried again next
        // time. A kernel that cannot be read is another matter: it would be
        // first in line at every poll and stall the watcher for as long as
        // it sat in the mempool, so it is passed over.
        if (isUnreachable(e)) throw e;
        this.seenIds.add(id);
        continue;
      }
      if (!this.isCurrent()) break;
      this.seenIds.add(id);
      // Three kinds of output can be addressed to this wallet: one of a send
      // this device recorded (nothing to add), one this seed built elsewhere
      // (change of a spend made from another device), and a payment from
      // someone else. The keys tell the second from the third exactly; the
      // recorded outputs cover sends from before the keys were consulted.
      const recorded = scan.incoming.some((o) => ownOutputs.has(o.commitment));
      const ownBack = scan.incoming.filter((o) => o.own && !ownOutputs.has(o.commitment));
      const arriving = scan.incoming.filter((o) => !o.own && !ownOutputs.has(o.commitment));
      const timestampMs = scan.timestamp_ms || this.now();

      if (scan.spent.length > 0 && !recorded) {
        // This wallet's coins, spent by a transaction it did not build: one
        // pending "sent" row, what this seed built counted as change, and
        // the coins held so the balance does not offer them again.
        const spentHashes = [...scan.spent].sort();
        const key = outgoingKey(this.accountId, spentHashes[0]);
        for (const o of ownBack) this.lastSeen.set(o.commitment, this.polls);
        {
          const spentNau = spentHashes.reduce((sum, h) => sum + (amountOf.get(h) ?? 0n), 0n);
          const backNau = ownBack.reduce((sum, o) => sum + BigInt(o.amount_nau), 0n);
          const change = backNau <= spentNau ? backNau : 0n;
          const row: HistoryRecord = {
            key,
            accountId: this.accountId,
            kind: 'sent',
            status: 'pending',
            txid: id,
            amountNau: (spentNau - change).toString(),
            feeNau: null,
            timestampMs,
            height: null,
            inputHashes: spentHashes,
            recipient: null,
            error: null,
            changeNau: change > 0n ? change.toString() : null,
            outputs: ownBack.map((o) => ({ commitment: o.commitment, role: 'change' as const })),
          };
          // Written, and its coins held, unless the row is there already.
          await this.ledger({ op: 'recordOutgoing', row });
        }
      }

      for (const out of arriving) {
        this.lastSeen.set(out.commitment, this.polls);
        const key = incomingKey(this.accountId, out.commitment);
        const row: HistoryRecord = {
          key,
          accountId: this.accountId,
          kind: 'received',
          status: 'pending',
          txid: id,
          amountNau: out.amount_nau,
          feeNau: null,
          timestampMs,
          height: null,
          inputHashes: [],
          recipient: null,
          error: null,
          outputs: [{ commitment: out.commitment, role: 'recipient' }],
          releaseDateMs: out.release_date_ms ?? null,
        };
        if (!(await this.ledger({ op: 'recordIncoming', row }))) continue;
        incoming += 1;
        incomingNau += BigInt(out.amount_nau);
        if (out.release_date_ms && out.release_date_ms > Date.now()) lockedNau += BigInt(out.amount_nau);
      }
    }
    // Ids that left the mempool are forgotten, so a rewritten transaction
    // that comes back under a new id is scanned again (and deduplicated by
    // commitment).
    for (const id of [...this.seenIds]) if (!current.has(id)) this.seenIds.delete(id);

    // A pending row whose transaction the node no longer holds, and which
    // no block confirmed, goes after a little patience.
    const pending = (await this.rows()).filter(
      (h) => h.status === 'pending' && (h.key.includes(`:${INCOMING_KEY_PREFIX}`) || h.key.includes(`:${OUTGOING_KEY_PREFIX}`)),
    );
    // A pending row stays while any transaction in the mempool still carries
    // its output, not only while the one it was first seen in is there:
    // nodes rewrite waiting transactions under new ids (a proof upgrader
    // taking its share of the fee, a block builder merging them), and the
    // payment in them is the same output. Asked of the node in one call; a
    // node that cannot say leaves only the id to go by, as before.
    const markers = pending.map((row) => row.outputs?.[0]?.commitment).filter((c): c is string => Boolean(c));
    let carried = new Set<string>();
    if (markers.length > 0) {
      try {
        carried = await this.node.mempoolHasOutputs(markers);
      } catch (e) {
        if (isUnreachable(e)) throw e;
      }
    }
    for (const row of pending) {
      const marker = row.outputs?.[0]?.commitment ?? row.key;
      // An "incoming" row for this wallet's own change (written before own
      // sends were recognised) goes at once.
      if (row.kind === 'received' && ownOutputs.has(marker)) {
        await this.ledger({ op: 'dropRow', key: row.key });
        this.lastSeen.delete(marker);
        continue;
      }
      if (current.has(row.txid) || carried.has(marker)) {
        this.lastSeen.set(marker, this.polls);
        continue;
      }
      const seen = this.lastSeen.get(marker) ?? this.polls;
      if (this.polls - seen >= this.patience) {
        // Dropped, and the coins it held offered again, unless something
        // else has taken them meanwhile.
        await this.ledger({ op: 'expireRow', key: row.key });
        this.lastSeen.delete(marker);
      }
    }

    await this.checkOwnSends();
    return { scanned: fresh.length, incoming, incomingNau: incomingNau.toString(), lockedNau: lockedNau.toString() };
  }

  /**
   * Whether the node still holds each of this wallet's pending sends. The
   * engine records the answer only on rows that are still pending: a send
   * the sync confirmed while the node was being asked keeps its confirmation.
   */
  private async checkOwnSends(): Promise<void> {
    const rows = (await this.rows()).filter((h) => h.kind === 'sent' && h.status === 'pending' && (h.outputs?.length ?? 0) > 0);
    if (rows.length === 0) return;
    const wanted = rows.flatMap((h) => (h.outputs ?? []).map((o) => o.commitment));
    const present = await this.node.mempoolHasOutputs(wanted);
    await this.ledger({ op: 'markMempoolChecked', asked: rows.map((r) => r.key), present: [...present], at: this.now() });
  }
}

/** The node did not answer at all, as opposed to answering with something unusable. */
function isUnreachable(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 'network' || code === 'timeout' || code === 'http' || /wallet is locked/i.test((e as Error)?.message ?? '');
}

function isMethodNotFound(e: unknown): boolean {
  const message = (e as Error)?.message ?? '';
  return /method not found|-32601/i.test(message);
}
