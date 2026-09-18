//! The chain checks, held against real mainnet blocks from four eras of
//! the chain (fetched with `wallet_getBlocks` from a public node): before
//! the first fork, under the parent-difficulty rules, and after the forks
//! that made the block's own difficulty govern.

use neptune_primitives::network::Network;
use neptune_rpc_api::model::message::GetBlocksResponse;
use serde::Deserialize;
use vault_core::chain;
use vault_core::chain::Expectation;

#[derive(Deserialize)]
struct Envelope {
    result: GetBlocksResponse,
}

fn load(name: &str) -> Vec<(neptune_wallet::tasm_lib::prelude::Digest, neptune_consensus::block::block_kernel::BlockKernel)> {
    let text = std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let envelope: Envelope = serde_json::from_str(&text).unwrap();
    chain::hashed(envelope.result.blocks)
}

fn expect(from: u64, to: u64) -> Expectation {
    Expectation { from, to, prev_hash: None, watch: vec![] }
}

#[test]
fn real_blocks_from_every_era_pass() {
    for (name, from, to) in [
        ("blocks-1-3.json", 1, 3),
        ("blocks-12000-12001.json", 12_000, 12_001),
        ("blocks-30000-30001.json", 30_000, 30_001),
        ("blocks-54000-54001.json", 54_000, 54_001),
    ] {
        let blocks = load(name);
        assert_eq!(blocks.len() as u64, to - from + 1, "{name}");
        chain::check(Network::Main, &blocks, &expect(from, to)).unwrap_or_else(|e| panic!("{name}: {e}"));
        // The first block links to a parent the wallet names.
        let parent = blocks[0].1.header.prev_block_digest.to_hex();
        let linked = Expectation { prev_hash: Some(parent), ..expect(from, to) };
        chain::check(Network::Main, &blocks, &linked).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

#[test]
fn an_answer_that_is_not_what_was_asked_for_is_refused() {
    let blocks = load("blocks-54000-54001.json");
    // Other heights than the ones requested.
    assert!(chain::check(Network::Main, &blocks, &expect(54_001, 54_002)).is_err());
    // More than was requested.
    assert!(chain::check(Network::Main, &blocks, &expect(54_000, 54_000)).is_err());
    // Out of order.
    let swapped = vec![blocks[1].clone(), blocks[0].clone()];
    assert!(chain::check(Network::Main, &swapped, &expect(54_000, 54_001)).is_err());
}

#[test]
fn a_block_that_does_not_follow_the_last_one_scanned_says_so() {
    let blocks = load("blocks-54000-54001.json");
    let elsewhere = Expectation { prev_hash: Some("00".repeat(40)), ..expect(54_000, 54_001) };
    let error = chain::check(Network::Main, &blocks, &elsewhere).unwrap_err().to_string();
    assert!(error.starts_with(chain::NOT_LINKED), "{error}");
}

#[test]
fn a_block_nobody_mined_is_refused() {
    // Any change to the kernel changes the hash, and a fresh hash meets a
    // mainnet target about once in 10^13 tries.
    let mut blocks = load("blocks-54000-54001.json");
    blocks[1].1.header.timestamp = blocks[1].1.header.timestamp + neptune_primitives::timestamp::Timestamp::seconds(1);
    let rehashed: Vec<_> = blocks
        .iter()
        .map(|(hash, kernel)| (*hash, kernel.clone()))
        .collect();
    // The stale hash no longer belongs to the kernel, but the check works on
    // what it is given; forge the pair the way a node would have to.
    let mut forged = rehashed;
    forged[1].0 = neptune_wallet::tasm_lib::prelude::Digest::new([neptune_wallet::twenty_first::prelude::BFieldElement::new(u64::MAX - 1); 5]);
    let error = chain::check(Network::Main, &forged, &expect(54_000, 54_001)).unwrap_err().to_string();
    assert!(error.contains("proof of work"), "{error}");
}

#[test]
fn a_difficulty_the_network_never_had_is_refused() {
    let mut blocks = load("blocks-54000-54001.json");
    blocks[0].1.header.difficulty = neptune_primitives::difficulty_control::Difficulty::MINIMUM;
    let error = chain::check(Network::Main, &blocks, &expect(54_000, 54_001)).unwrap_err().to_string();
    assert!(error.contains("difficulty"), "{error}");
}

#[test]
fn other_networks_are_checked_for_order_and_linkage_only() {
    let mut blocks = load("blocks-54000-54001.json");
    blocks[0].1.header.difficulty = neptune_primitives::difficulty_control::Difficulty::MINIMUM;
    chain::check(Network::RegTest, &blocks, &expect(54_000, 54_001)).unwrap();
    assert!(chain::check(Network::RegTest, &blocks, &expect(1, 2)).is_err());
}
