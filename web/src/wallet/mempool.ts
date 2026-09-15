// Watching the node's mempool for what concerns this wallet: payments on
// their way in, and whether the wallet's own pending sends are still held.
//
// The node lists transaction ids and hands out kernels one by one; the
// wallet scans each unseen kernel with its keys, the same way it scans
// blocks. Rows are keyed by output commitment, not by transaction id: the
// node rewrites kernels (and their ids) as blocks arrive, but the
// commitment of an output never changes, and the block scan carries the
// same commitment when the output is finally confirmed.

import type { HistoryRecord, VaultDb } from '../storage/db';
import type { NextKeyIndices, StoredUtxo, WalletCore } from './core';
import { nextKeyIndicesOf } from '../storage/db';

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

  constructor(
    private readonly db: VaultDb,
    private readonly node: MempoolNode,
    private readonly core: Pick<WalletCore, 'scanMempoolKernel'>,
    private readonly accountId: string,
    options: MempoolWatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 30;
    this.patience = options.patience ?? 2;
    this.now = options.now ?? (() => Date.now());
  }

  /** One round: new kernels scanned, pending rows kept in step, own sends checked. */
  async poll(): Promise<{ scanned: number; incoming: number; incomingNau: string }> {
    if (this.disabled) return { scanned: 0, incoming: 0, incomingNau: '0' };
    let ids: string[];
    try {
      ids = await this.node.mempoolTransactions();
    } catch (e) {
      if (isMethodNotFound(e)) {
        this.disabled = true;
        return { scanned: 0, incoming: 0, incomingNau: '0' };
      }
      throw e;
    }
    this.polls += 1;
    const current = new Set(ids);

    const account = await this.db.get('accounts', this.accountId);
    const utxoRows = await this.db.getAllFromIndex('utxos', 'byAccount', this.accountId);
    const unspent = utxoRows.filter((r) => r.spentHeight === null).map((r) => r.stored as StoredUtxo);
    const nextKeyIndices: NextKeyIndices = account ? nextKeyIndicesOf(account) : { generation: 0, ec_hybrid: 0, viewing: 0 };

    // Unseen kernels, a batch at a time so a busy mempool never means one
    // long burst of downloads; the rest are picked up by the next polls.
    const fresh = ids.filter((id) => !this.seenIds.has(id)).slice(0, this.batchSize);
    // Outputs of this wallet's own pending sends (their change, or a payment
    // to itself) are addressed to this wallet too, and are not incoming.
    const allHistory = await this.db.getAllFromIndex('history', 'byAccount', this.accountId);
    const ownOutputs = new Set(
      allHistory.filter((h) => h.kind === 'sent' && h.status === 'pending' && h.recipient !== null).flatMap((h) => (h.outputs ?? []).map((o) => o.commitment)),
    );
    const amountOf = new Map(utxoRows.map((r) => [r.hash, BigInt(r.amountNau)] as const));
    let incoming = 0;
    let incomingNau = 0n;
    for (const id of fresh) {
      const raw = await this.node.mempoolKernelRaw(id);
      const scan = await this.core.scanMempoolKernel(raw, unspent, nextKeyIndices);
      this.seenIds.add(id);
      const ownSend = scan.incoming.some((o) => ownOutputs.has(o.commitment));
      const arriving = scan.incoming.filter((o) => !ownOutputs.has(o.commitment));
      const timestampMs = scan.timestamp_ms || this.now();

      if (scan.spent.length > 0 && !ownSend) {
        // This wallet's coins, spent by a transaction it did not build: one
        // pending "sent" row, what comes back counted as change, and the
        // coins held so the balance does not offer them again.
        const spentHashes = [...scan.spent].sort();
        const key = outgoingKey(this.accountId, spentHashes[0]);
        for (const o of arriving) this.lastSeen.set(o.commitment, this.polls);
        if (!(await this.db.get('history', key))) {
          const spentNau = spentHashes.reduce((sum, h) => sum + (amountOf.get(h) ?? 0n), 0n);
          const backNau = arriving.reduce((sum, o) => sum + BigInt(o.amount_nau), 0n);
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
            outputs: arriving.map((o) => ({ commitment: o.commitment, role: 'change' as const })),
          };
          await this.db.put('history', row);
          for (const h of spentHashes) {
            const coin = await this.db.get('utxos', `${this.accountId}:${h}`);
            if (coin && coin.pendingTxid === null) await this.db.put('utxos', { ...coin, pendingTxid: id });
          }
        }
        continue;
      }

      for (const out of arriving) {
        this.lastSeen.set(out.commitment, this.polls);
        const key = incomingKey(this.accountId, out.commitment);
        if (await this.db.get('history', key)) continue;
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
        };
        await this.db.put('history', row);
        incoming += 1;
        incomingNau += BigInt(out.amount_nau);
      }
    }
    // Ids that left the mempool are forgotten, so a rewritten transaction
    // that comes back under a new id is scanned again (and deduplicated by
    // commitment).
    for (const id of [...this.seenIds]) if (!current.has(id)) this.seenIds.delete(id);

    // A pending row whose transaction the node no longer holds, and which
    // no block confirmed, goes after a little patience.
    const pending = (await this.db.getAllFromIndex('history', 'byAccount', this.accountId)).filter(
      (h) => h.status === 'pending' && (h.key.includes(`:${INCOMING_KEY_PREFIX}`) || h.key.includes(`:${OUTGOING_KEY_PREFIX}`)),
    );
    for (const row of pending) {
      const marker = row.outputs?.[0]?.commitment ?? row.key;
      // An "incoming" row for this wallet's own change (written before own
      // sends were recognised) goes at once.
      if (row.kind === 'received' && ownOutputs.has(marker)) {
        await this.db.delete('history', row.key);
        this.lastSeen.delete(marker);
        continue;
      }
      if (current.has(row.txid)) {
        this.lastSeen.set(marker, this.polls);
        continue;
      }
      const seen = this.lastSeen.get(marker) ?? this.polls;
      if (this.polls - seen >= this.patience) {
        await this.db.delete('history', row.key);
        this.lastSeen.delete(marker);
        // Coins held for a spend that went away are offered again.
        for (const h of row.inputHashes) {
          const coin = await this.db.get('utxos', `${this.accountId}:${h}`);
          if (coin && coin.pendingTxid === row.txid && coin.spentHeight === null) await this.db.put('utxos', { ...coin, pendingTxid: null });
        }
      }
    }

    await this.checkOwnSends();
    return { scanned: fresh.length, incoming, incomingNau: incomingNau.toString() };
  }

  /** Whether the node still holds each of this wallet's pending sends. */
  private async checkOwnSends(): Promise<void> {
    const rows = (await this.db.getAllFromIndex('history', 'byAccount', this.accountId)).filter(
      (h) => h.kind === 'sent' && h.status === 'pending' && (h.outputs?.length ?? 0) > 0,
    );
    if (rows.length === 0) return;
    const wanted = rows.flatMap((h) => (h.outputs ?? []).map((o) => o.commitment));
    const present = await this.node.mempoolHasOutputs(wanted);
    const at = this.now();
    for (const row of rows) {
      const held = (row.outputs ?? []).some((o) => present.has(o.commitment));
      const next: HistoryRecord = { ...row, mempoolSeenAt: held ? at : row.mempoolSeenAt ?? null, mempoolCheckedAt: at };
      await this.db.put('history', next);
    }
  }
}

function isMethodNotFound(e: unknown): boolean {
  const message = (e as Error)?.message ?? '';
  return /method not found|-32601/i.test(message);
}
