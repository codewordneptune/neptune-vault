//! Scanning blocks for incoming funds and for spends of known UTXOs.
//!
//! Follows the desktop wallet's `update_new_tip` but is pure: the caller
//! hands in the blocks and the currently unspent UTXOs, and gets back what
//! changed. Persistence is the JavaScript side's job.

use std::collections::HashSet;

use anyhow::anyhow;
use anyhow::Result;
use neptune_consensus::block::block_kernel::BlockKernel;
use neptune_consensus::transaction::transaction_kernel::TransactionKernel;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_wallet::address::SpendingKey;
use neptune_wallet::incoming_utxo::IncomingUtxoRecoveryData;
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::tasm_lib::prelude::Tip5;
use serde::Deserialize;
use serde::Serialize;

use crate::account::Account;
use crate::account::KeyKind;
use crate::account::KEY_LOOKAHEAD;
use crate::amount;

/// A UTXO the wallet owns, as stored by the app. Everything needed to spend
/// it later is in `recovery`; the rest is for display and bookkeeping.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredUtxo {
    /// Hex of `Tip5::hash(utxo)`, the app's primary key for the UTXO.
    pub hash: String,
    pub recovery: IncomingUtxoRecoveryData,
    /// Amount in nau as a decimal string (JavaScript uses BigInt on it).
    pub amount_nau: String,
    /// Amount formatted for display.
    pub amount: String,
    /// Kind of the key that owns it (older records lack it: generation).
    #[serde(default)]
    pub key_kind: KeyKind,
    /// Derivation index of that key.
    pub key_index: u64,
    /// Time lock, if any, as milliseconds since the epoch.
    pub release_date_ms: Option<u64>,
    pub confirmed_height: u64,
    pub confirmed_block: String,
    pub confirmed_timestamp_ms: u64,
}

impl StoredUtxo {
    pub fn absolute_index_set(&self) -> AbsoluteIndexSet {
        AbsoluteIndexSet::compute(
            Tip5::hash(&self.recovery.utxo),
            self.recovery.sender_randomness,
            self.recovery.receiver_preimage,
            self.recovery.aocl_index,
        )
    }
}

/// What one block changed for this wallet.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScannedBlock {
    pub height: u64,
    pub hash: String,
    pub prev_hash: String,
    pub timestamp_ms: u64,
    pub incoming: Vec<StoredUtxo>,
    /// Hashes of previously unspent UTXOs consumed in this block.
    pub spent: Vec<String>,
}

/// Next unused derivation index per key kind.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NextKeyIndices {
    pub generation: u64,
    pub ec_hybrid: u64,
    pub viewing: u64,
}

impl NextKeyIndices {
    pub fn get(&self, kind: KeyKind) -> u64 {
        match kind {
            KeyKind::Generation => self.generation,
            KeyKind::EcHybrid => self.ec_hybrid,
            KeyKind::Viewing => self.viewing,
        }
    }

