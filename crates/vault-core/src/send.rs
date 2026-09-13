//! Planning a send: input selection, membership proofs, outputs, change,
//! and the primitive witness the prover consumes. Ported from the desktop
//! wallet's spend path, minus the retry loop and the node round trips, which
//! the JavaScript side drives.

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use neptune_consensus::block::block_header::BlockHeader;
use neptune_consensus::transaction::announcement::Announcement;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transaction_kernel::TransactionKernel;
use neptune_primitives::mast_hash::MastHash;
use num_traits::CheckedAdd;
use num_traits::CheckedSub;
use num_traits::Zero;
use neptune_consensus::transaction::transaction_proof::TransactionProof;
use neptune_consensus::transaction::transparent_input::TransparentInput;
use neptune_consensus::transaction::utxo::Utxo;
use neptune_consensus::transaction::validity::proof_collection::ProofCollection;
use neptune_consensus::transaction::Transaction;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_primitives::timestamp::Timestamp;
use neptune_rpc_api::model::block::header::RpcBlockHeader;
use neptune_rpc_api::model::block::transaction_kernel::RpcAbsoluteIndexSet;
use neptune_rpc_api::model::wallet::mutator_set::RpcMsMembershipSnapshot;
use neptune_rpc_api::model::wallet::transaction::RpcTransaction;
use neptune_wallet::transaction_details::TransactionDetails;
use neptune_wallet::transaction_output::TxOutput;
use neptune_wallet::transaction_output::TxOutputList;
use neptune_wallet::unlocked_utxo::UnlockedUtxo;
use neptune_wallet::utxo_notification::UtxoNotificationMethod;
use serde::Deserialize;
use serde::Serialize;

use crate::account::Account;
use crate::account::KeyKind;
use crate::amount;
use crate::scan::StoredUtxo;

/// What the user asked for.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendRequest {
    pub recipient: String,
    /// NPT, decimal text.
    pub amount: String,
    /// NPT, decimal text.
    pub fee: String,
    /// Whether lustration announcements may be added if the tip requires them.
    #[serde(default)]
    pub accept_lustration: bool,
}

/// Inputs chosen for a send, plus the absolute index sets to pass as the
/// single positional parameter of `wallet_restoreMembershipProof`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InputPlan {
    pub inputs: Vec<StoredUtxo>,
    pub absolute_index_sets: Vec<RpcAbsoluteIndexSet>,
    pub total_in_nau: String,
}

