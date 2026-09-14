//! ProofCollection assembly for the pre-fork rule sets (claim versions 0, 1
//! and 5), one Triton VM 7 proof at a time. A copy of vault-prover's
//! collection module against the 0.15 consensus crate; the only difference
//! is that every claim here uses the legacy proof system, so there is no
//! version check before proving.

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
        millis: f64,
        proof_len: usize,
        profile: Option<String>,
    },
}

/// The version the claims of a transaction carry under `rule_set`.
pub fn claim_version(rule_set: ConsensusRuleSet) -> u32 {
    match rule_set.triton_proof_version() {
        TritonProofVersion::V0 => 0,
        TritonProofVersion::V1 => 1,
        TritonProofVersion::V5 => 5,
    }
}

/// Number of Triton VM proofs a ProofCollection for this witness needs.
pub fn num_sub_proofs(witness: &PrimitiveWitness) -> usize {
    4 + witness.lock_scripts_and_witnesses.len() + witness.type_scripts_and_witnesses.len()
}

fn produce(program: Program, claim: Claim, nondeterminism: NonDeterminism) -> Result<Proof> {
    let proof = triton_vm::prove(Stark::default(), &claim, program, nondeterminism)
        .context("triton-vm proving failed")?;
    Ok(proof.into())
}

/// How Triton VM handles the low-degree-extended trace while proving.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LdeTrace {
    Cache,
    NoCache,
}

/// Prove every claim of a ProofCollection for `witness` under `rule_set`.
pub fn prove_proof_collection(
    witness: &PrimitiveWitness,
    rule_set: ConsensusRuleSet,
    lde_trace: LdeTrace,
    profile: bool,
    progress: &mut dyn FnMut(ProgressEvent),
) -> Result<ProofCollection> {
    triton_vm::config::overwrite_lde_trace_caching_to(match lde_trace {
        LdeTrace::Cache => triton_vm::config::CacheDecision::Cache,
        LdeTrace::NoCache => triton_vm::config::CacheDecision::NoCache,
    });

    let proof_version = claim_version(rule_set);
    let total = num_sub_proofs(witness);
    let mut index = 0usize;

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
        if profile {
            triton_vm::profiler::start(name);
        }
        let proof = produce(program, claim, nondeterminism)
            .with_context(|| format!("while proving {name}"))?;
        let report = profile.then(|| triton_vm::profiler::finish().to_string());
        progress(ProgressEvent::Finished {
            name: name.to_string(),
            index,
            total,
            millis: start.elapsed().as_secs_f64() * 1000.0,
            proof_len: proof.0.len(),
            profile: report,
        });
        index += 1;
        Ok(proof)
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

    Ok(ProofCollection {
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
    })
}
