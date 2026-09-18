//! Seed, phrase and key derivation.
//!
//! Wraps neptune-wallet so the phrase, the derivation of keys and the bech32m
//! addresses are byte for byte what neptune-core produces.

use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use neptune_primitives::network::Network;
use neptune_wallet::address::ReceivingAddress;
use neptune_wallet::address::SpendingKey;
use neptune_wallet::secret_key_material::SecretKeyMaterial;
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::wallet_entropy::WalletEntropy;
use rand::Rng;
use serde::Deserialize;
use serde::Serialize;

/// How many keys of each kind beyond the highest used index are scanned for,
/// so that funds sent to a not-yet-shown address are still found.
pub const KEY_LOOKAHEAD: u64 = 5;

/// The address kinds the app offers. Symmetric keys are left out: they are
/// secrets, not addresses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    /// Lattice-based, post-quantum; long addresses, safe to reuse.
    #[default]
    Generation,
    /// Elliptic-curve hybrid; short addresses, meant for a single payer.
    EcHybrid,
    /// Viewing address; whoever holds it can see its incoming payments.
    Viewing,
}

impl KeyKind {
    pub const ALL: [KeyKind; 3] = [KeyKind::Generation, KeyKind::EcHybrid, KeyKind::Viewing];

    /// Parse the serde name (`generation`, `ec_hybrid`, `viewing`).
    pub fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "generation" => KeyKind::Generation,
            "ec_hybrid" => KeyKind::EcHybrid,
            "viewing" => KeyKind::Viewing,
            other => bail!("unknown key kind: {other}"),
        })
    }

    fn slot(self) -> usize {
        match self {
            KeyKind::Generation => 0,
            KeyKind::EcHybrid => 1,
            KeyKind::Viewing => 2,
        }
    }
}

/// An unlocked account: the wallet entropy plus a cache of derived keys.
///
/// Generation key derivation runs a lattice key generation per key, so keys
/// are derived once and kept for the life of the object.
pub struct Account {
    secret: SecretKeyMaterial,
    entropy: WalletEntropy,
    network: Network,
    /// Derived keys per kind, indexed by derivation index.
    keys: [Vec<SpendingKey>; 3],
}

/// Locking ends the worker that holds this object, which releases all of
/// its memory at once. Overwriting the secrets on the way out is the second
/// line: it covers an account replaced by another in a worker that lives on.
/// Best effort only. The upstream key types are plain data with no wiping
/// of their own, and the derived keys on the heap are freed, not cleared.
impl Drop for Account {
    fn drop(&mut self) {
        let blank = SecretKeyMaterial(neptune_wallet::twenty_first::prelude::XFieldElement::new_const(neptune_wallet::twenty_first::prelude::BFieldElement::new(0)));
        self.secret = blank;
        self.entropy = WalletEntropy::new(blank);
        for keys in &mut self.keys {
            keys.clear();
        }
        // Keep the optimiser from dropping stores to an object about to go.
        std::hint::black_box(&self.secret);
        std::hint::black_box(&self.entropy);
    }
}

impl Account {
    /// A fresh 18-word phrase from the browser's random source.
    pub fn generate_phrase() -> Vec<String> {
        SecretKeyMaterial(rand::rng().random()).to_phrase()
    }

    pub fn from_phrase(words: &[String], network: Network) -> Result<Self> {
        let secret = SecretKeyMaterial::from_phrase(words.iter().map(|w| w.trim()))
            .context("invalid seed phrase")?;
        Ok(Self {
            secret,
            entropy: WalletEntropy::new(secret),
            network,
            keys: Default::default(),
        })
    }