/// Everything the app needs after planning: the witness for the prover, the
/// kernel for assembly, and bookkeeping for the pending record.
#[derive(Clone, Debug)]
pub struct SendPlan {
    pub witness: Vec<u8>,
    pub kernel: Vec<u8>,
    pub summary: SendSummary,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendSummary {
    pub txid: String,
    pub input_hashes: Vec<String>,
    pub amount_nau: String,
    pub fee_nau: String,
    pub change_nau: Option<String>,
    pub timestamp_ms: u64,
    pub built_against_height: u64,
    pub built_against_hash: String,
    pub requires_lustration: bool,
}

/// Pick inputs oldest first until they cover amount plus fee, skipping
/// time-locked UTXOs. `now_ms` is the wall clock for the time-lock check.
pub fn plan_inputs(unspent: &[StoredUtxo], request: &SendRequest, now_ms: u64) -> Result<InputPlan> {
    let amount = amount::parse(&request.amount)?;
    let fee = amount::parse(&request.fee)?;
    let target = amount
        .checked_add(&fee)
        .ok_or_else(|| anyhow!("amount plus fee overflows"))?;

    let mut candidates: Vec<&StoredUtxo> = unspent
        .iter()
        .filter(|u| u.release_date_ms.is_none_or(|release| release <= now_ms))
        .collect();
    candidates.sort_by_key(|u| u.recovery.aocl_index);

    let mut chosen = Vec::new();
    let mut total = NativeCurrencyAmount::zero();
    for utxo in candidates {
        if total >= target {
            break;
        }
        total = total
            .checked_add(&utxo.recovery.utxo.get_native_currency_amount())
            .ok_or_else(|| anyhow!("input sum overflows"))?;
        chosen.push(utxo.clone());
    }
    if total < target {
        bail!(
            "insufficient funds: {} available, {} needed",
            amount::format(total),
            amount::format(target)
        );
    }

    let absolute_index_sets = chosen
        .iter()
        .map(|u| u.absolute_index_set().into())
        .collect();
    Ok(InputPlan {
        inputs: chosen,
        absolute_index_sets,
        total_in_nau: amount::to_nau_string(total),
    })
}

/// Build the transaction details and primitive witness for a send.
///
/// `snapshot` must be the node's answer to the membership-proof request from
/// `plan_inputs`, and `tip_header` the tip it was synced to.
pub fn build_send(
    account: &mut Account,
    inputs: &[StoredUtxo],
    snapshot: RpcMsMembershipSnapshot,
    tip_header: RpcBlockHeader,
    request: &SendRequest,
    now_ms: u64,
) -> Result<SendPlan> {
    let network = account.network();
    let recipient = account.parse_address(&request.recipient)?;
    let amount = amount::parse(&request.amount)?;
    let fee = amount::parse(&request.fee)?;

    let tip_header: BlockHeader = tip_header.into();
    let synced_height: u64 = snapshot.synced_height.value();
    let synced_hash = snapshot.synced_hash;
    let tip_height: u64 = tip_header.height.into();
    if synced_height != tip_height {
        bail!("membership proofs are for height {synced_height} but the tip is {tip_height}; retry");
    }
    if snapshot.membership_proofs.len() != inputs.len() {
        bail!(
            "node returned {} membership proofs for {} inputs",
            snapshot.membership_proofs.len(),
            inputs.len()
        );
    }

    // Unlock the inputs with their keys and membership proofs.
    let mut unlocked = Vec::with_capacity(inputs.len());
    for (proof_data, input) in snapshot.membership_proofs.into_iter().zip(inputs) {
        let recovery = &input.recovery;
        let membership_proof = proof_data
            .extract_ms_membership_proof(
                recovery.aocl_index,
                recovery.sender_randomness,
                recovery.receiver_preimage,
            )
            .ok_or_else(|| anyhow!("node returned a bad membership proof for {}", input.hash))?;
        let key = account.key(input.key_kind, input.key_index).clone();
        if key.lock_script_hash() != recovery.utxo.lock_script_hash() {
            bail!("input {} does not belong to {:?} key {}", input.hash, input.key_kind, input.key_index);
        }
        unlocked.push(UnlockedUtxo::unlock(
            recovery.utxo.clone(),
            key.lock_script_and_witness(),
            membership_proof,
        ));
    }
    let mutator_set = MutatorSetAccumulator::from(snapshot.synced_mutator_set);

    // Recipient output, announced on chain. Owned if it is one of our keys.
    let recipient_utxo = Utxo::new_native_currency(recipient.lock_script_hash(), amount);
    let owned = account
        .key_for_lock_script_hash(recipient_utxo.lock_script_hash())
        .is_some();
    let sender_randomness = account
        .entropy()
        .generate_sender_randomness(tip_header.height, recipient.privacy_digest());
    let mut outputs: Vec<TxOutput> = vec![TxOutput::new(
        recipient_utxo,
        sender_randomness,
        recipient.privacy_digest(),
        UtxoNotificationMethod::OnChain(recipient.clone()),
        owned,
        false,
    )];

    // Change back to our first generation key, announced on chain so the
    // ordinary scan finds it and no expected-UTXO bookkeeping is needed.
    let total_in: NativeCurrencyAmount = unlocked
        .iter()
        .map(|u| u.utxo.get_native_currency_amount())
        .sum();
    let total_out = amount
        .checked_add(&fee)
        .ok_or_else(|| anyhow!("amount plus fee overflows"))?;
    if total_in < total_out {
        bail!("inputs cover {} but {} is needed", amount::format(total_in), amount::format(total_out));
    }
    let change_amount = total_in
        .checked_sub(&total_out)
        .ok_or_else(|| anyhow!("change underflow"))?;
    let change_nau = if change_amount.is_positive() {
        let change_address = account.key(KeyKind::Generation, 0).to_address();
        let change_randomness = account
            .entropy()
            .generate_sender_randomness(tip_header.height, change_address.privacy_digest());
        outputs.push(TxOutput::onchain_native_currency(
            change_amount,
            change_randomness,
            change_address,
            true,
        ));
        Some(amount::to_nau_string(change_amount))
    } else {
        None
    };

    let timestamp = Timestamp::millis(now_ms);
    let mut details = TransactionDetails::new_without_coinbase(
        unlocked.clone(),
        TxOutputList::from(outputs),
        fee,
        timestamp,
        mutator_set,
        network,
    );

    let mut requires_lustration = false;
    if let Ok(status) = tip_header.pow.lustration_status() {
        let transparent: Vec<TransparentInput> = unlocked.into_iter().map(Into::into).collect();
        let lustrations = Announcement::lustration_announcements(status, &transparent);
        if !lustrations.is_empty() {
            requires_lustration = true;
            if !request.accept_lustration {
                bail!("this send requires lustration announcements; confirm to proceed");
            }
            details = details.with_announcements(lustrations);
        }
    }

    let witness = details.primitive_witness();
    let kernel = witness.kernel.clone();
    // The node identifies a transaction by its kernel MAST hash.
    let txid = kernel.mast_hash().to_hex();

    Ok(SendPlan {
        witness: bincode::serialize(&witness).context("encode witness")?,
        kernel: bincode::serialize(&kernel).context("encode kernel")?,
        summary: SendSummary {
            txid,
            input_hashes: inputs.iter().map(|u| u.hash.clone()).collect(),
            amount_nau: amount::to_nau_string(amount),
            fee_nau: amount::to_nau_string(fee),
            change_nau,
            timestamp_ms: now_ms,
            built_against_height: tip_height,
            built_against_hash: synced_hash.to_hex(),
            requires_lustration,
        },
    })
}

/// A mock ProofCollection for networks whose nodes accept only mock proofs
/// (regtest). Real proofs are rejected there, so the prover is bypassed.
pub fn mock_proof_collection(witness: &[u8]) -> Result<Vec<u8>> {
    let witness: PrimitiveWitness = bincode::deserialize(witness).context("decode witness")?;
    let collection = ProofCollection::produce_mock(&witness, true);
    bincode::serialize(&collection).context("encode proof collection")
}

/// Combine the kernel from `build_send` with the proof collection from the
/// prover into the transaction to pass as the single positional parameter
/// of `wallet_submitTransaction`.
pub fn assemble_submission(kernel: &[u8], proof_collection: &[u8]) -> Result<RpcTransaction> {
    let kernel: TransactionKernel = bincode::deserialize(kernel).context("decode kernel")?;
    let proof: ProofCollection =
        bincode::deserialize(proof_collection).context("decode proof collection")?;
    let transaction = Transaction {
        kernel,
        proof: TransactionProof::ProofCollection(proof),
    };
    RpcTransaction::try_from(transaction).map_err(|e| anyhow!("transaction is not transferable: {e}"))
}
