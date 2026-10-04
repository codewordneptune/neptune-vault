// A note on a payment received: the person's own words about it ("Rent for
// May"), as a send has its note to self. Kept on this device in the
// wallet's sealed log and in its backup file. Keyed by the coin the payment
// brought (its hash and its place in the chain's list of coins), which a
// restore or a rescan finds under the same key; a payment still on its way
// has no such key yet, so its note waits until a block confirms it.

import type { WalletChange, WalletCore } from '../backend/types';
import type { HistoryRecord } from '../storage/db';
import type { EngineParts } from './engineParts';
import { cleanNote } from './send';
import { COIN_KEY } from './sendDetails';
import { coinKeyOfReceipt } from '../util/history';

/** The private note holding them. */
const RECEIVED_NOTES = 'receivedNotes';

export type ReceivedNotes = Record<string, string>;

/** The coin a confirmed payment received brought, which its note is kept by; null for any other row. */
export function receivedCoinOf(record: HistoryRecord): string | null {
  return record.kind === 'received' && record.status === 'confirmed' && record.key.includes(':recv:') ? coinKeyOfReceipt(record) : null;
}

/** A wallet's notes on payments received; none where its private notes are not the engine's. */
export async function readReceivedNotes(core: WalletCore, engine: EngineParts, accountId: string): Promise<ReceivedNotes> {
  if (engine.where(accountId, 'private') !== 'engine') return {};
  const notes = (await core.storeRead!(accountId, 'private')) as { key: string; value: unknown }[];
  return receivedNotesFromFile(notes.find((n) => n.key === RECEIVED_NOTES)?.value);
}

/** Set, or with an empty text clear, the note on one payment. Answers the notes as they now are. */
export async function writeReceivedNote(core: WalletCore, engine: EngineParts, accountId: string, coin: string, text: string): Promise<ReceivedNotes> {
  if (engine.where(accountId, 'private') !== 'engine' || !core.storeCommit) throw new Error('Notes cannot be kept for this wallet on this device.');
  const notes = { ...(await readReceivedNotes(core, engine, accountId)) };
  const note = cleanNote(text);
  if (note) notes[coin] = note;
  else delete notes[coin];
  const change: WalletChange = Object.keys(notes).length > 0 ? { op: 'putPrivate', key: RECEIVED_NOTES, value: notes } : { op: 'deletePrivate', key: RECEIVED_NOTES };
  await core.storeCommit(accountId, [change]);
  return notes;
}

/** Keep the notes a backup file brought. */
export async function keepReceivedNotes(core: WalletCore, engine: EngineParts, accountId: string, notes: ReceivedNotes): Promise<void> {
  if (Object.keys(notes).length === 0 || !core.storeCommit || engine.where(accountId, 'private') !== 'engine') return;
  await core.storeCommit(accountId, [{ op: 'putPrivate', key: RECEIVED_NOTES, value: notes }]);
}

/** Notes from a backup file or the private note: only well-formed coin keys and cleaned text survive. */
export function receivedNotesFromFile(value: unknown): ReceivedNotes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: ReceivedNotes = {};
  for (const [coin, text] of Object.entries(value).slice(0, 5000)) {
    const note = typeof text === 'string' ? cleanNote(text) : '';
    if (COIN_KEY.test(coin) && note) out[coin] = note;
  }
  return out;
}
