//! Password key derivation for the seed envelope: Argon2id.
//!
//! The derived key wraps the content key that encrypts the seed (AES-GCM is
//! done with WebCrypto on the JavaScript side). Parameters are stored next to
//! the ciphertext so they can be raised later without breaking old envelopes.
//!
//! The seed phrase wraps the same content key under a key of its own, so it
//! can set a new password when the old one is forgotten: see
//! [`seed_unlock_key`].

use anyhow::anyhow;
use anyhow::Result;
use argon2::Algorithm;
use argon2::Argon2;
use argon2::Params;
use argon2::Version;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Defaults tuned for about one second on a 2024 phone in wasm:
/// 64 MiB, 3 passes, 1 lane.
pub const DEFAULT_M_KIB: u32 = 64 * 1024;
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 1;
pub const KEY_LEN: usize = 32;

/// What this core will run. The parameters come from stored data and from
/// backup files, which is to say from outside. Above the ceiling a file could
/// hold the worker for as long as it liked; below the floor (OWASP's minimum
/// for Argon2id: 19 MiB, 2 passes) an envelope would be cheap to guess
/// against, and nothing this app ever wrote is below it.
pub const MIN_M_KIB: u32 = 19 * 1024;
pub const MAX_M_KIB: u32 = 1024 * 1024;
pub const MIN_T_COST: u32 = 2;
pub const MAX_T_COST: u32 = 16;
pub const MAX_P_COST: u32 = 4;
pub const MAX_SALT_LEN: usize = 64;

pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    m_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    if salt.len() < 16 || salt.len() > MAX_SALT_LEN {
        return Err(anyhow!("salt must be 16 to {MAX_SALT_LEN} bytes"));
    }
    if !(MIN_M_KIB..=MAX_M_KIB).contains(&m_kib) || !(MIN_T_COST..=MAX_T_COST).contains(&t_cost) || !(1..=MAX_P_COST).contains(&p_cost) {
        return Err(anyhow!("the password hash parameters are out of range (memory {m_kib} KiB, passes {t_cost}, lanes {p_cost})"));
    }
    let params = Params::new(m_kib, t_cost, p_cost, Some(KEY_LEN))
        .map_err(|e| anyhow!("bad Argon2 parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password, salt, out.as_mut())
        .map_err(|e| anyhow!("Argon2 failed: {e}"))?;
    Ok(out)
}

const SEED_UNLOCK_INFO: &[u8] = b"neptune-vault seed unlock key v1";

/// The key the seed phrase wraps a wallet's content key under.
///
/// HKDF-SHA256, not Argon2id: a phrase carries 192 bits, and there is no
/// guessing to slow down. The words are taken lower case, one space apart,
/// as the envelope keeps them. The web app derives the same key with
/// WebCrypto (`seedUnlockKey` in `storage/envelope.ts`), held to this by
/// `test-vectors/seed-envelope.json`.
pub fn seed_unlock_key(phrase: &[String], salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    if salt.len() < 16 || salt.len() > MAX_SALT_LEN {
        return Err(anyhow!("salt must be 16 to {MAX_SALT_LEN} bytes"));
    }
    let words: Vec<String> = phrase
        .iter()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    let text = Zeroizing::new(words.join(" "));
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(salt), text.as_bytes())
        .expand(SEED_UNLOCK_INFO, out.as_mut())
        .map_err(|_| anyhow!("cannot derive the seed phrase key"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn the_seed_phrase_key_takes_the_words_as_the_envelope_keeps_them() {
        let salt = [7u8; 16];
        let key = seed_unlock_key(&words("abandon ability able"), &salt).unwrap();
        let typed = seed_unlock_key(&words(" Abandon  ABILITY able "), &salt).unwrap();
        assert_eq!(*key, *typed);
        assert_ne!(*key, *seed_unlock_key(&words("abandon ability able"), &[8u8; 16]).unwrap());
        assert_ne!(*key, *seed_unlock_key(&words("abandon able ability"), &salt).unwrap());
        assert!(seed_unlock_key(&words("abandon"), &[0u8; 15]).is_err());
    }
}
