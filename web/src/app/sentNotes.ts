// A note on a send, added or changed in History after the send: the note
// typed on Send shows until then. Kept on this device in the wallet's
// sealed log and in its backup file, by the first of the coins the send
// spent, which a rescan or a restore finds the send again by. A note
// cleared in History is kept as an empty one, so the note typed on Send
// stays gone.

import type { WalletChange, WalletCore } from '../backend/types';
import type { HistoryRecord } from '../storage/db';
import type { EngineParts } from './engineParts';
import { cleanNote } from './send';
import { COIN_KEY } from './sendDetails';

/** The private note holding them. */
const SENT_NOTES = 'sentNotes';

export type SentNotes = Record<string, string>;

/** The coins a send spent, by key, in order. */
function coinsOf(record: HistoryRecord): string[] {
  return [...new Set(record.inputHashes)].sort();
}

/**
 * The key of a send's note that `coin` finds: its own, or for a send made
 * before coins were named with their index, the coin's hash alone. Two
 * coins can share a hash (the same amount to the same address), so the
 * hash alone is only ever a fallback.
 */
function keyFor(notes: SentNotes, coin: string): string | null {
  const hash = coin.split(':')[0];
  return Object.hasOwn(notes, coin) ? coin : Object.hasOwn(notes, hash) ? hash : null;
}

/** The coin a send's note is kept by; null for a row that is not a send, or names no coin. */
export function sentCoinOf(record: HistoryRecord): string | null {
  return record.kind === 'sent' ? (coinsOf(record)[0] ?? null) : null;
}

/** A send's note: as changed in History if it was, or else as typed on Send. */
export function sentNoteOf(record: HistoryRecord, notes: SentNotes): string | null {
  for (const coin of coinsOf(record)) {
    const key = keyFor(notes, coin);
    if (key !== null) return notes[key] || null;
  }
  return record.note || null;
}

/** A wallet's notes on sends; none where its private notes are not the engine's. */
export async function readSentNotes(core: WalletCore, engine: EngineParts, accountId: string): Promise<SentNotes> {
  if (engine.where(accountId, 'private') !== 'engine') return {};
  const notes = (await core.storeRead!(accountId, 'private')) as { key: string; value: unknown }[];
  return sentNotesFromFile(notes.find((n) => n.key === SENT_NOTES)?.value);
}

/**
 * Set a send's note to `text`, or with an empty text clear it. A note that
 * is the one typed on Send needs no entry. Answers the notes as they now are.
 */
export async function writeSentNote(core: WalletCore, engine: EngineParts, accountId: string, record: HistoryRecord, text: string): Promise<SentNotes> {
  const coin = sentCoinOf(record);
  if (!coin || engine.where(accountId, 'private') !== 'engine' || !core.storeCommit) throw new Error('Notes cannot be kept for this wallet on this device.');
  const notes = { ...(await readSentNotes(core, engine, accountId)) };
  // One entry per send: a row of sends confirmed together keeps it by its first coin.
  for (const each of coinsOf(record)) {
    const key = keyFor(notes, each);
    if (key !== null) delete notes[key];
  }
  const note = cleanNote(text);
  if (note !== cleanNote(record.note ?? '')) notes[coin] = note;
  const change: WalletChange = Object.keys(notes).length > 0 ? { op: 'putPrivate', key: SENT_NOTES, value: notes } : { op: 'deletePrivate', key: SENT_NOTES };
  await core.storeCommit(accountId, [change]);
  return notes;
}

/** Keep the notes a backup file brought. */
export async function keepSentNotes(core: WalletCore, engine: EngineParts, accountId: string, notes: SentNotes): Promise<void> {
  if (Object.keys(notes).length === 0 || !core.storeCommit || engine.where(accountId, 'private') !== 'engine') return;
  await core.storeCommit(accountId, [{ op: 'putPrivate', key: SENT_NOTES, value: notes }]);
}

/** Notes from a backup file or the private note: only coin keys and cleaned text (empty for a cleared note) survive. */
export function sentNotesFromFile(value: unknown): SentNotes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: SentNotes = {};
  for (const [coin, text] of Object.entries(value).slice(0, 5000)) {
    if (COIN_KEY.test(coin) && typeof text === 'string') out[coin] = cleanNote(text);
  }
  return out;
}
