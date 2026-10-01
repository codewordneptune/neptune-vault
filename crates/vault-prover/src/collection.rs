//! ProofCollection assembly, one Triton VM proof at a time.
//!
//! Mirrors `ProofCollection::produce` in neptune-consensus but calls the
//! prover directly instead of going through the node's job queue, which does
//! not exist in the browser. Ported from the desktop wallet's prover.

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use itertools::Itertools;
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_consensus::consensus_rule_set::TritonProofVersion;
use neptune_consensus::proof_abstractions::SecretWitness;
use neptune_consensus::tasm_lib::prelude::Tip5;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transaction_kernel::TransactionKernelField;
use neptune_consensus::transaction::validity::collect_lock_scripts::CollectLockScriptsWitness;
use neptune_consensus::transaction::validity::collect_type_scripts::CollectTypeScriptsWitness;
use neptune_consensus::transaction::validity::kernel_to_outputs::KernelToOutputsWitness;
use neptune_consensus::transaction::validity::neptune_proof::Proof;
use neptune_consensus::transaction::validity::proof_collection::ProofCollection;
use neptune_consensus::transaction::validity::removal_records_integrity::RemovalRecordsIntegrityWitness;
use neptune_consensus::triton_vm::prelude::*;
use neptune_consensus::triton_vm::proof::Proof as VmProof;
use neptune_consensus::triton_vm::proof_stream::ProofStream;
use neptune_primitives::mast_hash::MastHash;
use serde::Serialize;
use web_time::Instant;

/// What the prover is doing, reported before and after every sub-proof.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgressEvent {
    Started {
        name: String,
        index: usize,
        total: usize,
    },
    Finished {
        name: String,
        index: usize,
        total: usize,
        /// The whole step: proving plus the check of the proof.
        millis: f64,
        /// The check alone, see `check`.
        check_millis: f64,
        proof_len: usize,
        /// Triton VM's per-phase profile, when profiling was requested and
        /// the build has the profiler compiled in.
        profile: Option<String>,
    },
}

/// The version the claims of a transaction carry under `rule_set`.
///
/// Nodes stamp this version onto every claim they verify, so a proof about any
/// other version is rejected. Mirrors `TritonProofVersion::version`, which
/// neptune-consensus keeps crate-private.
pub fn claim_version(rule_set: ConsensusRuleSet) -> u32 {
    match rule_set.triton_proof_version() {
        TritonProofVersion::V0 => 0,
        TritonProofVersion::V1 => 1,
        TritonProofVersion::V5 => 5,
        TritonProofVersion::V8 => 8,
    }
}

/// Number of Triton VM proofs a ProofCollection for this witness needs.
pub fn num_sub_proofs(witness: &PrimitiveWitness) -> usize {
    4 + witness.lock_scripts_and_witnesses.len() + witness.type_scripts_and_witnesses.len()
}

/// Prove one claim.
///
/// Only the post-delta proof system (claim version 8) is shipped. Claims for
/// earlier rule sets need the legacy Triton VM, which neither Neptune Vault
/// nor neptune-core 0.19 carries.
fn produce(program: Program, claim: &Claim, nondeterminism: NonDeterminism) -> Result<VmProof> {
    if claim.version < triton_vm::proof::CURRENT_VERSION {
        bail!(
            "claim version {} needs the pre-delta prover, which Neptune Vault does not ship",
            claim.version
        );
    }
    triton_vm::prove(Stark::default(), claim, program, nondeterminism)
        .context("triton-vm proving failed")
}

/// Check a fresh proof the way a node checks it on arrival: the number of
/// proof items, which nodes require to be exact, then Triton VM's verifier.
/// Mirrors `verify_transaction_proof` in neptune-consensus, which is not
/// public and runs on tokio.
///
/// A proof that fails is never sent. Without this, a faulty proof, from a
/// prover bug or a fault on the device, would show only as a send the node
/// refuses.
fn check(claim: &Claim, proof: &VmProof) -> Result<()> {
    // Mirrors `expected_num_proof_items` in neptune-consensus: sixteen items
    // outside FRI, four FRI items independent of the number of rounds, and
    // two per round.
    const NUM_ITEMS_OUTSIDE_FRI: usize = 16;
    const NUM_ROUND_INDEPENDENT_FRI_ITEMS: usize = 4;
    const NUM_FRI_ITEMS_PER_ROUND: usize = 2;

    let stark = Stark::default();
    let padded_height = proof
        .padded_height()
        .map_err(|e| anyhow!("its height cannot be read: {e}"))?;
    let num_fri_rounds = stark
        .fri(padded_height)
        .map_err(|e| anyhow!("no FRI parameters for its height: {e}"))?
        .num_rounds();
    let expected = NUM_ITEMS_OUTSIDE_FRI
        + NUM_ROUND_INDEPENDENT_FRI_ITEMS
        + NUM_FRI_ITEMS_PER_ROUND * num_fri_rounds;
    let found = ProofStream::try_from(proof)
        .map_err(|e| anyhow!("it cannot be decoded: {e}"))?
        .items
        .len();
    if found != expected {
        bail!("it holds {found} items, nodes accept only {expected}");
    }
    if !triton_vm::verify(stark, claim, proof) {
        bail!("it does not verify");
    }
    Ok(())
}

