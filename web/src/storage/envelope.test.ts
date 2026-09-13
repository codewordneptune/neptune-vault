import { describe, expect, it } from 'vitest';

import { changePassword, openSeed, sealSeed, WrongPasswordError, type DeriveKey } from './envelope';

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
