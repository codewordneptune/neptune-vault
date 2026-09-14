//! Native end-to-end check for the pre-fork prover: prove a ProofCollection
//! with claim version 5 and verify it with the 0.15 consensus verifier, as
//! a mainnet node does before block 55,000.
//!
//!   cargo test --release -p vault-prover-legacy -- --ignored

use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transaction_proof::TransactionProof;
use neptune_primitives::mast_hash::MastHash;
use neptune_primitives::network::Network;
use proptest::strategy::Strategy;
use proptest::strategy::ValueTree;
use proptest::test_runner::TestRunner;
use vault_prover_legacy::prove_proof_collection;
use vault_prover_legacy::LdeTrace;
use vault_prover_legacy::ProgressEvent;

#[tokio::test]
#[ignore = "proves a full ProofCollection, takes minutes"]
async fn one_input_proof_collection_verifies_under_gamma() {
    let mut runner = TestRunner::deterministic();
    let witness = PrimitiveWitness::arbitrary_with_size_numbers(Some(1), 2, 0)
        .new_tree(&mut runner)
        .unwrap()
        .current();
    let rule_set = ConsensusRuleSet::HardforkGamma;

    let mut events = vec![];
    let collection = prove_proof_collection(&witness, rule_set, LdeTrace::NoCache, false, &mut |e| {
        if let ProgressEvent::Finished { name, millis, .. } = &e {
            eprintln!("{name}: {:.1} s", millis / 1000.0);
        }
        events.push(e);
    })
    .expect("proving succeeds");

    assert_eq!(events.len(), 2 * vault_prover_legacy::num_sub_proofs(&witness));

    let kernel_mast_hash = witness.kernel.mast_hash();
    let proof = TransactionProof::ProofCollection(collection);
    assert!(
        proof.verify(kernel_mast_hash, Network::Main, rule_set).await,
        "the pre-fork verifier must accept the legacy prover's output"
    );
}

#[test]
fn gamma_claims_carry_version_5() {
    assert_eq!(vault_prover_legacy::claim_version(ConsensusRuleSet::HardforkGamma), 5);
}
