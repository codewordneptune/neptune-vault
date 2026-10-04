// The seed envelope is opened by two implementations now: this one, and
// the Rust in vault-bridge that a native shell uses. Both read this vector,
// so neither can quietly stop opening what the other wrote.
//
// It fixes the wrap key rather than a password, because Argon2id is not
// duplicated: both sides call the same Rust for it. What is written twice
// is how the two AES-GCM boxes nest, and that is what this pins.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { SeedEnvelope, SeedUnlock } from './db';
import { openSeed, openSeedWithSecret, openWithPhrase, WrongPhraseError, type DeriveKey } from './envelope';

interface Vector {
  wrap_key: string;
  envelope: SeedEnvelope;
  phrase: string[];
  passkey_wrapped: { iv: string; ciphertext: string };
  passkey_secret: string;
  seed_unlock: SeedUnlock;
}

const vector: Vector = JSON.parse(
  readFileSync(new URL('../../../test-vectors/seed-envelope.json', import.meta.url), 'utf8'),
) as Vector;

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
/** Stands in for Argon2id, which is one shared implementation already. */
const fixedWrapKey: DeriveKey = () => bytes(vector.wrap_key);

describe('the shared envelope vector', () => {
  it('opens with the wrap key', async () => {
    expect(await openSeed(vector.envelope, 'any password', fixedWrapKey)).toEqual(vector.phrase);
  });

  it('opens with a passkey secret', async () => {
    const phrase = await openSeedWithSecret(
      vector.envelope,
      vector.passkey_wrapped,
      bytes(vector.passkey_secret),
    );
    expect(phrase).toEqual(vector.phrase);
  });

  it('opens with the seed phrase, and with no other', async () => {
    const opened = await openWithPhrase(vector.envelope, vector.seed_unlock, vector.phrase);
    expect(await openSeedWithSecret(vector.envelope, vector.seed_unlock.wrappedContentKey, opened.secret)).toEqual(vector.phrase);
    const other = [vector.phrase[1], vector.phrase[0], ...vector.phrase.slice(2)];
    await expect(openWithPhrase(vector.envelope, vector.seed_unlock, other)).rejects.toBeInstanceOf(WrongPhraseError);
  });
});
