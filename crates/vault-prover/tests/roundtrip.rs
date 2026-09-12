//! Native end-to-end check: prove a ProofCollection with vault-prover and
//! verify it with the consensus crate's own verifier, as a node would.
//!
//! Proving takes minutes, so the test is ignored by default:
//!
//!   cargo test --release -p vault-prover -- --ignored

use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transaction_proof::TransactionProof;
use neptune_primitives::mast_hash::MastHash;
use neptune_primitives::network::Network;
use proptest::strategy::Strategy;
use proptest::strategy::ValueTree;
use proptest::test_runner::TestRunner;
use vault_prover::prove_proof_collection;
use vault_prover::LdeTrace;
use vault_prover::ProgressEvent;

#[tokio::test]
#[ignore = "proves a full ProofCollection, takes minutes"]
async fn one_input_proof_collection_verifies_under_delta() {
    let mut runner = TestRunner::deterministic();
    let witness = PrimitiveWitness::arbitrary_with_size_numbers(Some(1), 2, 0)
        .new_tree(&mut runner)
        .unwrap()
        .current();
    let rule_set = ConsensusRuleSet::HardforkDelta;

    let mut events = vec![];
    let collection = prove_proof_collection(&witness, rule_set, LdeTrace::NoCache, &mut |e| {
        if let ProgressEvent::Finished { name, millis, .. } = &e {
            eprintln!("{name}: {:.1} s", millis / 1000.0);
        }
        events.push(e);
    })
    .expect("proving succeeds");

    assert_eq!(events.len(), 2 * vault_prover::num_sub_proofs(&witness));

    let kernel_mast_hash = witness.kernel.mast_hash();
    let proof = TransactionProof::ProofCollection(collection);
    assert!(
        proof.verify(kernel_mast_hash, Network::Main, rule_set).await,
        "the node's verifier must accept the browser prover's output"
    );
}

#[test]
fn delta_claims_carry_version_8() {
    assert_eq!(vault_prover::claim_version(ConsensusRuleSet::HardforkDelta), 8);
    assert_eq!(vault_prover::claim_version(ConsensusRuleSet::HardforkGamma), 5);
}