/// How Triton VM handles the low-degree-extended trace while proving.
///
/// Caching it is faster but costs roughly 40 KB per trace row, which is
/// several GB for the largest sub-proofs. Recomputing (`NoCache`) trades time
/// for memory, which is what a phone needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LdeTrace {
    Cache,
    NoCache,
}

/// Prove every claim of a ProofCollection for `witness` under `rule_set`.
///
/// `progress` is called before and after each sub-proof. Sub-proofs run
/// strictly one after another so peak memory is one proof's worth.
pub fn prove_proof_collection(
    witness: &PrimitiveWitness,
    rule_set: ConsensusRuleSet,
    lde_trace: LdeTrace,
    profile: bool,
    progress: &mut dyn FnMut(ProgressEvent),
) -> Result<ProofCollection> {
    // The setting is thread-local, so it must be made on the proving thread.
    triton_vm::config::overwrite_lde_trace_caching_to(match lde_trace {
        LdeTrace::Cache => triton_vm::config::CacheDecision::Cache,
        LdeTrace::NoCache => triton_vm::config::CacheDecision::NoCache,
    });

    let proof_version = claim_version(rule_set);
    let total = num_sub_proofs(witness);
    let mut index = 0usize;
    // Every claim proved, in order, held against the node's own at the end.
    let mut proved: Vec<(String, Claim)> = Vec::with_capacity(total);

    let mut timed = |name: &str,
                     program: Program,
                     claim: Claim,
                     nondeterminism: NonDeterminism|
     -> Result<Proof> {
        progress(ProgressEvent::Started {
            name: name.to_string(),
            index,
            total,
        });
        let start = Instant::now();
        // Triton VM's profiler is a thread-local, so start and finish it
        // around the proof on this thread. It only records phases when the
        // crate is built with its profiler enabled (debug assertions on or
        // the `no_profile` feature off); otherwise the report is empty.
        if profile {
            triton_vm::profiler::start(name);
        }
        let proof = produce(program, &claim, nondeterminism)
            .with_context(|| format!("while proving {name}"))?;
        let report = profile.then(|| triton_vm::profiler::finish().to_string());
        let checking = Instant::now();
        check(&claim, &proof).map_err(|e| {
            anyhow!("Nothing was sent: a proof made on this device failed its check ({name}: {e}). Try again.")
        })?;
        progress(ProgressEvent::Finished {
            name: name.to_string(),
            index,
            total,
            millis: start.elapsed().as_secs_f64() * 1000.0,
            check_millis: checking.elapsed().as_secs_f64() * 1000.0,
            proof_len: proof.0.len(),
            profile: report,
        });
        index += 1;
        proved.push((name.to_string(), claim));
        Ok(proof.into())
    };

    let removal_records_integrity_witness = RemovalRecordsIntegrityWitness::from(witness);
    let collect_lock_scripts_witness = CollectLockScriptsWitness::from(witness);
    let kernel_to_outputs_witness = KernelToOutputsWitness::from(witness);
    let collect_type_scripts_witness = CollectTypeScriptsWitness::from(witness);

    let txk_mast_hash = witness.kernel.mast_hash();
    let txk_mast_hash_as_input = PublicInput::new(txk_mast_hash.reversed().values().to_vec());
    let salted_inputs_hash = Tip5::hash(&witness.input_utxos);
    let salted_outputs_hash = Tip5::hash(&witness.output_utxos);

    let removal_records_integrity = timed(
        "removal_records_integrity",
        removal_records_integrity_witness.program(),
        removal_records_integrity_witness
            .claim()
            .about_version(proof_version),
        removal_records_integrity_witness.nondeterminism(),
    )?;

    let collect_lock_scripts = timed(
        "collect_lock_scripts",
        collect_lock_scripts_witness.program(),
        collect_lock_scripts_witness
            .claim()
            .about_version(proof_version),
        collect_lock_scripts_witness.nondeterminism(),
    )?;

    let kernel_to_outputs = timed(
        "kernel_to_outputs",
        kernel_to_outputs_witness.program(),
        kernel_to_outputs_witness
            .claim()
            .about_version(proof_version),
        kernel_to_outputs_witness.nondeterminism(),
    )?;

    let collect_type_scripts = timed(
        "collect_type_scripts",
        collect_type_scripts_witness.program(),
        collect_type_scripts_witness
            .claim()
            .about_version(proof_version),
        collect_type_scripts_witness.nondeterminism(),
    )?;

    let mut lock_scripts_halt = vec![];
    for (i, lsaw) in witness.lock_scripts_and_witnesses.iter().enumerate() {
        let claim = Claim::new(lsaw.program.hash())
            .about_version(proof_version)
            .with_input(txk_mast_hash_as_input.clone().individual_tokens);
        lock_scripts_halt.push(timed(
            &format!("lock_script_{i}"),
            lsaw.program.clone(),
            claim,
            lsaw.nondeterminism(),
        )?);
    }

    let mut type_scripts_halt = vec![];
    for (i, tsaw) in witness.type_scripts_and_witnesses.iter().enumerate() {
        let input: Vec<_> = [txk_mast_hash, salted_inputs_hash, salted_outputs_hash]
            .into_iter()
            .flat_map(|d| d.reversed().values())
            .collect();
        let claim = Claim::new(tsaw.program.hash())
            .about_version(proof_version)
            .with_input(input);
        type_scripts_halt.push(timed(
            &format!("type_script_{i}"),
            tsaw.program.clone(),
            claim,
            tsaw.nondeterminism(),
        )?);
    }

    let lock_script_hashes = witness
        .lock_scripts_and_witnesses
        .iter()
        .map(|lsaw| lsaw.program.hash())
        .collect_vec();
    let type_script_hashes = witness
        .type_scripts_and_witnesses
        .iter()
        .map(|tsaw| tsaw.program.hash())
        .collect_vec();
    let merge_bit_mast_path = witness.kernel.mast_path(TransactionKernelField::MergeBit);

    let collection = ProofCollection {
        removal_records_integrity,
        collect_lock_scripts,
        lock_scripts_halt,
        kernel_to_outputs,
        collect_type_scripts,
        type_scripts_halt,
        lock_script_hashes,
        type_script_hashes,
        kernel_mast_hash: txk_mast_hash,
        salted_inputs_hash,
        salted_outputs_hash,
        merge_bit_mast_path,
    };

    // A node verifies each proof against a claim it derives from the
    // collection itself, so those must be the claims checked above, listed
    // here in proving order.
    let derived = [
        collection.removal_records_integrity_claim(rule_set),
        collection.collect_lock_scripts_claim(rule_set),
        collection.kernel_to_outputs_claim(rule_set),
        collection.collect_type_scripts_claim(rule_set),
    ]
    .into_iter()
    .chain(collection.lock_script_claims(rule_set))
    .chain(collection.type_script_claims(rule_set))
    .collect_vec();
    if derived.len() != proved.len() {
        bail!(
            "Nothing was sent: {} proofs were made where nodes check {}. This is a fault in this version of the app; please report it.",
            proved.len(),
            derived.len()
        );
    }
    if let Some(((name, _), _)) = proved
        .iter()
        .zip(&derived)
        .find(|((_, ours), theirs)| ours != *theirs)
    {
        bail!(
            "Nothing was sent: the proof of {name} is for a different claim than nodes check. This is a fault in this version of the app; please report it."
        );
    }

    Ok(collection)
}