    /// Record that key `index` of `kind` has been used.
    pub fn mark_used(&mut self, kind: KeyKind, index: u64) {
        let slot = match kind {
            KeyKind::Generation => &mut self.generation,
            KeyKind::EcHybrid => &mut self.ec_hybrid,
            KeyKind::Viewing => &mut self.viewing,
        };
        *slot = (*slot).max(index + 1);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub blocks: Vec<ScannedBlock>,
    /// Next unused key indices after this scan.
    pub next_key_indices: NextKeyIndices,
}

/// Scan a batch of blocks, in order. `unspent` are the wallet's unspent UTXOs
/// before the batch; UTXOs found in earlier blocks of the batch are watched
/// for spends in later ones.
pub fn scan_blocks(
    account: &mut Account,
    blocks: Vec<RpcWalletBlock>,
    unspent: Vec<StoredUtxo>,
    next_key_indices: NextKeyIndices,
) -> Result<ScanResult> {
    let mut working_unspent = unspent;
    let mut next_key_indices = next_key_indices;
    let mut scanned = Vec::with_capacity(blocks.len());

    for block in blocks {
        let block_hash = block.hash();
        let kernel: BlockKernel = block.kernel.into();
        let addition_records = kernel
            .all_addition_records(block_hash)
            .map_err(|e| anyhow!("block {} has invalid guesser fee records: {e:?}", kernel.header.height))?;
        let num_aocl_leafs_prior = kernel.body.num_aocl_leafs_prior();
        let height: u64 = kernel.header.height.into();
        let timestamp_ms = kernel.header.timestamp.0.value();

        let (incoming, spent, next) = scan_kernel(
            account,
            &kernel.body.transaction_kernel,
            &addition_records,
            num_aocl_leafs_prior,
            &working_unspent,
            next_key_indices,
            height,
            &block_hash.to_hex(),
            timestamp_ms,
        );
        next_key_indices = next;

        working_unspent.retain(|u| !spent.contains(&u.hash));
        working_unspent.extend(incoming.iter().cloned());

        scanned.push(ScannedBlock {
            height,
            hash: block_hash.to_hex(),
            prev_hash: kernel.header.prev_block_digest.to_hex(),
            timestamp_ms,
            incoming,
            spent,
        });
    }

    Ok(ScanResult {
        blocks: scanned,
        next_key_indices,
    })
}

/// The block-independent core of scanning, so tests can drive it with a bare
/// transaction kernel. Returns (incoming, spent hashes, next key indices).
#[allow(clippy::too_many_arguments)]
pub fn scan_kernel(
    account: &mut Account,
    tx_kernel: &TransactionKernel,
    addition_records: &[AdditionRecord],
    num_aocl_leafs_prior: u64,
    unspent: &[StoredUtxo],
    next_key_indices: NextKeyIndices,
    height: u64,
    block_hash_hex: &str,
    timestamp_ms: u64,
) -> (Vec<StoredUtxo>, Vec<String>, NextKeyIndices) {
    // Incoming: decrypt announcements addressed to any key of any kind up to
    // the lookahead, then confirm the addition record really is in the block.
    let mut keys = Vec::new();
    for kind in KeyKind::ALL {
        keys.extend(account.keys_up_to(kind, next_key_indices.get(kind) + KEY_LOOKAHEAD));
    }
    let announced = SpendingKey::scan_announcements_for_keys(&tx_kernel.announcements, keys);

    let mut next_key_indices = next_key_indices;
    let mut incoming = Vec::new();
    for found in announced {
        let addition_record = found.addition_record();
        let Some(position) = addition_records.iter().position(|ar| *ar == addition_record) else {
            continue;
        };
        if !found.utxo.all_type_script_states_are_valid() {
            continue;
        }
        let Some((key_kind, key_index)) = account.key_for_lock_script_hash(found.utxo.lock_script_hash())
        else {
            continue;
        };
        next_key_indices.mark_used(key_kind, key_index);

        let native_amount = found.utxo.get_native_currency_amount();
        let recovery = IncomingUtxoRecoveryData {
            utxo: found.utxo.clone(),
            sender_randomness: found.sender_randomness,
            receiver_preimage: found.receiver_preimage,
            aocl_index: num_aocl_leafs_prior + position as u64,
        };
        incoming.push(StoredUtxo {
            hash: Tip5::hash(&found.utxo).to_hex(),
            recovery,
            amount_nau: amount::to_nau_string(native_amount),
            amount: amount::format(native_amount),
            key_kind,
            key_index,
            release_date_ms: found.utxo.release_date().map(|t| t.0.value()),
            confirmed_height: height,
            confirmed_block: block_hash_hex.to_string(),
            confirmed_timestamp_ms: timestamp_ms,
        });
    }

    // Spent: a removal record's absolute index set equals ours exactly.
    let consumed: HashSet<AbsoluteIndexSet> = tx_kernel
        .inputs
        .iter()
        .map(|rr| rr.absolute_indices)
        .collect();
    let spent = if consumed.is_empty() {
        Vec::new()
    } else {
        unspent
            .iter()
            .filter(|u| consumed.contains(&u.absolute_index_set()))
            .map(|u| u.hash.clone())
            .collect()
    };

    (incoming, spent, next_key_indices)
}

/// Digest as the app stores it.
pub fn digest_hex(d: Digest) -> String {
    d.to_hex()
}
