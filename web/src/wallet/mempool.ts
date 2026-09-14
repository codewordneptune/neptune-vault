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
  async poll(): Promise<{ scanned: number; incoming: number }> {
    if (this.disabled) return { scanned: 0, incoming: 0 };
    let ids: string[];
    try {
      ids = await this.node.mempoolTransactions();
    } catch (e) {
      if (isMethodNotFound(e)) {
        this.disabled = true;
        return { scanned: 0, incoming: 0 };
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
    let incoming = 0;
    for (const id of fresh) {
      const raw = await this.node.mempoolKernelRaw(id);
      const scan = await this.core.scanMempoolKernel(raw, unspent, nextKeyIndices);
      this.seenIds.add(id);
      for (const out of scan.incoming) {
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
          timestampMs: scan.timestamp_ms || this.now(),
          height: null,
          inputHashes: [],
          recipient: null,
          error: null,
          outputs: [{ commitment: out.commitment, role: 'recipient' }],
        };
        await this.db.put('history', row);
        incoming += 1;
      }
    }
    // Ids that left the mempool are forgotten, so a rewritten transaction
    // that comes back under a new id is scanned again (and deduplicated by
    // commitment).
    for (const id of [...this.seenIds]) if (!current.has(id)) this.seenIds.delete(id);

    // A pending row whose transaction the node no longer holds, and which
    // no block confirmed, goes after a little patience.
    const pending = (await this.db.getAllFromIndex('history', 'byAccount', this.accountId)).filter(
      (h) => h.kind === 'received' && h.status === 'pending' && h.key.includes(`:${INCOMING_KEY_PREFIX}`),
    );
    for (const row of pending) {
      const commitment = row.outputs?.[0]?.commitment ?? '';
      if (current.has(row.txid)) {
        this.lastSeen.set(commitment, this.polls);
        continue;
      }
      const seen = this.lastSeen.get(commitment) ?? this.polls;
      if (this.polls - seen >= this.patience) {
        await this.db.delete('history', row.key);
        this.lastSeen.delete(commitment);
      }
    }

    await this.checkOwnSends();
    return { scanned: fresh.length, incoming };
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
