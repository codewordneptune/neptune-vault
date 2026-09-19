//! The seed envelope, opened where the seed can stay.
//!
//! The web app's `storage/envelope.ts` is the reference: it made every
//! envelope that exists, and this must open all of them. The format is two
//! layers of AES-256-GCM over one Argon2id derivation:
//!
//! ```text
//! password --argon2id(salt, params)--> wrap key
//! wrap key --aes-256-gcm--> content key   (the wrappedContentKey box)
//! content key --aes-256-gcm--> the phrase, as UTF-8 words joined by spaces
//! ```
//!
//! The middle layer is what lets a passkey open the same envelope: the
//! content key is wrapped a second time under the passkey's secret, and
//! that box is stored beside the envelope rather than in it.
//!
//! Only the AES layering is written twice, once here and once in
//! TypeScript. Argon2id is not: both sides call `vault_core::kdf`, one
//! through wasm and one directly, so the expensive half of the format
//! cannot drift. The layering is held to the other implementation by
//! `test-vectors/seed-envelope.json`, which both test suites read.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::BridgeError;

type Result<T> = std::result::Result<T, BridgeError>;

/// The most work an envelope may ask of this device.
///
/// An envelope arrives as data, and its parameters say how much memory and
/// time to spend. Without a ceiling, a file could ask for a terabyte of
/// Argon2 memory and take the app down with it. Must match `KDF_CEILING` in
/// `storage/envelope.ts`.
const CEILING_M_KIB: u32 = 1024 * 1024;
const CEILING_T_COST: u32 = 16;
const CEILING_P_COST: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub name: String,
    #[serde(rename = "mKib")]
    pub m_kib: u32,
    #[serde(rename = "tCost")]
    pub t_cost: u32,
    #[serde(rename = "pCost")]
    pub p_cost: u32,
    /// base64.
    pub salt: String,
}

/// One AES-256-GCM box, both fields base64.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedBox {
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedEnvelope {
    pub version: u32,
    pub kdf: KdfParams,
    pub wrapped_content_key: SealedBox,
    pub seed: SealedBox,
}

fn malformed(what: &str) -> BridgeError {
    BridgeError::plain(format!("This wallet data is malformed ({what})."))
}

fn wrong_password() -> BridgeError {
    BridgeError::new("WrongPasswordError", "wrong password")
}

fn decode(text: &str, what: &str) -> Result<Vec<u8>> {
    if text.len() > 4096 {
        return Err(malformed(what));
    }
    BASE64.decode(text).map_err(|_| malformed(what))
}

/// Everything about an envelope that can be checked without the password.
///
/// The exact lengths matter beyond tidiness: AES-GCM does not commit to one
/// key, so a wrapped key of another length is where a ciphertext built to
/// open under many passwords would hide.
pub fn assert_envelope(envelope: &SeedEnvelope) -> Result<()> {
    if envelope.version != 1 || envelope.kdf.name != "argon2id" {
        return Err(BridgeError::plain(format!(
            "unsupported envelope version {}",
            envelope.version
        )));
    }
    let kdf = &envelope.kdf;
    let within = kdf.m_kib >= 1
        && kdf.m_kib <= CEILING_M_KIB
        && kdf.t_cost >= 1
        && kdf.t_cost <= CEILING_T_COST
        && kdf.p_cost >= 1
        && kdf.p_cost <= CEILING_P_COST;
    if !within {
        return Err(BridgeError::plain(
            "This wallet data asks for a password hash this app will not run: its parameters are out of range.",
        ));
    }

    let salt = decode(&kdf.salt, "salt")?.len();
    if !(16..=64).contains(&salt) {
        return Err(malformed("salt"));
    }

    // A 32-byte key and AES-GCM's 16-byte tag.
    let iv = decode(&envelope.wrapped_content_key.iv, "wrapped key")?.len();
    let ciphertext = decode(&envelope.wrapped_content_key.ciphertext, "wrapped key")?.len();
    if iv != 12 || ciphertext != 48 {
        return Err(malformed("wrapped key"));
    }

    let iv = decode(&envelope.seed.iv, "seed")?.len();
    let ciphertext = decode(&envelope.seed.ciphertext, "seed")?.len();
    if iv != 12 || !(17..=1024).contains(&ciphertext) {
        return Err(malformed("seed"));
    }
    Ok(())
}

/// Open one box under a 32-byte key.
fn open_box(key: &[u8], sealed: &SealedBox, what: &str) -> Result<Zeroizing<Vec<u8>>> {
    let key: [u8; 32] = key.try_into().map_err(|_| malformed(what))?;
    let cipher = Aes256Gcm::new(&key.into());
    let iv = decode(&sealed.iv, what)?;
    let ciphertext = decode(&sealed.ciphertext, what)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ciphertext,
                aad: &[],
            },
        )
        .map_err(|_| malformed(what))?;
    Ok(Zeroizing::new(plaintext))
}

