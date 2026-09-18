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
use neptune_primitives::announcement_flag::AnnouncementFlag;
use neptune_rpc_api::model::block::transaction_kernel::RpcAbsoluteIndexSet;
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
    /// The app's primary key for the coin: hex of `Tip5::hash(utxo)`, a
    /// colon, and the coin's index in the chain's list of all coins. The
    /// hash alone is not unique: a UTXO is only a lock script and an amount,
    /// so two payments of one amount to one address hash the same, whenever
    /// they are made. The index is unique on a chain by construction.
    /// Records from before the index was appended are re-keyed when the
    /// database is upgraded.
    pub hash: String,
    /// Hex of the addition record's canonical commitment: what the block
    /// carries and what the explorer indexes an output by. Empty on records
    /// from before it was kept (a rescan fills it).
    #[serde(default)]
    pub commitment: String,
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
    /// The block height a transaction built from this seed was built against
    /// when it created this coin, or None when someone else created it. This
    /// seed derives every output's sender randomness from the build height
    /// and the receiving address, so its own outputs (change, payments to
    /// itself) are recognisable exactly, on any device and after a rescan.
    /// Absent on records scanned before it was kept (a rescan fills it).
    #[serde(default)]
    pub own_build_height: Option<u64>,
}

/// How far back from a coin's confirmation height to look for the height
/// its transaction was built against. A transaction waits at most hours
/// in practice; a thousand blocks is about a week.
pub const OWN_OUTPUT_WINDOW: u64 = 1000;

/// The height a transaction built from this seed was built against when it
/// created an output with `sender_randomness` for the key at
/// (`kind`, `index`), searching `latest` and the window below it; None
/// when no height matches, meaning another wallet created the output.
pub fn own_build_height(
    account: &mut Account,
    kind: KeyKind,
    index: u64,
    sender_randomness: Digest,
    latest: u64,
) -> Option<u64> {
    let privacy_digest = account.key(kind, index).to_address().privacy_digest();
    let entropy = account.entropy();
    let lowest = latest.saturating_sub(OWN_OUTPUT_WINDOW);
    (lowest..=latest)
        .rev()
        .find(|&h| entropy.generate_sender_randomness(h.into(), privacy_digest) == sender_randomness)
}

/// What a fast restore asks the node's index for: the announcement flag
/// (purpose, receiver identifier) of every key the scan would try, the
/// same keys up to the lookahead per kind. The node learns these.
pub fn announcement_flags(account: &mut Account, next_key_indices: &NextKeyIndices) -> Vec<AnnouncementFlag> {
    let mut flags = Vec::new();
    for kind in KeyKind::ALL {
        for key in account.keys_up_to(kind, next_key_indices.get(kind) + KEY_LOOKAHEAD) {
            flags.push(AnnouncementFlag::from(&key.to_address()));
        }
    }
    flags
}