    pub fn phrase(&self) -> Vec<String> {
        self.secret.to_phrase()
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn entropy(&self) -> &WalletEntropy {
        &self.entropy
    }

    fn derive(&self, kind: KeyKind, index: u64) -> SpendingKey {
        match kind {
            KeyKind::Generation => {
                SpendingKey::Generation(self.entropy.nth_generation_spending_key(index))
            }
            KeyKind::EcHybrid => SpendingKey::EcHybrid(self.entropy.nth_ec_hybrid_key(index)),
            KeyKind::Viewing => {
                SpendingKey::ViewingAddressKey(self.entropy.nth_viewing_address_key(index))
            }
        }
    }

    /// Derive keys of `kind` up to and including `max_index`.
    pub fn ensure_keys(&mut self, kind: KeyKind, max_index: u64) {
        while (self.keys[kind.slot()].len() as u64) <= max_index {
            let index = self.keys[kind.slot()].len() as u64;
            let key = self.derive(kind, index);
            self.keys[kind.slot()].push(key);
        }
    }

    pub fn key(&mut self, kind: KeyKind, index: u64) -> &SpendingKey {
        self.ensure_keys(kind, index);
        &self.keys[kind.slot()][index as usize]
    }

    /// All keys of `kind` with index at most `max_index`, in index order.
    pub fn keys_up_to(&mut self, kind: KeyKind, max_index: u64) -> Vec<SpendingKey> {
        self.ensure_keys(kind, max_index);
        self.keys[kind.slot()][..=max_index as usize].to_vec()
    }

    /// The receiving address of the nth key of `kind`, bech32m for the
    /// account's network.
    pub fn address(&mut self, kind: KeyKind, index: u64) -> Result<String> {
        let network = self.network;
        self.key(kind, index).to_address().to_bech32m(network)
    }

    /// Kind and index of the derived key whose lock script hash matches, if any.
    pub fn key_for_lock_script_hash(&self, lock_script_hash: Digest) -> Option<(KeyKind, u64)> {
        KeyKind::ALL.into_iter().find_map(|kind| {
            self.keys[kind.slot()]
                .iter()
                .position(|k| k.lock_script_hash() == lock_script_hash)
                .map(|i| (kind, i as u64))
        })
    }

    pub fn parse_address(&self, encoded: &str) -> Result<ReceivingAddress> {
        ReceivingAddress::from_bech32m(encoded.trim(), self.network)
            .with_context(|| format!("not a valid {} address", self.network))
    }
}

/// Words in a phrase.
pub const PHRASE_WORDS: usize = 18;

/// Why the words cannot be a seed phrase, said for the person typing it, or
/// None when they can. Checked on the import screen before anything is
/// sealed or derived. A word off the list is named by position, since that
/// is a typo; real words that fail the checksum are a wrong or misplaced
/// word, and the backup is the only place to check.
pub fn phrase_problem(words: &[String]) -> Option<String> {
    if words.len() != PHRASE_WORDS {
        return Some(format!(
            "A seed phrase has {PHRASE_WORDS} words; this has {}.",
            words.len()
        ));
    }
    let list = bip39::Language::English.wordmap();
    for (i, word) in words.iter().enumerate() {
        let word = word.trim();
        if list.get_bits(word).is_err() {
            return Some(format!(
                "Word {}, \"{word}\", is not in the word list.",
                i + 1
            ));
        }
    }
    match SecretKeyMaterial::from_phrase(words.iter().map(|w| w.trim())) {
        Ok(_) => None,
        Err(_) => Some(
            "Every word is on the list, but together they are not a valid seed phrase. \
             Check the words and their order against your backup."
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neptune_wallet::twenty_first::prelude::BFieldElement;
    use neptune_wallet::twenty_first::prelude::XFieldElement;

    fn fixed_phrase() -> Vec<String> {
        SecretKeyMaterial(XFieldElement::new([
            BFieldElement::new(1),
            BFieldElement::new(2),
            BFieldElement::new(3),
        ]))
        .to_phrase()
    }

    #[test]
    fn a_real_phrase_has_no_problem() {
        assert_eq!(phrase_problem(&fixed_phrase()), None);
        assert_eq!(phrase_problem(&Account::generate_phrase()), None);
    }

    #[test]
    fn a_typo_is_named_by_position() {
        let mut words = fixed_phrase();
        words[6] = "abandom".to_string();
        assert_eq!(
            phrase_problem(&words).unwrap(),
            "Word 7, \"abandom\", is not in the word list."
        );
    }

    #[test]
    fn a_short_phrase_is_counted() {
        let words = fixed_phrase()[..17].to_vec();
        assert_eq!(
            phrase_problem(&words).unwrap(),
            "A seed phrase has 18 words; this has 17."
        );
    }

    #[test]
    fn real_words_in_the_wrong_order_fail_the_checksum() {
        let mut words = fixed_phrase();
        words.swap(0, 17);
        let problem = phrase_problem(&words).unwrap();
        assert!(problem.starts_with("Every word is on the list"), "{problem}");
    }
}
