//! The ledger's operations by name, as the app asks for them.
//!
//! One tagged value per call, `{ "op": "persistScan", ... }`, rather than a
//! method per operation: the wasm surface, the native shell and the app's
//! types all name the same list, and a new operation is one entry here and
//! one in the app. Whichever host runs this applies the returned changes
//! only once they are written down, one operation at a time per wallet.

use std::collections::BTreeSet;

use anyhow::anyhow;
use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;

use super::*;
use crate::account::Account;
use crate::chain::Expectation;
use crate::scan;
use crate::scan::ScanResult;

/// A JSON-RPC response as the node sends it; only `result` matters here.
#[derive(Deserialize)]
struct Envelope<T> {
    result: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    // Reading.
    UnspentHashes,
    Spendable { now: u64 },
    ForkCandidates { below: i64 },
    RollbackFloor,
    /// The index request of the keys the wallet watches, as JSON text: the
    /// identifiers are 64-bit values a JavaScript number cannot hold.
    AnnouncementFlags,
    /// The absolute index sets of the unspent coins, as JSON text.
    AbsoluteIndexSets,

    // Scanning, with the wallet's keys, against the wallet as it is.
    ScanBlocks { blocks_response: String, from: u64, to: u64, prev_hash: Option<String> },
    ScanMempoolKernel { kernel_response: String },

    // The sync.
    StartPass { tip_height: u64 },
    RollBack { height: i64, hash: Option<String>, now: u64 },
    PersistScan { result: ScanResult, keep_blocks: Option<u64>, now: u64 },
    FinishFastRestore { handover: i64, lowest: u64, now: u64 },
    ResetForRescan { height: u64, fast: bool },

    // Sends.
    RecordPending { entry: Value },
    DiscardPending { txid: String },
    ForgetSend { txid: String },

    // The mempool.
    RecordOutgoing { row: Value },
    RecordIncoming { row: Value },
    DropRow { key: String },
    ExpireRow { key: String },
    MarkMempoolChecked { asked: Vec<String>, present: Vec<String>, at: u64 },
}

impl Op {
    /// Whether this operation needs the wallet's keys, which live apart from
    /// its data and only while it is unlocked.
    pub fn needs_keys(&self) -> bool {
        matches!(self, Op::AnnouncementFlags | Op::ScanBlocks { .. } | Op::ScanMempoolKernel { .. })
    }
}

fn read<T: serde::Serialize>(value: T) -> Result<Outcome<Value>> {
    Ok(Outcome { changes: Vec::new(), value: serde_json::to_value(value).context("ledger: cannot write the answer")? })
}

fn wrote(outcome: Outcome) -> Result<Outcome<Value>> {
    Ok(Outcome { changes: outcome.changes, value: Value::Null })
}

fn said(outcome: Outcome<bool>) -> Result<Outcome<Value>> {
    Ok(Outcome { changes: outcome.changes, value: json!(outcome.value) })
}