/// The index sets the node's index is asked about to learn where these
/// coins were spent; the same values the membership-proof request carries.
pub fn absolute_index_sets(unspent: &[StoredUtxo]) -> Vec<RpcAbsoluteIndexSet> {
    unspent.iter().map(|u| u.absolute_index_set().into()).collect()
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

/// The key a coin is stored under, see `StoredUtxo::hash`.
pub fn coin_key(utxo_hash: Digest, aocl_index: u64) -> String {
    format!("{}:{aocl_index}", utxo_hash.to_hex())
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
    let mut taken: HashSet<usize> = HashSet::new();
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
        let own_build_height = own_build_height(account, key_kind, key_index, found.sender_randomness, height);

        let native_amount = found.utxo.get_native_currency_amount();
        // Two outputs of one transaction can carry the same addition record
        // (same amount, same address, same build height): each announcement
        // then takes its own position, so both coins are kept.
        let position = addition_records
            .iter()
            .enumerate()
            .position(|(i, ar)| *ar == addition_record && !taken.contains(&i))
            .unwrap_or(position);
        taken.insert(position);
        let aocl_index = num_aocl_leafs_prior + position as u64;
        let recovery = IncomingUtxoRecoveryData {
            utxo: found.utxo.clone(),
            sender_randomness: found.sender_randomness,
            receiver_preimage: found.receiver_preimage,
            aocl_index,
        };
        incoming.push(StoredUtxo {
            hash: coin_key(Tip5::hash(&found.utxo), aocl_index),
            commitment: addition_record.canonical_commitment.to_hex(),
            recovery,
            amount_nau: amount::to_nau_string(native_amount),
            amount: amount::format(native_amount),
            key_kind,
            key_index,
            release_date_ms: found.utxo.release_date().map(|t| t.0.value()),
            confirmed_height: height,
            confirmed_block: block_hash_hex.to_string(),
            confirmed_timestamp_ms: timestamp_ms,
            own_build_height,
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

/// An output of an unmined transaction that belongs to this wallet. Not
/// spendable: it has no mutator-set index until a block carries it, and the
/// block scan produces the real `StoredUtxo` then. The commitment is what
/// ties the two together.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingIncoming {
    /// Hex of the addition record's canonical commitment.
    pub commitment: String,
    pub amount_nau: String,
    pub amount: String,
    pub key_kind: KeyKind,
    pub key_index: u64,
    /// Created by a transaction built from this seed (change, or a payment
    /// to itself): not incoming.
    pub own: bool,
    /// Time lock, if any, as milliseconds since the epoch: the payment
    /// cannot be spent before it, however many blocks confirm it.
    #[serde(default)]
    pub release_date_ms: Option<u64>,
}

/// What one mempool transaction means for this wallet.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MempoolScan {
    pub incoming: Vec<PendingIncoming>,
    /// Hashes of this wallet's unspent UTXOs the transaction spends.
    pub spent: Vec<String>,
    pub timestamp_ms: u64,
}

/// Scan an unmined transaction: announcements addressed to this wallet's keys
/// (up to the lookahead) whose addition record the transaction really
/// carries, and inputs that are this wallet's coins. Key indices are not
/// advanced; the block scan does that when the output is confirmed.
pub fn scan_mempool_kernel(
    account: &mut Account,
    tx_kernel: &TransactionKernel,
    unspent: &[StoredUtxo],
    next_key_indices: NextKeyIndices,
    tip_height: u64,
) -> MempoolScan {
    let mut keys = Vec::new();
    for kind in KeyKind::ALL {
        keys.extend(account.keys_up_to(kind, next_key_indices.get(kind) + KEY_LOOKAHEAD));
    }
    let announced = SpendingKey::scan_announcements_for_keys(&tx_kernel.announcements, keys);

    let mut incoming = Vec::new();
    for found in announced {
        let addition_record = found.addition_record();
        if !tx_kernel.outputs.contains(&addition_record) {
            continue;
        }
        if !found.utxo.all_type_script_states_are_valid() {
            continue;
        }
        let Some((key_kind, key_index)) =
            account.key_for_lock_script_hash(found.utxo.lock_script_hash())
        else {
            continue;
        };
        let native_amount = found.utxo.get_native_currency_amount();
        // Built against the tip or a little below it; the next block is
        // allowed for a node slightly ahead of this wallet.
        let own = own_build_height(account, key_kind, key_index, found.sender_randomness, tip_height + 1).is_some();
        incoming.push(PendingIncoming {
            commitment: addition_record.canonical_commitment.to_hex(),
            amount_nau: amount::to_nau_string(native_amount),
            amount: amount::format(native_amount),
            key_kind,
            key_index,
            own,
            release_date_ms: found.utxo.release_date().map(|t| t.0.value()),
        });
    }

    let consumed: HashSet<AbsoluteIndexSet> = tx_kernel
        .inputs
        .iter()
        .map(|rr| rr.absolute_indices)
        .collect();
    let spent = unspent
        .iter()
        .filter(|u| consumed.contains(&u.absolute_index_set()))
        .map(|u| u.hash.clone())
        .collect();

    MempoolScan {
        incoming,
        spent,
        timestamp_ms: tx_kernel.timestamp.0.value(),
    }
}
