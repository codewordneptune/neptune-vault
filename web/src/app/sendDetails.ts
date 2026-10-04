// What a send built on this device knew that the chain does not show: who
// it paid and how much each, the fee, the identifiers of the coins it made,
// the note to self. Restored from its seed, a wallet finds its sends again
// only as coins that went: "Sent", the fee inside the amount, the recipient
// not recorded. The backup file carries these details, kept by the coins
// each send spent, and a wallet restored from the file finds each send by
// those coins (a restore finds every coin under the key it had), so History
// shows it as it was.

import type { WalletCore } from '../backend/types';
import type { EngineParts } from './engineParts';
import type { HistoryOutput, HistoryPayment, HistoryRecord, SendDetails } from '../storage/db';
import { cleanNote, MAX_PAYMENTS } from './send';

/** The private note holding the details a backup file brought. */
const SEND_DETAILS = 'sendDetails';

/** The details a backup file brought for a wallet's sends; none where its private notes are not the engine's. */
export async function readSendDetails(core: WalletCore, engine: EngineParts, accountId: string): Promise<SendDetails[]> {
  if (engine.where(accountId, 'private') !== 'engine') return [];
  const notes = (await core.storeRead!(accountId, 'private')) as { key: string; value: unknown }[];
  return sendDetailsFromFile(notes.find((n) => n.key === SEND_DETAILS)?.value);
}

/** Keep the details a backup file brought, for History. */
export async function keepSendDetails(core: WalletCore, engine: EngineParts, accountId: string, details: SendDetails[]): Promise<void> {
  if (details.length === 0 || !core.storeCommit || engine.where(accountId, 'private') !== 'engine') return;
  await core.storeCommit(accountId, [{ op: 'putPrivate', key: SEND_DETAILS, value: details }]);
}

/**
 * For the backup file: each send built here that went out or still may
 * (not one that failed, was given up on or expired: its coins may have paid
 * another), then each one a backup file brought, every send once.
 */
export function sendDetailsForFile(history: HistoryRecord[], brought: SendDetails[]): SendDetails[] {
  const kept = new Map<string, SendDetails>();
  const add = (d: SendDetails) => {
    const key = [...d.inputs].sort().join(' ');
    if (!kept.has(key)) kept.set(key, d);
  };
  for (const h of history) {
    if (h.kind !== 'sent' || h.recipient === null || h.inputHashes.length === 0) continue;
    if (h.status === 'failed' || h.givenUp || h.expired) continue;
    add({
      inputs: h.inputHashes,
      txid: h.txid,
      payments: h.payments ?? [{ recipient: h.recipient, amountNau: h.amountNau }],
      feeNau: h.feeNau,
      ...(h.outputs && h.outputs.length > 0 ? { outputs: h.outputs } : {}),
      ...(h.note ? { note: h.note } : {}),
    });
  }
  for (const d of brought) add(d);
  return [...kept.values()];
}

// A coin's key: its hash and, after a colon, its index in the chain's list of
// coins. Sends recorded before the index was kept name their coins by hash alone.
export const COIN_KEY = /^[0-9a-f]{1,200}(:\d{1,20})?$/;
const HEX = /^[0-9a-f]{1,200}$/;
const NAU = /^\d{1,40}$/;
const field = (o: unknown, name: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[name] : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** From a backup file or the private note: only well-formed sends, and what is well-formed in them, survive. */
export function sendDetailsFromFile(value: unknown): SendDetails[] {
  const out: SendDetails[] = [];
  for (const entry of list(value).slice(0, 10_000)) {
    const inputs = list(field(entry, 'inputs'))
      .filter((i): i is string => typeof i === 'string' && COIN_KEY.test(i))
      .slice(0, 1000);
    const payments = list(field(entry, 'payments'))
      .slice(0, MAX_PAYMENTS)
      .flatMap((p): HistoryPayment[] => {
        const recipient = field(p, 'recipient');
        const amountNau = field(p, 'amountNau');
        return typeof recipient === 'string' && recipient.trim() !== '' && recipient.length <= 8000 && typeof amountNau === 'string' && NAU.test(amountNau) ? [{ recipient: recipient.trim().toLowerCase(), amountNau }] : [];
      });
    if (inputs.length === 0 || payments.length === 0) continue;
    const outputs = list(field(entry, 'outputs'))
      .slice(0, 100)
      .flatMap((o): HistoryOutput[] => {
        const commitment = field(o, 'commitment');
        const role = field(o, 'role');
        return typeof commitment === 'string' && HEX.test(commitment) && (role === 'recipient' || role === 'change') ? [{ commitment, role }] : [];
      });
    const txid = field(entry, 'txid');
    const feeNau = field(entry, 'feeNau');
    const note = field(entry, 'note');
    const cleaned = typeof note === 'string' ? cleanNote(note) : '';
    out.push({
      inputs,
      txid: typeof txid === 'string' && HEX.test(txid) ? txid : '',
      payments,
      feeNau: typeof feeNau === 'string' && NAU.test(feeNau) ? feeNau : null,
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(cleaned ? { note: cleaned } : {}),
    });
  }
  return out;
}

/**
 * History as shown: a send found on the chain (no recipient, no id) whose
 * coins a backup file named takes what the file kept, its id, who it paid
 * and how much, the fee, its coins' identifiers and its note, and so reads
 * as it did where it was made. The change is worked out again from the
 * coins. Sends confirmed in one block are one row on the chain; each is told.
 */
export function withSendDetails(history: HistoryRecord[], details: SendDetails[]): HistoryRecord[] {
  if (details.length === 0) return history;
  const byKey = new Map<string, SendDetails>();
  const byHash = new Map<string, SendDetails>();
  for (const d of details) {
    for (const input of d.inputs) (input.includes(':') ? byKey : byHash).set(input, d);
  }
  return history.map((h) => {
    if (h.kind !== 'sent' || h.recipient !== null || h.txid !== '') return h;
    const found = [...new Set(h.inputHashes.map((i) => byKey.get(i) ?? byHash.get(i.split(':')[0])).filter((d): d is SendDetails => d !== undefined))];
    if (found.length === 0) return h;
    const payments = found.flatMap((d) => d.payments);
    const outputs = found.flatMap((d) => d.outputs ?? []);
    const notes = found.flatMap((d) => (d.note ? [d.note] : []));
    return {
      ...h,
      txid: found[0].txid,
      recipient: payments[0].recipient,
      payments,
      amountNau: payments.reduce((sum, p) => sum + BigInt(p.amountNau), 0n).toString(),
      feeNau: found.reduce((sum, d) => sum + BigInt(d.feeNau ?? '0'), 0n).toString(),
      changeNau: null,
      outputs: outputs.length > 0 ? outputs : h.outputs,
      note: notes.length > 0 ? notes.join(' · ') : null,
    };
  });
}
