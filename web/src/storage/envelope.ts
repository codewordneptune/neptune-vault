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

/**
 * The most work an envelope may ask of this device. An envelope arrives
 * from a file as well as from the database, and its numbers go straight to
 * Argon2: without a ceiling, a file asking for gigabytes or billions of
 * passes would hold the wallet worker until the tab was closed. The floor
 * is not here but in the wasm core's Argon2 itself (kdf.rs), so that it
 * binds every real derivation while test doubles stay free to be cheap.
 */
export const KDF_CEILING: KdfParams = { mKib: 1024 * 1024, tCost: 16, pCost: 4 };

/**
 * A backup file larger than this is not one. The size is the contacts':
 * a Standard address is about 3,500 characters, so five thousand contacts,
 * the most a restore takes, come to some 24 MB once encrypted and encoded.
 */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

/** The file says it was changed, or it is damaged: the authenticated part does not verify under the right password. */
export class BackupAlteredError extends Error {
  constructor() {
    super('This backup file has been changed since it was made, or is damaged. Nothing was restored from it.');
    this.name = 'BackupAlteredError';
  }
}

function bytesOf(text: unknown, what: string, maxChars = 4096): Uint8Array {
  if (typeof text !== 'string' || text.length > maxChars) throw new Error(`This wallet data is malformed (${what}).`);
  try {
    return fromB64(text);
  } catch {
    throw new Error(`This wallet data is malformed (${what}).`);
  }
}

function boxLengths(box: unknown, what: string, maxChars = 4096): { iv: number; ciphertext: number } {
  const b = box as { iv?: unknown; ciphertext?: unknown } | null;
  if (typeof b !== 'object' || b === null) throw new Error(`This wallet data is malformed (${what}).`);
  return { iv: bytesOf(b.iv, what).length, ciphertext: bytesOf(b.ciphertext, what, maxChars).length };
}

/**
 * Everything about an envelope that can be checked without the password,
 * checked before any of it is used. The exact lengths matter beyond
 * tidiness: AES-GCM does not commit to one key, and a wrapped key of
 * another length is where a ciphertext built to open under many passwords
 * would hide.
 */
export function assertEnvelope(envelope: unknown): asserts envelope is SeedEnvelope {
  const e = envelope as Partial<SeedEnvelope> | null;
  if (typeof e !== 'object' || e === null) throw new Error('This wallet data is malformed (no envelope).');
  if (e.version !== 1 || e.kdf?.name !== 'argon2id') throw new Error(`unsupported envelope version ${String(e.version)}`);
  const { mKib, tCost, pCost } = e.kdf;
  for (const [n, max] of [[mKib, KDF_CEILING.mKib], [tCost, KDF_CEILING.tCost], [pCost, KDF_CEILING.pCost]] as const) {
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('This wallet data asks for a password hash this app will not run: its parameters are out of range.');
  }
  const salt = bytesOf(e.kdf.salt, 'salt').length;
  if (salt < 16 || salt > 64) throw new Error('This wallet data is malformed (salt).');
  const wrapped = boxLengths(e.wrappedContentKey, 'wrapped key');
  // A 32-byte key and AES-GCM's 16-byte tag.
  if (wrapped.iv !== 12 || wrapped.ciphertext !== 48) throw new Error('This wallet data is malformed (wrapped key).');
  const seed = boxLengths(e.seed, 'seed');
  if (seed.iv !== 12 || seed.ciphertext < 17 || seed.ciphertext > 1024) throw new Error('This wallet data is malformed (seed).');
}

/** Whether an envelope's password hash is cheaper to guess against than today's default. */
export function isWeakerThanDefault(kdf: KdfParams, against: KdfParams = DEFAULT_KDF): boolean {
  return kdf.mKib < against.mKib || kdf.tCost < against.tCost;
}

/** Provided by the wasm wallet core (possibly in a worker): Argon2id, 32 bytes. */
export type DeriveKey = (
  password: Uint8Array,
  salt: Uint8Array,
  mKib: number,
  tCost: number,
  pCost: number,
) => Uint8Array | Promise<Uint8Array>;

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

