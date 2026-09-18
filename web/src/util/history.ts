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

/** The coin key a received row stands for: what follows "recv:" in its key. The coin key holds a colon itself. */
export function coinKeyOfReceipt(row: Pick<HistoryRecord, 'key'>): string {
  const at = row.key.indexOf(':recv:');
  return at < 0 ? row.key.slice(row.key.lastIndexOf(':') + 1) : row.key.slice(at + 6);
}

/** Whether a received row's coin was created by a transaction built from this seed: true, false, or undefined when the coin predates the flag. */
function ownership(row: HistoryRecord, utxos: UtxoRecord[]): boolean | undefined {
  const hash = coinKeyOfReceipt(row);
  const coin = utxos.find((u) => u.hash === hash);
  const h = (coin?.stored as { own_build_height?: number | null } | undefined)?.own_build_height;
  return h === undefined ? undefined : h !== null;
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
      // What a send brought back lands in the block that confirms it. A coin
      // this seed built (by its sender randomness) belongs to the send; a
      // coin scanned before that fact was kept falls back to amount matching;
      // a coin someone else built is a receipt whatever its amount.
      const sameBlock = rows.filter((r) => r.kind === 'received' && r.height === sent.height && !claimed.has(r.key));
      const recipientOutput = (sent.outputs ?? []).find((o) => o.role === 'recipient')?.commitment;
      const commitmentOf = (r: HistoryRecord) => {
        const hash = coinKeyOfReceipt(r);
        return (utxos.find((u) => u.hash === hash)?.stored as { commitment?: string } | undefined)?.commitment;
      };
      const claim = (r: HistoryRecord) => {
        claimed.add(r.key);
        folded.push(r);
      };
      for (const r of sameBlock) {
        const own = ownership(r, utxos);
        if (own === true) {
          claim(r);
          if (recipientOutput && commitmentOf(r) === recipientOutput) kind = 'self';
          else if (!recipientOutput && sent.recipient !== null && BigInt(r.amountNau) === BigInt(sent.amountNau)) kind = 'self';
        }
      }
      if (folded.length === 0) {
        // Older coins, without the flag: the amount rules of before.
        const unknown = sameBlock.filter((r) => ownership(r, utxos) === undefined);
        if (sent.txid === '') {
          if (change !== null && change > 0n) for (const r of unknown) claim(r);
        } else {
          if (change !== null && change > 0n) {
            const c = unknown.find((r) => !claimed.has(r.key) && BigInt(r.amountNau) === change);
            if (c) claim(c);
          }
          const self = unknown.find((r) => !claimed.has(r.key) && BigInt(r.amountNau) === BigInt(sent.amountNau));
          if (self) {
            claim(self);
            kind = 'self';
          }
        }
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
