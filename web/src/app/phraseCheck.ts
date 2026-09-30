// A salted fingerprint of a wallet's seed phrase, kept beside the wallet on
// this device, so that "Forgot password?" can tell whether the words typed
// are this wallet's before the wallet is replaced by the one they open.
//
// It gives nothing away. It is not an address and leads to none, so it
// cannot tie this device to anything on the chain (the reason no address
// is kept in the clear); and the phrase behind it, 18 words or 192 bits,
// cannot be guessed back from it, salt or not. The salt keeps the same
// phrase on two devices, or in two wallets, from showing as the same.

export interface PhraseCheck {
  /** Random, 16 bytes, base64. */
  salt: string;
  /** PBKDF2-SHA-256 of the words, 256 bits, base64. */
  hash: string;
}

const ITERATIONS = 100_000;

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The words as they are compared: trimmed, lower case, one space apart. */
function normalise(words: string[]): string {
  return words
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

/** The fingerprint of a phrase, under a new salt or the one given. */
export async function phraseCheckOf(words: string[], salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16))): Promise<PhraseCheck> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalise(words)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return { salt: toB64(salt), hash: toB64(new Uint8Array(bits)) };
}

/** Whether these words are the ones the fingerprint was made from. */
export async function phraseMatches(words: string[], check: PhraseCheck): Promise<boolean> {
  return (await phraseCheckOf(words, fromB64(check.salt))).hash === check.hash;
}
