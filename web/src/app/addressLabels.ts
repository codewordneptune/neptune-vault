// Who each receiving address was given to: a name the person writes, kept
// on this device only, in the wallet's sealed log, and in its backup file.
//
// A payment's sender is not on the chain, so this is the one way to know
// who paid: give each person their own address, and the payment to that
// address is theirs. Keyed by the address's kind and number, which the
// coins it receives carry too.

import type { KeyKind, WalletChange, WalletCore } from '../backend/types';
import type { EngineParts } from './engineParts';
import { cleanText } from '../util/text';

/** The private note holding the labels. */
const ADDRESS_LABELS = 'addressLabels';

/** Longest label kept; longer ones are cut. */
export const ADDRESS_LABEL_MAX = 60;

export type AddressLabels = Record<string, string>;

/** The key of one address: its kind and its number. */
export function addressKey(kind: KeyKind, index: number): string {
  return `${kind}:${index}`;
}

/** A label as kept: trimmed, cut to length, with no characters that change how text around it reads. */
export function cleanLabel(text: string): string {
  return cleanText(text).slice(0, ADDRESS_LABEL_MAX);
}

/** The labels of a wallet's addresses; empty for a wallet whose private notes are not kept by the engine. */
export async function readLabels(core: WalletCore, engine: EngineParts, accountId: string): Promise<AddressLabels> {
  if (engine.where(accountId, 'private') !== 'engine') return {};
  const notes = (await core.storeRead!(accountId, 'private')) as { key: string; value: unknown }[];
  const value = notes.find((n) => n.key === ADDRESS_LABELS)?.value;
  if (typeof value !== 'object' || value === null) return {};
  const out: AddressLabels = {};
  for (const [key, label] of Object.entries(value)) if (typeof label === 'string' && label) out[key] = label;
  return out;
}

/** Set, or with an empty text clear, the label of one address. Answers the labels as they now are. */
export async function writeLabel(core: WalletCore, engine: EngineParts, accountId: string, kind: KeyKind, index: number, text: string): Promise<AddressLabels> {
  if (engine.where(accountId, 'private') !== 'engine') throw new Error('Labels cannot be kept for this wallet on this device.');
  const labels = { ...(await readLabels(core, engine, accountId)) };
  const label = cleanLabel(text);
  if (label) labels[addressKey(kind, index)] = label;
  else delete labels[addressKey(kind, index)];
  const change: WalletChange = Object.keys(labels).length > 0 ? { op: 'putPrivate', key: ADDRESS_LABELS, value: labels } : { op: 'deletePrivate', key: ADDRESS_LABELS };
  await core.storeCommit!(accountId, [change]);
  return labels;
}

/** The private note holding the addresses given out on this device. */
const ADDRESSES_GIVEN = 'addressesGiven';
const ADDRESS_KEY = /^(generation|ec_hybrid|viewing):\d{1,9}$/;

/**
 * The addresses of a wallet given out: shown by New address, copied, shared
 * or shown full screen on Receive, as a payment request too. New address
 * never offers one of them again, named or not, paid or not: someone may
 * be about to pay it.
 * Empty for a wallet whose private notes are not kept by the engine.
 */
export async function readGiven(core: WalletCore, engine: EngineParts, accountId: string): Promise<Set<string>> {
  if (engine.where(accountId, 'private') !== 'engine') return new Set();
  const notes = (await core.storeRead!(accountId, 'private')) as { key: string; value: unknown }[];
  return givenFromFile(notes.find((n) => n.key === ADDRESSES_GIVEN)?.value);
}

/** Note that one address was given out. Answers the addresses given out as they now are. */
export async function markGiven(core: WalletCore, engine: EngineParts, accountId: string, kind: KeyKind, index: number): Promise<Set<string>> {
  const given = await readGiven(core, engine, accountId);
  const key = addressKey(kind, index);
  // Kept for this visit only where the wallet has no private notes to keep it in.
  if (given.has(key) || engine.where(accountId, 'private') !== 'engine') return new Set([...given, key]);
  given.add(key);
  await core.storeCommit!(accountId, [{ op: 'putPrivate', key: ADDRESSES_GIVEN, value: [...given].sort() }]);
  return given;
}

/** The addresses given out, from a backup file or the private note: only well-formed keys survive. */
export function givenFromFile(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.slice(0, 5000).filter((k): k is string => typeof k === 'string' && ADDRESS_KEY.test(k)) : []);
}

/** Labels from a backup file: only well-formed keys and cleaned text survive. */
export function labelsFromFile(value: unknown): AddressLabels {
  if (typeof value !== 'object' || value === null) return {};
  const out: AddressLabels = {};
  for (const [key, label] of Object.entries(value).slice(0, 5000)) {
    if (!/^(generation|ec_hybrid|viewing):\d{1,9}$/.test(key) || typeof label !== 'string') continue;
    const clean = cleanLabel(label);
    if (clean) out[key] = clean;
  }
  return out;
}

/** The key of the address a coin was paid to, from the core's record of it. */
export function coinAddressKey(stored: unknown): string | null {
  const s = stored as { key_kind?: unknown; key_index?: unknown } | null;
  const kind = typeof s?.key_kind === 'string' ? (s.key_kind as KeyKind) : 'generation';
  return typeof s?.key_index === 'number' ? addressKey(kind, s.key_index) : null;
}
