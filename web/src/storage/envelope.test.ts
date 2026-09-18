import { describe, expect, it } from 'vitest';

import { assertEnvelope, changePassword, isWeakerThanDefault, DEFAULT_KDF, KDF_CEILING, MAX_BACKUP_BYTES, openSeed, parseBackupFile, sealSeed, WrongPasswordError, type DeriveKey } from './envelope';

// Stand-in for the wasm Argon2id: deterministic, salted, 32 bytes. The real
// function is exercised by the Rust tests; here only the envelope logic is.
const fakeDerive: DeriveKey = (password, salt) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (password[i % password.length] ?? 0) ^ salt[i % salt.length] ^ i;
  }
  return out;
};

const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire'.split(' ');

describe('seed envelope', () => {
  it('opens with the right password and rejects a wrong one', async () => {
    const env = await sealSeed(phrase, 'correct horse', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    expect(env.kdf.name).toBe('argon2id');
    expect(env.seed.ciphertext).not.toContain('abandon');
    await expect(openSeed(env, 'correct horse', fakeDerive)).resolves.toEqual(phrase);
    await expect(openSeed(env, 'wrong', fakeDerive)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('changes the password without re-encrypting the seed', async () => {
    const env = await sealSeed(phrase, 'one', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    const changed = await changePassword(env, 'one', 'two', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    expect(changed.seed).toEqual(env.seed);
    expect(changed.wrappedContentKey).not.toEqual(env.wrappedContentKey);
    await expect(openSeed(changed, 'two', fakeDerive)).resolves.toEqual(phrase);
    await expect(openSeed(changed, 'one', fakeDerive)).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(changePassword(env, 'bad', 'x', fakeDerive)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('uses a fresh salt and iv every time', async () => {
    const a = await sealSeed(phrase, 'pw', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    const b = await sealSeed(phrase, 'pw', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.seed.iv).not.toBe(b.seed.iv);
  });
});

describe('passkey wrapping', () => {
  it('wraps the content key under a secret and opens the seed with it', async () => {
    const { extractContentKey, wrapContentKey, openSeedWithSecret } = await import('./envelope');
    const phrase = ['a', 'b', 'c'];
    const env = await sealSeed(phrase, 'pw', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    const contentRaw = await extractContentKey(env, 'pw', fakeDerive);
    const secret = new Uint8Array(32).fill(7);
    const wrapped = await wrapContentKey(contentRaw, secret);
    expect(await openSeedWithSecret(env, wrapped, secret)).toEqual(phrase);
    await expect(openSeedWithSecret(env, wrapped, new Uint8Array(32).fill(8))).rejects.toThrow('no longer matches');
    await expect(extractContentKey(env, 'nope', fakeDerive)).rejects.toThrow(WrongPasswordError);
  });
});

describe('what is checked before the password is used', () => {
  it('refuses a password hash that would hold the device, and never runs it', async () => {
    const env = await sealSeed(phrase, 'pw', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    let ran = 0;
    const counting: DeriveKey = (pw, salt, m, t, p2) => { ran += 1; return fakeDerive(pw, salt, m, t, p2); };
    for (const kdf of [
      { ...env.kdf, mKib: KDF_CEILING.mKib + 1 },
      { ...env.kdf, mKib: 3_000_000 },
      { ...env.kdf, tCost: 4_000_000_000 },
      { ...env.kdf, pCost: 64 },
      { ...env.kdf, mKib: 0 },
      { ...env.kdf, tCost: 1.5 },
      { ...env.kdf, mKib: '65536' as unknown as number },
    ]) {
      await expect(openSeed({ ...env, kdf }, 'pw', counting), JSON.stringify(kdf)).rejects.toThrow(/out of range/);
    }
    expect(ran).toBe(0);
  });

  it('holds every length to what this app writes', async () => {
    const env = await sealSeed(phrase, 'pw', fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
    expect(() => assertEnvelope(env)).not.toThrow();
    const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n)));
    const bad: [string, unknown][] = [
      ['a short salt', { ...env, kdf: { ...env.kdf, salt: b64(8) } }],
      ['a long salt', { ...env, kdf: { ...env.kdf, salt: b64(65) } }],
      ['a wrapped key of another length, where a many-password ciphertext would hide', { ...env, wrappedContentKey: { ...env.wrappedContentKey, ciphertext: b64(64) } }],
      ['a short IV', { ...env, seed: { ...env.seed, iv: b64(8) } }],
      ['an enormous seed', { ...env, seed: { ...env.seed, ciphertext: b64(2000) } }],
      ['text that is not base64', { ...env, seed: { ...env.seed, iv: '***' } }],
      ['no envelope at all', null],
      ['another hash', { ...env, kdf: { ...env.kdf, name: 'pbkdf2' } }],
    ];
    for (const [what, e] of bad) expect(() => assertEnvelope(e), what).toThrow();
  });

  it('reads a backup file strictly', async () => {
    expect(() => parseBackupFile('x'.repeat(MAX_BACKUP_BYTES + 1))).toThrow(/too large/);
    expect(() => parseBackupFile('not json')).toThrow(/not a Neptune Vault backup/);
    expect(() => parseBackupFile('null')).toThrow(/not a Neptune Vault backup/);
    expect(() => parseBackupFile(JSON.stringify({ format: 'neptune-vault-backup', version: 9 }))).toThrow(/newer version/);
    expect(() => parseBackupFile(JSON.stringify({ format: 'neptune-vault-backup', version: 2, envelope: {} }))).toThrow();
  });

  it('knows settings weaker than the default', () => {
    expect(isWeakerThanDefault({ mKib: 8, tCost: 1, pCost: 1 })).toBe(true);
    expect(isWeakerThanDefault({ ...DEFAULT_KDF, tCost: DEFAULT_KDF.tCost - 1 })).toBe(true);
    expect(isWeakerThanDefault(DEFAULT_KDF)).toBe(false);
    expect(isWeakerThanDefault({ ...DEFAULT_KDF, mKib: DEFAULT_KDF.mKib * 2 })).toBe(false);
  });
});
