//! What a light wallet can check about the blocks a node hands it.
//!
//! The wallet has no chain of its own, so it cannot validate a block the
//! way a node does. It can still refuse the cheap lies: blocks that are not
//! the ones asked for, blocks that do not follow the last one scanned, and
//! blocks nobody did the work for. A node that wants to show this wallet a
//! payment that never happened must then mine it, at a difficulty close to
//! the real network's, on top of the wallet's own last block.
//!
//! What stays out of reach: the block's proof, the mutator set, and whether
//! this is the heaviest chain. A node can still withhold blocks. The app
//! says so where it explains the node.

use anyhow::bail;
use anyhow::Result;
use neptune_consensus::block::block_header::BlockHeader;
use neptune_consensus::block::block_kernel::BlockKernel;
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_primitives::difficulty_control::Difficulty;
use neptune_primitives::network::Network;
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_wallet::tasm_lib::prelude::Digest;
use serde::Deserialize;
use serde::Serialize;

/// Marks a block that does not follow the wallet's last scanned block: the
/// chain was reorganised under the wallet, or the node is on another chain.
/// The app rolls back and tries again rather than reporting an error.
pub const NOT_LINKED: &str = "chain check: not linked";

/// What the app asked the node for, so the answer can be held against it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Expectation {
    /// First and last height requested, inclusive.
    pub from: u64,
    pub to: u64,
    /// Hash of the block at `from - 1` as the wallet knows it, or None when
    /// the wallet has no block below (its first scan, or a fast restore's
    /// single blocks).
    #[serde(default)]
    pub prev_hash: Option<String>,
    /// Output commitments of this wallet's pending sends, to be reported
    /// back when a block carries them.
    #[serde(default)]
    pub watch: Vec<String>,
}

/// Mainnet difficulty has not been below 3.3e12 since block 9,000 (sampled
/// every 500 blocks up to 54,000; it was 2.7e13 there). A block from that
/// height on claiming less than 1e11 was not mined by the network: that
/// would take a fall in hash rate of more than thirty times below the
/// lowest on record. Below that height the chain was young, and only the
/// protocol's own minimum applies.
const MAIN_FLOOR_FROM_HEIGHT: u64 = 10_000;
const MAIN_FLOOR: Difficulty = Difficulty::new([1_215_752_192, 23, 0, 0, 0]); // 100,000,000,000

fn difficulty_floor(network: Network, height: u64) -> Difficulty {
    if network == Network::Main && height >= MAIN_FLOOR_FROM_HEIGHT {
        MAIN_FLOOR
    } else {
        Difficulty::MINIMUM
    }
}

/// Whether proof of work is checked at all: only where blocks are really
/// mined. Regtest mocks it and the test networks reset their difficulty.
fn checks_pow(network: Network) -> bool {
    network == Network::Main
}

/// Hold the node's answer against what was asked. `blocks` pairs each
/// block's locally computed hash with its kernel.
pub fn check(network: Network, blocks: &[(Digest, BlockKernel)], expect: &Expectation) -> Result<()> {
    let mut parent: Option<(Digest, &BlockHeader)> = None;
    for (i, (hash, kernel)) in blocks.iter().enumerate() {
        let header = &kernel.header;
        let height: u64 = header.height.into();
        let wanted = expect.from + i as u64;
        if height != wanted || height > expect.to {
            bail!("chain check: the node answered with block {height} where block {wanted} was asked for (up to {})", expect.to);
        }

        match parent {
            Some((parent_hash, _)) => {
                if header.prev_block_digest != parent_hash {
                    bail!("chain check: block {height} does not follow block {} of the same answer", height - 1);
                }
            }
            None => {
                if let Some(prev) = &expect.prev_hash {
                    if header.prev_block_digest.to_hex() != *prev {
                        bail!("{NOT_LINKED}: block {height} does not follow the last block scanned");
                    }
                }
            }
        }

        if checks_pow(network) {
            if header.difficulty < difficulty_floor(network, height) {
                bail!("chain check: block {height} claims a difficulty of {}, below anything the network has mined at that height", header.difficulty);
            }
            // Which difficulty the hash must meet depends on the rules in
            // force: the block's own since the Beta fork, its parent's
            // before. A parent outside this answer is not known here, and
            // its difficulty can differ from the block's own by a few per
            // cent, so such a block is held to the floor alone.
            let rules = ConsensusRuleSet::infer_from(network, header.height);
            let governing = if rules.use_parent_difficulty() {
                parent.map(|(_, p)| p.difficulty)
            } else {
                Some(header.difficulty)
            };
            if let Some(difficulty) = governing {
                if difficulty < Difficulty::MINIMUM || *hash > difficulty.target() {
                    bail!("chain check: block {height} does not carry the proof of work its difficulty requires");
                }
            }
        }

        parent = Some((*hash, header));
    }
    Ok(())
}

/// For tests and for the scan: hashes and kernels of a node's answer.
pub fn hashed(blocks: Vec<RpcWalletBlock>) -> Vec<(Digest, BlockKernel)> {
    blocks
        .into_iter()
        .map(|b| {
            let hash = b.hash();
            (hash, b.kernel.into())
        })
        .collect()
}