/// The wrap key for an envelope, from a password. The expensive step.
fn wrap_key(envelope: &SeedEnvelope, password: &str) -> Result<Zeroizing<[u8; 32]>> {
    let salt = decode(&envelope.kdf.salt, "salt")?;
    vault_core::kdf::derive_key(
        password.as_bytes(),
        &salt,
        envelope.kdf.m_kib,
        envelope.kdf.t_cost,
        envelope.kdf.p_cost,
    )
    .map_err(Into::into)
}

/// The content key, after checking the password.
pub fn content_key(envelope: &SeedEnvelope, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    assert_envelope(envelope)?;
    let wrap = wrap_key(envelope, password)?;
    // The only thing a wrong password can look like: the wrapped key does
    // not authenticate. Everything past here is damage, not a typo.
    open_box(wrap.as_slice(), &envelope.wrapped_content_key, "wrapped key")
        .map_err(|_| wrong_password())
}

/// The content key, from a passkey's secret instead of a password.
///
/// `wrapped` is the same content key sealed under the secret, which the app
/// stores beside the envelope when a passkey is enrolled.
pub fn content_key_from_secret(
    wrapped: &SealedBox,
    secret: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    open_box(secret, wrapped, "passkey key").map_err(|_| wrong_password())
}

/// The seed phrase, given the content key.
pub fn phrase_from_content_key(
    envelope: &SeedEnvelope,
    content_key: &[u8],
) -> Result<Vec<String>> {
    let plaintext = open_box(content_key, &envelope.seed, "seed").map_err(|_| {
        // The password was right and the seed still does not open: the data
        // is damaged, or it is a newer backup file dressed as an older one.
        BridgeError::plain(
            "The password is right, but the seed in this wallet data does not open: the data is damaged or has been changed.",
        )
    })?;
    let text = std::str::from_utf8(&plaintext).map_err(|_| malformed("seed"))?;
    Ok(text.split(' ').map(str::to_string).collect())
}

/// Recover the phrase from an envelope and its password.
pub fn open_seed(envelope: &SeedEnvelope, password: &str) -> Result<Vec<String>> {
    let content = content_key(envelope, password)?;
    phrase_from_content_key(envelope, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector both implementations are held to. Only the AES layering
    /// is duplicated, so the vector fixes the wrap key rather than a
    /// password: what it pins is how the two boxes nest, which is exactly
    /// what could drift.
    #[derive(Deserialize)]
    struct Vector {
        /// base64, what Argon2id would have produced.
        wrap_key: String,
        envelope: SeedEnvelope,
        phrase: Vec<String>,
        /// The content key wrapped under a passkey secret, and that secret.
        passkey_wrapped: SealedBox,
        passkey_secret: String,
    }

    fn vector() -> Vector {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test-vectors/seed-envelope.json"
        );
        let text = std::fs::read_to_string(path).expect("the shared test vector");
        serde_json::from_str(&text).expect("the shared test vector parses")
    }

    #[test]
    fn opens_the_shared_vector() {
        let v = vector();
        let wrap = BASE64.decode(&v.wrap_key).unwrap();
        assert_envelope(&v.envelope).unwrap();
        let content = open_box(&wrap, &v.envelope.wrapped_content_key, "wrapped key").unwrap();
        assert_eq!(phrase_from_content_key(&v.envelope, &content).unwrap(), v.phrase);
    }

    #[test]
    fn opens_the_shared_vector_through_a_passkey() {
        let v = vector();
        let secret = BASE64.decode(&v.passkey_secret).unwrap();
        let content = content_key_from_secret(&v.passkey_wrapped, &secret).unwrap();
        assert_eq!(phrase_from_content_key(&v.envelope, &content).unwrap(), v.phrase);
    }

    #[test]
    fn a_wrong_wrap_key_is_a_wrong_password() {
        let v = vector();
        let e = content_key(&v.envelope, "not the password").unwrap_err();
        assert_eq!(e.name, "WrongPasswordError");
    }

    #[test]
    fn work_beyond_the_ceiling_is_refused() {
        let mut v = vector();
        v.envelope.kdf.m_kib = CEILING_M_KIB + 1;
        let e = assert_envelope(&v.envelope).unwrap_err();
        assert!(e.message.contains("out of range"), "{}", e.message);
    }

    #[test]
    fn a_wrapped_key_of_another_length_is_refused() {
        let mut v = vector();
        v.envelope.wrapped_content_key.ciphertext = BASE64.encode([0u8; 64]);
        assert!(assert_envelope(&v.envelope).is_err());
    }

    #[test]
    fn a_later_version_is_refused() {
        let mut v = vector();
        v.envelope.version = 2;
        let e = assert_envelope(&v.envelope).unwrap_err();
        assert!(e.message.contains("version 2"), "{}", e.message);
    }
}
