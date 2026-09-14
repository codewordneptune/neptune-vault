// History as a person reads it: one entry per transaction.
//
// The database keeps one row per event the chain shows: a "sent" row per
// transaction the wallet built, and a "received" row per UTXO that arrived.
// A send therefore also produces a received row for its change, and a send
// to one's own address produces a second one for the payment itself. This
// folds those back into the send, at display time, so older rows benefit too.

import type { HistoryRecord, UtxoRecord } from '../storage/db';

export type EntryKind = 'received' | 'sent' | 'self';

export interface HistoryEntry {
  /** The sent or received row the entry is built from. */
  record: HistoryRecord;
  kind: EntryKind;
  /** Amount shown on the row: what was received, sent, or (for a self-send) the fee. */
  shownNau: bigint;
  /** Effect on the balance once confirmed, negative for outgoing. */
  netNau: bigint;
  /** Change that came back to the wallet, when known. */
  changeNau: bigint | null;
  /** Received rows absorbed into this entry. */
  folded: HistoryRecord[];
}

/** Change of a send: recorded with it, or derived from its inputs for older rows. */
export function changeOf(sent: HistoryRecord, utxos: UtxoRecord[]): bigint | null {
  if (sent.changeNau !== undefined && sent.changeNau !== null) return BigInt(sent.changeNau);
  if (sent.inputHashes.length === 0) return null;
  let total = 0n;
  for (const hash of sent.inputHashes) {
    const input = utxos.find((u) => u.hash === hash);
    if (!input) return null;
    total += BigInt(input.amountNau);
  }
  const change = total - BigInt(sent.amountNau) - BigInt(sent.feeNau ?? '0');
  return change >= 0n ? change : null;
}

export function groupHistory(rows: HistoryRecord[], utxos: UtxoRecord[]): HistoryEntry[] {
  const claimed = new Set<string>();
  const sends = new Map<string, HistoryEntry>();

  for (const sent of rows) {
    if (sent.kind !== 'sent') continue;
    const change = changeOf(sent, utxos);
    const folded: HistoryRecord[] = [];
    let kind: EntryKind = 'sent';
    if (sent.height !== null) {
      // Change and a self-payment both land in the block that confirms the send.
      const sameBlock = rows.filter((r) => r.kind === 'received' && r.height === sent.height);
      if (sent.txid === '') {
        // A spend recorded from the chain alone: its change is, by
        // construction, everything that arrived in that block.
        if (change !== null && change > 0n) {
          for (const r of sameBlock) {
            if (claimed.has(r.key)) continue;
            claimed.add(r.key);
            folded.push(r);
          }
        }
      } else if (change !== null && change > 0n) {
        const c = sameBlock.find((r) => !claimed.has(r.key) && BigInt(r.amountNau) === change);
        if (c) {
          claimed.add(c.key);
          folded.push(c);
        }
      }
      const self = sent.txid === '' ? undefined : sameBlock.find((r) => !claimed.has(r.key) && BigInt(r.amountNau) === BigInt(sent.amountNau));
      if (self) {
        claimed.add(self.key);
        folded.push(self);
        kind = 'self';
      }
    }
    const fee = BigInt(sent.feeNau ?? '0');
    const amount = BigInt(sent.amountNau);
    sends.set(sent.key, {
      record: sent,
      kind,
      shownNau: kind === 'self' ? fee : amount,
      netNau: kind === 'self' ? -fee : -(amount + fee),
      changeNau: change,
      folded,
    });
  }

  const entries: HistoryEntry[] = [];
  for (const r of rows) {
    if (r.kind === 'sent') {
      const e = sends.get(r.key);
      if (e) entries.push(e);
    } else if (!claimed.has(r.key)) {
      const amount = BigInt(r.amountNau);
      entries.push({ record: r, kind: 'received', shownNau: amount, netNau: amount, changeNau: null, folded: [] });
    }
  }
  return entries;
}