/// Run one operation against a wallet as it is. `keys` is the unlocked
/// wallet's account, for the operations that need it.
pub fn run(state: &WalletState, wallet_id: &str, op: Op, keys: Option<&mut Account>) -> Result<Outcome<Value>> {
    let keys_needed = || anyhow!("wallet is locked");
    match op {
        Op::UnspentHashes => read(unspent(state)?.into_iter().map(|u| u.hash).collect::<Vec<_>>()),
        Op::Spendable { now } => read(spendable(state, now)),
        Op::ForkCandidates { below } => read(fork_candidates(state, below)),
        Op::RollbackFloor => read(rollback_floor(state)?),
        Op::AnnouncementFlags => {
            let flags = scan::announcement_flags(keys.ok_or_else(keys_needed)?, &next_key_indices(state)?);
            read(serde_json::to_string(&flags).context("ledger: cannot write the flags")?)
        }
        Op::AbsoluteIndexSets => {
            let sets = scan::absolute_index_sets(&unspent(state)?);
            read(serde_json::to_string(&sets).context("ledger: cannot write the index sets")?)
        }

        Op::ScanBlocks { blocks_response, from, to, prev_hash } => {
            let account = keys.ok_or_else(keys_needed)?;
            let blocks = serde_json::from_str::<Envelope<neptune_rpc_api::model::message::GetBlocksResponse>>(&blocks_response)
                .context("cannot decode blocks")?
                .result
                .blocks;
            let expectation = Expectation { from, to, prev_hash, watch: watched_commitments(state) };
            let result = scan::scan_blocks(account, blocks, unspent(state)?, next_key_indices(state)?, &expectation)?;
            read(result)
        }
        Op::ScanMempoolKernel { kernel_response } => {
            let account = keys.ok_or_else(keys_needed)?;
            let kernel = serde_json::from_str::<Envelope<neptune_rpc_api::model::message::GetTransactionKernelResponse>>(&kernel_response)
                .context("cannot decode mempool kernel")?
                .result
                .kernel;
            let found = match kernel {
                None => scan::MempoolScan::default(),
                Some(kernel) => {
                    let kernel: neptune_consensus::transaction::transaction_kernel::TransactionKernel = kernel.into();
                    // The core recognises this seed's own outputs against the
                    // tip it last synced to; the window inside is generous.
                    let tip = synced_tip(state).max(0) as u64;
                    scan::scan_mempool_kernel(account, &kernel, &unspent(state)?, next_key_indices(state)?, tip)
                }
            };
            read(found)
        }

        Op::StartPass { tip_height } => {
            let outcome = start_pass(state, tip_height)?;
            Ok(Outcome { changes: outcome.changes, value: serde_json::to_value(outcome.value)? })
        }
        Op::RollBack { height, hash, now } => wrote(roll_back(state, wallet_id, height, hash, now)),
        Op::PersistScan { result, keep_blocks, now } => {
            wrote(persist_scan(state, wallet_id, &result.blocks, result.next_key_indices, keep_blocks.unwrap_or(KEEP_BLOCKS), now)?)
        }
        Op::FinishFastRestore { handover, lowest, now } => wrote(finish_fast_restore(state, wallet_id, handover, lowest, now)?),
        Op::ResetForRescan { height, fast } => wrote(reset_for_rescan(state, height, fast)?),

        Op::RecordPending { entry } => wrote(record_pending(state, history_entry(entry)?)),
        Op::DiscardPending { txid } => wrote(discard_pending(state, wallet_id, &txid)),
        Op::ForgetSend { txid } => wrote(forget_send(state, wallet_id, &txid)),

        Op::RecordOutgoing { row } => said(record_outgoing(state, history_entry(row)?)),
        Op::RecordIncoming { row } => said(record_incoming(state, history_entry(row)?)),
        Op::DropRow { key } => wrote(drop_row(state, &key)),
        Op::ExpireRow { key } => wrote(expire_row(state, &key)),
        Op::MarkMempoolChecked { asked, present, at } => {
            let present: BTreeSet<String> = present.into_iter().collect();
            wrote(mark_mempool_checked(state, &asked, &present, at))
        }
    }
}

#[cfg(test)]
mod op_tests {
    use super::*;

    #[test]
    fn operations_are_named_as_the_app_names_them() {
        let op: Op = serde_json::from_value(json!({ "op": "markMempoolChecked", "asked": ["k"], "present": [], "at": 5 })).unwrap();
        assert!(matches!(op, Op::MarkMempoolChecked { at: 5, .. }));
        let op: Op = serde_json::from_value(json!({ "op": "scanBlocks", "blocksResponse": "{}", "from": 1, "to": 2, "prevHash": null })).unwrap();
        assert!(op.needs_keys());
        let op: Op = serde_json::from_value(json!({ "op": "startPass", "tipHeight": 9 })).unwrap();
        assert!(!op.needs_keys());
    }

    #[test]
    fn a_keyed_operation_without_keys_is_the_wallet_being_locked() {
        let state = WalletState::default();
        let error = run(&state, "w", Op::AnnouncementFlags, None).unwrap_err().to_string();
        assert_eq!(error, "wallet is locked");
    }

    #[test]
    fn a_read_changes_nothing_and_a_write_says_what_it_changes() {
        let state = WalletState {
            scan: Some(ScanState { birthday_height: 0, next_key_indices: FRESH_KEY_INDICES, restore: None, restored_at: None }),
            ..Default::default()
        };
        assert!(run(&state, "w", Op::Spendable { now: 0 }, None).unwrap().changes.is_empty());
        let outcome = run(&state, "w", Op::StartPass { tip_height: 77 }, None).unwrap();
        assert_eq!(outcome.changes.len(), 1);
        assert_eq!(outcome.value, json!({ "syncedHeight": 76, "syncedHash": null }));
    }
}
