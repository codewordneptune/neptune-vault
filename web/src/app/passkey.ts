// Passkey unlock through WebAuthn's PRF extension: the authenticator derives
// a 32-byte secret from a salt we store, only after user verification
// (biometric or device PIN). That secret wraps the envelope's content key,
// so unlocking with the passkey never involves the password, and the
// password keeps working as the fallback. Device-bound: the wrapping is not
// part of the export file.

/** A cancelled or timed-out system sheet is not an error to show, on the lock screen or in Settings. */
export function isCancellation(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  const message = (e as Error).message ?? '';
  return name === 'NotAllowedError' || name === 'AbortError' || /cancel/i.test(message);
}

export interface PasskeyEnrolment {
  credentialId: string;
  prfSalt: string;
  /** 32-byte PRF output for this salt. */
  secret: Uint8Array;
}

/** What the account service needs; a fake stands in for tests. */
export interface PasskeyProvider {
  supported(): Promise<boolean>;
  enrol(userName: string): Promise<PasskeyEnrolment>;
  secret(credentialId: string, prfSalt: string): Promise<Uint8Array>;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

export class WebAuthnPasskeys implements PasskeyProvider {
  async supported(): Promise<boolean> {
    if (!('PublicKeyCredential' in window) || !navigator.credentials) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  async enrol(userName: string): Promise<PasskeyEnrolment> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const created = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Neptune Vault', id: location.hostname },
        user: { id: ab(userId), name: userName, displayName: userName },
        challenge: ab(crypto.getRandomValues(new Uint8Array(32))),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!created) throw new Error('No passkey was created');
    const ext = created.getClientExtensionResults() as PrfResults;
    if (!ext.prf?.enabled) {
      throw new Error("This device's passkeys do not support the extension needed to protect the wallet, so passkey unlock is not available here. The password still works.");
    }
    const credentialId = toBase64Url(new Uint8Array(created.rawId));
    const prfSalt = toBase64Url(salt);
    // Most authenticators only evaluate the PRF on assertion, so fetch the
    // secret with a first assertion right away.
    const secret = await this.secret(credentialId, prfSalt);
    return { credentialId, prfSalt, secret };
  }

  async secret(credentialId: string, prfSalt: string): Promise<Uint8Array> {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: ab(crypto.getRandomValues(new Uint8Array(32))),
        allowCredentials: [{ type: 'public-key', id: ab(fromBase64Url(credentialId)) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: ab(fromBase64Url(prfSalt)) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error('Passkey check was cancelled');
    const first = (assertion.getClientExtensionResults() as PrfResults).prf?.results?.first;
    if (!first) throw new Error('The passkey did not return the secret needed to unlock');
    return new Uint8Array(first);
  }
}
