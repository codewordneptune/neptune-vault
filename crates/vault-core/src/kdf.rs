//! Password key derivation for the seed envelope: Argon2id.
//!
//! The derived key wraps the content key that encrypts the seed (AES-GCM is
//! done with WebCrypto on the JavaScript side). Parameters are stored next to
//! the ciphertext so they can be raised later without breaking old envelopes.

use anyhow::anyhow;
use anyhow::Result;
use argon2::Algorithm;
use argon2::Argon2;
use argon2::Params;
use argon2::Version;
use zeroize::Zeroizing;

/// Defaults tuned for about one second on a 2024 phone in wasm:
/// 64 MiB, 3 passes, 1 lane.
pub const DEFAULT_M_KIB: u32 = 64 * 1024;
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 1;
pub const KEY_LEN: usize = 32;

pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    m_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    if salt.len() < 16 {
        return Err(anyhow!("salt must be at least 16 bytes"));
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