#[cfg(test)]
mod tests {
    use neptune_consensus::triton_vm::proof_item::ProofItem;

    use super::*;

    /// A program that proves in milliseconds, its claim, and a proof of it.
    fn small_proof() -> (Program, Claim, VmProof) {
        let program = triton_program!(push 2 push 3 mul write_io 1 halt);
        let claim = Claim::about_program(&program).with_output(bfe_vec![6]);
        let proof = produce(program.clone(), &claim, NonDeterminism::default()).unwrap();
        (program, claim, proof)
    }

    #[test]
    fn check_accepts_an_honest_proof() {
        let (_, claim, proof) = small_proof();
        check(&claim, &proof).unwrap();
    }

    #[test]
    fn check_rejects_a_proof_of_another_claim() {
        let (_, claim, proof) = small_proof();
        let other = claim.with_output(bfe_vec![7]);
        assert!(check(&other, &proof).is_err());
    }

    #[test]
    fn check_rejects_a_proof_with_an_extra_item() {
        let (_, claim, proof) = small_proof();
        let stream = ProofStream::try_from(&proof).unwrap();

        // Caught by the count, before the verifier is run.
        let mut repeated = stream.clone();
        let last = repeated.items.last().unwrap().clone();
        repeated.items.push(last);
        let error = check(&claim, &VmProof::from(repeated)).unwrap_err().to_string();
        assert!(error.contains("items"), "{error}");

        // A second height makes the proof's height unreadable.
        let mut two_heights = stream;
        two_heights.items.push(ProofItem::Log2PaddedHeight(8));
        assert!(check(&claim, &VmProof::from(two_heights)).is_err());
    }

    #[test]
    fn claims_for_the_legacy_proof_system_are_refused() {
        let (program, claim, _) = small_proof();
        let legacy = claim.about_version(5);
        assert!(produce(program, &legacy, NonDeterminism::default()).is_err());
    }
}
