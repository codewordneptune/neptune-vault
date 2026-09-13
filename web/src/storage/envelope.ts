// Seed envelope: password -> Argon2id (wasm) -> wrap key; a random content
// key encrypts the phrase with AES-256-GCM (WebCrypto). Changing the password
// re-wraps the content key without touching the seed ciphertext (section 6 of
// the architecture document).

import type { SeedEnvelope } from './db';

/** Argon2id parameters; stored in the envelope so they can change later. */
export interface KdfParams {
  mKib: number;
  tCost: number;
  pCost: number;
}

export const DEFAULT_KDF: KdfParams = { mKib: 64 * 1024, tCost: 3, pCost: 1 };

/** Provided by the wasm wallet core: Argon2id returning 32 bytes. */
export type DeriveKey = (
  password: Uint8Array,
  salt: Uint8Array,
  mKib: number,
  tCost: number,
  pCost: number,
) => Uint8Array;

// WebCrypto wants a plain ArrayBuffer view; copy out of any shared buffer.
function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const te = new TextEncoder();
const td = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ab(raw), { name: 'AES-GCM' }, false, usages);
}

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(plaintext)));
  return { iv: toB64(iv), ciphertext: toB64(ciphertext) };
}

async function aesDecrypt(key: CryptoKey, box: { iv: string; ciphertext: string }): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(fromB64(box.iv)) }, key, ab(fromB64(box.ciphertext))),
  );
}

/** Build a new envelope for `phrase` under `password`. */
export async function sealSeed(
  phrase: string[],
  password: string,
  deriveKey: DeriveKey,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<SeedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapRaw = deriveKey(te.encode(password), salt, kdf.mKib, kdf.tCost, kdf.pCost);
  const contentRaw = crypto.getRandomValues(new Uint8Array(32));
  const wrapKey = await importAesKey(wrapRaw, ['encrypt']);
  const contentKey = await importAesKey(contentRaw, ['encrypt']);
  const wrappedContentKey = await aesEncrypt(wrapKey, contentRaw);
  const seed = await aesEncrypt(contentKey, te.encode(phrase.join(' ')));
  wrapRaw.fill(0);
  contentRaw.fill(0);
  return {
    version: 1,
    kdf: { name: 'argon2id', mKib: kdf.mKib, tCost: kdf.tCost, pCost: kdf.pCost, salt: toB64(salt) },
    wrappedContentKey,
    seed,
  };
}

export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password');
    this.name = 'WrongPasswordError';
  }
}

/** Recover the phrase. Throws WrongPasswordError when the password is wrong. */
export async function openSeed(envelope: SeedEnvelope, password: string, deriveKey: DeriveKey): Promise<string[]> {
  if (envelope.version !== 1 || envelope.kdf.name !== 'argon2id') {
    throw new Error(`unsupported envelope version ${envelope.version}`);
  }
  const { mKib, tCost, pCost, salt } = envelope.kdf;
  const wrapRaw = deriveKey(te.encode(password), fromB64(salt), mKib, tCost, pCost);
  const wrapKey = await importAesKey(wrapRaw, ['decrypt']);
  wrapRaw.fill(0);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(wrapKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
  const contentKey = await importAesKey(contentRaw, ['decrypt']);
  contentRaw.fill(0);
  const phrase = await aesDecrypt(contentKey, envelope.seed);
  return td.decode(phrase).split(' ');
}

/** Re-wrap the content key under a new password; the seed ciphertext stays. */
export async function changePassword(
  envelope: SeedEnvelope,
  oldPassword: string,
  newPassword: string,
  deriveKey: DeriveKey,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<SeedEnvelope> {
  const oldRaw = deriveKey(te.encode(oldPassword), fromB64(envelope.kdf.salt), envelope.kdf.mKib, envelope.kdf.tCost, envelope.kdf.pCost);
  const oldKey = await importAesKey(oldRaw, ['decrypt']);
  oldRaw.fill(0);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(oldKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newRaw = deriveKey(te.encode(newPassword), salt, kdf.mKib, kdf.tCost, kdf.pCost);
  const newKey = await importAesKey(newRaw, ['encrypt']);
  const wrappedContentKey = await aesEncrypt(newKey, contentRaw);
  newRaw.fill(0);
  contentRaw.fill(0);
  return {
    ...envelope,
    kdf: { name: 'argon2id', mKib: kdf.mKib, tCost: kdf.tCost, pCost: kdf.pCost, salt: toB64(salt) },
    wrappedContentKey,
  };
}

/** The export file (R8): the envelope plus what is needed to rescan. */
export interface ExportFile {
  format: 'neptune-vault-backup';
  version: 1;
  network: string;
  birthdayHeight: number;
  envelope: SeedEnvelope;
  exportedAt: number;
}