/** WebCrypto exists only in secure contexts (https or localhost). */
function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This page is not a secure context, so the browser provides no encryption. Open the app over https or on localhost.');
  }
  return globalThis.crypto.subtle;
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', ab(raw), { name: 'AES-GCM' }, false, usages);
}

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array, additionalData?: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = additionalData ? { name: 'AES-GCM', iv: ab(iv), additionalData: ab(additionalData) } : { name: 'AES-GCM', iv: ab(iv) };
  const ciphertext = new Uint8Array(await subtle().encrypt(params, key, ab(plaintext)));
  return { iv: toB64(iv), ciphertext: toB64(ciphertext) };
}

async function aesDecrypt(key: CryptoKey, box: { iv: string; ciphertext: string }, additionalData?: Uint8Array): Promise<Uint8Array> {
  const iv = ab(fromB64(box.iv));
  const params = additionalData ? { name: 'AES-GCM', iv, additionalData: ab(additionalData) } : { name: 'AES-GCM', iv };
  return new Uint8Array(await subtle().decrypt(params, key, ab(fromB64(box.ciphertext))));
}

/** Build a new envelope for `phrase` under `password`. */
export async function sealSeed(
  phrase: string[],
  password: string,
  deriveKey: DeriveKey,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<SeedEnvelope> {
  const { envelope, contentKey } = await sealSeedKeepingKey(phrase, password, deriveKey, kdf);
  contentKey.fill(0);
  return envelope;
}

/**
 * The same, and the content key with it. The wallet's sealed log is keyed
 * from the content key, so whoever is about to unlock the new wallet needs
 * it once. Zero it when done.
 */
export async function sealSeedKeepingKey(
  phrase: string[],
  password: string,
  deriveKey: DeriveKey,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<{ envelope: SeedEnvelope; contentKey: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapRaw = await deriveKey(te.encode(password), salt, kdf.mKib, kdf.tCost, kdf.pCost);
  const contentRaw = crypto.getRandomValues(new Uint8Array(32));
  const wrapKey = await importAesKey(wrapRaw, ['encrypt']);
  const contentKey = await importAesKey(contentRaw, ['encrypt']);
  const wrappedContentKey = await aesEncrypt(wrapKey, contentRaw);
  const seed = await aesEncrypt(contentKey, te.encode(phrase.join(' ')));
  wrapRaw.fill(0);
  return {
    envelope: {
      version: 1,
      kdf: { name: 'argon2id', mKib: kdf.mKib, tCost: kdf.tCost, pCost: kdf.pCost, salt: toB64(salt) },
      wrappedContentKey,
      seed,
    },
    contentKey: contentRaw,
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
  const { phrase, contentKey } = await openSeedKeepingKey(envelope, password, deriveKey);
  contentKey.fill(0);
  return phrase;
}

/** The same, and the content key with it, from the one password hash. Zero it when done. */
export async function openSeedKeepingKey(envelope: SeedEnvelope, password: string, deriveKey: DeriveKey): Promise<{ phrase: string[]; contentKey: Uint8Array }> {
  assertEnvelope(envelope);
  const { mKib, tCost, pCost, salt } = envelope.kdf;
  const wrapRaw = await deriveKey(te.encode(password), fromB64(salt), mKib, tCost, pCost);
  const wrapKey = await importAesKey(wrapRaw, ['decrypt']);
  wrapRaw.fill(0);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(wrapKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
  const contentKey = await importAesKey(contentRaw, ['decrypt']);
  let phrase: Uint8Array;
  try {
    phrase = await aesDecrypt(contentKey, envelope.seed);
  } catch {
    contentRaw.fill(0);
    // The password was right and the seed still does not open: the data is
    // damaged, or it is a newer backup file dressed as an older one.
    throw new Error('The password is right, but the seed in this wallet data does not open: the data is damaged or has been changed.');
  }
  return { phrase: td.decode(phrase).split(' '), contentKey: contentRaw };
}

/** The raw content key, after checking the password. Zero it when done. */
export async function extractContentKey(envelope: SeedEnvelope, password: string, deriveKey: DeriveKey): Promise<Uint8Array> {
  assertEnvelope(envelope);
  const { mKib, tCost, pCost, salt } = envelope.kdf;
  const wrapRaw = await deriveKey(te.encode(password), fromB64(salt), mKib, tCost, pCost);
  const wrapKey = await importAesKey(wrapRaw, ['decrypt']);
  wrapRaw.fill(0);
  try {
    return await aesDecrypt(wrapKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
}

/** Wrap the content key under a 32-byte secret (a passkey's PRF output). */
export async function wrapContentKey(contentRaw: Uint8Array, secret: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const key = await importAesKey(secret, ['encrypt']);
  return aesEncrypt(key, contentRaw);
}

/** Recover the phrase from a content key wrapped under a secret. */
export async function openSeedWithSecret(
  envelope: SeedEnvelope,
  wrapped: { iv: string; ciphertext: string },
  secret: Uint8Array,
): Promise<string[]> {
  const { phrase, contentKey } = await openSeedWithSecretKeepingKey(envelope, wrapped, secret);
  contentKey.fill(0);
  return phrase;
}

/** The same, and the content key with it. Zero it when done. */
export async function openSeedWithSecretKeepingKey(
  envelope: SeedEnvelope,
  wrapped: { iv: string; ciphertext: string },
  secret: Uint8Array,
): Promise<{ phrase: string[]; contentKey: Uint8Array }> {
  assertEnvelope(envelope);
  const key = await importAesKey(secret, ['decrypt']);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(key, wrapped);
  } catch {
    throw new Error('This passkey no longer matches the wallet; unlock with the password and set the passkey up again.');
  }
  const contentKey = await importAesKey(contentRaw, ['decrypt']);
  try {
    return { phrase: td.decode(await aesDecrypt(contentKey, envelope.seed)).split(' '), contentKey: contentRaw };
  } catch (e) {
    contentRaw.fill(0);
    throw e;
  }
}

/** Re-wrap the content key under a new password; the seed ciphertext stays. */
export async function changePassword(
  envelope: SeedEnvelope,
  oldPassword: string,
  newPassword: string,
  deriveKey: DeriveKey,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<SeedEnvelope> {
  assertEnvelope(envelope);
  const oldRaw = await deriveKey(te.encode(oldPassword), fromB64(envelope.kdf.salt), envelope.kdf.mKib, envelope.kdf.tCost, envelope.kdf.pCost);
  const oldKey = await importAesKey(oldRaw, ['decrypt']);
  oldRaw.fill(0);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(oldKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newRaw = await deriveKey(te.encode(newPassword), salt, kdf.mKib, kdf.tCost, kdf.pCost);
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

/**
 * The export file (R8): the seed, protected by the password, plus what is
 * needed to rescan, plus the contacts.
 *
 * Versions 1 and 2 carried the database's envelope as it was and kept
 * everything beside it in clear, bound to nothing. Whoever could write to
 * where the file was kept could swap a contact's address for their own, or
 * raise the start block so that a restore came up empty, without the
 * password and without a trace.
 *
 * Version 3 closes that, in a way an attacker cannot undo by relabelling
 * the file as an older one:
 *
 *   password --Argon2--> wrap key --AES-GCM--> file key
 *   file key --AES-GCM, bound to the readable part--> content key
 *   content key --AES-GCM--> seed            (the same ciphertext as in the database)
 *   content key --AES-GCM, bound to all of the above--> contacts
 *
 * The readable part (format, version, network, start block, export date,
 * the password hash settings) goes into the second step as additional
 * authenticated data: change one byte of it and the content key does not
 * come out, so neither the seed nor the contacts open, and the restore
 * stops. The first step has no such binding, on purpose: it answers one
 * question only, whether the password is right, so that a wrong password
 * and a changed file are told apart.
 *
 * An older reader, handed a version 3 file dressed as version 2, would take
 * the file key for the content key, and the seed would not open under it.
 */
export type ExportFile = LegacyExportFile | SealedExportFile;

/** Versions 1 and 2. */
export interface LegacyExportFile {
  format: 'neptune-vault-backup';
  /** 1: seed only; 2: adds contacts, in clear. */
  version: 1 | 2;
  network: string;
  birthdayHeight: number;
  envelope: SeedEnvelope;
  exportedAt: number;
  contacts?: { name: string; address: string }[];
}

type Box = { iv: string; ciphertext: string };

/** Version 3. */
export interface SealedExportFile {
  format: 'neptune-vault-backup';
  version: 3;
  network: string;
  birthdayHeight: number;
  exportedAt: number;
  envelope: {
    version: 2;
    kdf: SeedEnvelope['kdf'];
    /** The file key under the password's wrap key. Opens for the right password and for nothing else. */
    wrappedFileKey: Box;
    /** The content key under the file key, bound to the readable part of the file. */
    boundContentKey: Box;
    /** The seed under the content key: the database's own ciphertext. */
    seed: Box;
  };
  /** BackupSecrets under the content key, bound to everything above. */
  sealed: Box;
}

/** What a version 3 file keeps encrypted besides the seed. */
export interface BackupSecrets {
  contacts: { name: string; address: string }[];
}

/**
 * The readable part of a version 3 file as one fixed text, byte for byte
 * the same at export and at restore. Built by hand, field by field in a set
 * order: JSON promises neither key order nor number formatting. No field
 * can hold a line break (numbers, fixed names, base64), so the join is
 * unambiguous.
 */
function readablePart(file: Pick<SealedExportFile, 'format' | 'version' | 'network' | 'birthdayHeight' | 'exportedAt'>, kdf: SeedEnvelope['kdf'], wrappedFileKey: Box, seed: Box): string {
  return [
    file.format,
    String(file.version),
    file.network,
    String(file.birthdayHeight),
    String(file.exportedAt),
    '2',
    kdf.name,
    String(kdf.mKib),
    String(kdf.tCost),
    String(kdf.pCost),
    kdf.salt,
    wrappedFileKey.iv,
    wrappedFileKey.ciphertext,
    seed.iv,
    seed.ciphertext,
  ].join('\n');
}

/**
 * Make a version 3 file from the database's envelope. Takes the password:
 * the content key is needed, and being unlocked does not give it. Throws
 * WrongPasswordError. One password hash: the wrap key the password gives
 * for the stored envelope wraps the file key too, under a fresh IV.
 */
export async function sealBackup(
  meta: { network: string; birthdayHeight: number; exportedAt: number },
  envelope: SeedEnvelope,
  secrets: BackupSecrets,
  password: string,
  deriveKey: DeriveKey,
): Promise<SealedExportFile> {
  assertEnvelope(envelope);
  const { mKib, tCost, pCost, salt } = envelope.kdf;
  const wrapRaw = await deriveKey(te.encode(password), fromB64(salt), mKib, tCost, pCost);
  const wrapKey = await importAesKey(wrapRaw, ['encrypt', 'decrypt']);
  wrapRaw.fill(0);
  let contentRaw: Uint8Array;
  try {
    contentRaw = await aesDecrypt(wrapKey, envelope.wrappedContentKey);
  } catch {
    throw new WrongPasswordError();
  }
  const fileRaw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const head = { format: 'neptune-vault-backup' as const, version: 3 as const, ...meta };
    const wrappedFileKey = await aesEncrypt(wrapKey, fileRaw);
    const readable = readablePart(head, envelope.kdf, wrappedFileKey, envelope.seed);
    const boundContentKey = await aesEncrypt(await importAesKey(fileRaw, ['encrypt']), contentRaw, te.encode(readable));
    const everything = readable + '\n' + boundContentKey.iv + '\n' + boundContentKey.ciphertext;
    const sealed = await aesEncrypt(await importAesKey(contentRaw, ['encrypt']), te.encode(JSON.stringify(secrets)), te.encode(everything));
    return { ...head, envelope: { version: 2, kdf: envelope.kdf, wrappedFileKey, boundContentKey, seed: envelope.seed }, sealed };
  } finally {
    contentRaw.fill(0);
    fileRaw.fill(0);
  }
}

/**
 * Open a version 3 file: its secrets, and an ordinary envelope for the
 * database, wrapped under the same password. Throws WrongPasswordError for a
 * wrong password, and BackupAlteredError when the password is right and the
 * file is not what was exported.
 */
export async function openBackup(file: SealedExportFile, password: string, deriveKey: DeriveKey): Promise<{ secrets: BackupSecrets; envelope: SeedEnvelope }> {
  assertFileEnvelope(file);
  const e = file.envelope;
  const wrapRaw = await deriveKey(te.encode(password), fromB64(e.kdf.salt), e.kdf.mKib, e.kdf.tCost, e.kdf.pCost);
  const wrapKey = await importAesKey(wrapRaw, ['encrypt', 'decrypt']);
  wrapRaw.fill(0);
  let fileRaw: Uint8Array;
  try {
    fileRaw = await aesDecrypt(wrapKey, e.wrappedFileKey);
  } catch {
    throw new WrongPasswordError();
  }
  // From here the password is known to be right: whatever fails is the file.
  let contentRaw: Uint8Array | null = null;
  try {
    const readable = readablePart(file, e.kdf, e.wrappedFileKey, e.seed);
    contentRaw = await aesDecrypt(await importAesKey(fileRaw, ['decrypt']), e.boundContentKey, te.encode(readable));
    const everything = readable + '\n' + e.boundContentKey.iv + '\n' + e.boundContentKey.ciphertext;
    const contentKey = await importAesKey(contentRaw, ['decrypt']);
    const plain = await aesDecrypt(contentKey, file.sealed, te.encode(everything));
    // The seed must open under this content key too, or the file would
    // restore contacts to a wallet that then cannot be unlocked.
    await aesDecrypt(contentKey, e.seed);
    const parsed = JSON.parse(td.decode(plain)) as Partial<BackupSecrets>;
    const wrappedContentKey = await aesEncrypt(wrapKey, contentRaw);
    return {
      secrets: { contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [] },
      envelope: { version: 1, kdf: e.kdf, wrappedContentKey, seed: e.seed },
    };
  } catch {
    throw new BackupAlteredError();
  } finally {
    fileRaw.fill(0);
    contentRaw?.fill(0);
  }
}

/** What can be checked of a version 3 file without the password. */
function assertFileEnvelope(file: SealedExportFile): void {
  const e = file.envelope as Partial<SealedExportFile['envelope']> | null;
  if (typeof e !== 'object' || e === null || e.version !== 2 || !e.kdf) throw new BackupAlteredError();
  // The same checks as an ordinary envelope: the settings, the salt, the seed, and a 48-byte wrapped key.
  assertEnvelope({ version: 1, kdf: e.kdf, wrappedContentKey: e.wrappedFileKey, seed: e.seed });
  const bound = boxLengths(e.boundContentKey, 'content key');
  if (bound.iv !== 12 || bound.ciphertext !== 48) throw new Error('This wallet data is malformed (content key).');
  // A version 3 file without its sealed part is one that had it removed.
  if (typeof file.sealed !== 'object' || file.sealed === null) throw new BackupAlteredError();
  // The contacts are in here, and one Standard address alone is several
  // thousand characters: the whole file's cap is the cap.
  const sealed = boxLengths(file.sealed, 'sealed part', MAX_BACKUP_BYTES);
  if (sealed.iv !== 12 || sealed.ciphertext < 17) throw new BackupAlteredError();
  if (typeof file.network !== 'string' || !Number.isSafeInteger(file.birthdayHeight) || !Number.isSafeInteger(file.exportedAt)) throw new BackupAlteredError();
}

/**
 * Read a backup file's text. Everything that can be checked without the
 * password is checked here, before the person is asked for it.
 */
export function parseBackupFile(text: string): ExportFile {
  const notOne = 'This file is not a Neptune Vault backup file.';
  if (text.length > MAX_BACKUP_BYTES) throw new Error('This file is too large to be a Neptune Vault backup file.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(notOne);
  }
  const file = parsed as Partial<ExportFile> | null;
  if (typeof file !== 'object' || file === null || file.format !== 'neptune-vault-backup') throw new Error(notOne);
  // Every version ever written stays readable; one this app does not know
  // is from a newer app, never a reason to guess at the contents.
  if (file.version !== 1 && file.version !== 2 && file.version !== 3) {
    throw new Error('This backup file was made by a newer version of Neptune Vault. Update the app, then restore it.');
  }
  if (file.version === 3) assertFileEnvelope(file as SealedExportFile);
  else assertEnvelope(file.envelope);
  return file as ExportFile;
}
