//! What the wallet does with what it learns: every change to its coins,
//! history and scan position, decided in one place.
//!
//! Three things write a wallet's coins: the sync, which finds them and sees
//! them spent; the mempool watcher, which holds them for spends it sees
//! coming; and a send, which holds them for itself. When each read a coin,
//! changed a field and wrote it back on its own, one could undo another:
//! a sync marked a coin spent and a stale copy written back afterwards made
//! it unspent again. Here every such step is one operation. It reads the
//! wallet as it is at that moment and returns the changes, and the wallet
//! worker applies each operation's changes in turn, never two at once.
//!
//! Nothing here fetches anything. The app asks the node and hands over the
//! answers; the decisions are made here, where they can be tested with
//! plain data. Each operation is a faithful port of the TypeScript it
//! replaces, so that the tests written against that TypeScript still hold
//! it to account. Records keep the app's shape, field for field, since the
//! app reads them as they are.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use neptune_consensus::block::block_kernel::BlockKernel;
use neptune_primitives::network::Network;
use neptune_wallet::tasm_lib::prelude::Digest;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use serde_json::Map;
use serde_json::Value;

use crate::chain;
use crate::chain::Weighed;
use crate::scan::NextKeyIndices;
use crate::scan::ScannedBlock;
use crate::scan::StoredUtxo;
use crate::store::Block;
use crate::store::HistoryEntry;
use crate::store::Model;
use crate::store::ScanState;
use crate::store::SyncState;
use crate::store::Utxo;
use crate::store::WalletChange;
use crate::store::WalletState;

/// The key counters of a wallet made or rescanned from scratch.
pub const FRESH_KEY_INDICES: NextKeyIndices = NextKeyIndices { generation: 1, ec_hybrid: 0, viewing: 0 };

/// How many recent blocks are kept to measure a reorganisation against.
pub const KEEP_BLOCKS: u64 = 1000;

/// The changes an operation makes, and what it has to say.
#[derive(Debug, Default)]
pub struct Outcome<T = ()> {
    pub changes: Vec<WalletChange>,
    pub value: T,
}

/// A working copy that sees its own writes, as a database transaction does:
/// the operations below read a coin after writing it and expect the new one.
struct Tx {
    work: WalletState,
    changes: Vec<WalletChange>,
}

impl Tx {
    fn new(state: &WalletState) -> Self {
        Tx { work: state.clone(), changes: Vec::new() }
    }

    fn push(&mut self, change: WalletChange) {
        self.work.apply(vec![change.clone()]);
        self.changes.push(change);
    }

    fn done<T>(self, value: T) -> Outcome<T> {
        Outcome { changes: self.changes, value }
    }
}

fn scan_of(state: &WalletState) -> Result<ScanState> {
    state.scan.clone().ok_or_else(|| anyhow!("store: this wallet has no scan state"))
}

fn record_key(wallet_id: &str, rest: &str) -> String {
    format!("{wallet_id}:{rest}")
}

fn owner(wallet_id: &str) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("accountId".into(), json!(wallet_id));
    extra
}

fn nau(text: &str) -> i128 {
    text.trim().parse().unwrap_or(0)
}

/// The commitments of a history entry's outputs.
/// The note `forget_send` leaves on a send the person gave up on.
const GAVE_UP: &str = "You gave up on this send.";

/// The note `expire_sends` leaves on a send no block took in time.
pub const EXPIRED: &str = "No block took it within three days, so its coins are spendable again.";

/// Why a pending send failed when a block carried another send of this
/// device that spends one of the same coins.
const LOST_TO_OWN: &str = "Not sent: another send of yours that spends the same coins went through instead.";

/// Why a pending send failed when one of its coins went in a transaction
/// this device did not build.
const LOST_ELSEWHERE: &str = "Not sent: its coins were spent by another transaction, made elsewhere with this seed phrase.";

/// How long a send can wait for a block. A block may not carry a
/// transaction stamped more than three days before its own timestamp
/// (consensus rule 2.f, from hardfork gamma on), and every later block is
/// timestamped later still. The hour on top is for a reorganisation that
/// swaps the newest block for one timestamped a little earlier.
pub const SEND_LIFETIME_MS: u64 = (3 * 24 + 1) * 60 * 60 * 1000;

/// Whether a row is a send the person gave up on, or one that expired: its
/// coins are free again, though the transaction may once have been out
/// there. Rows written before the mark was kept are told by the note.
pub(crate) fn given_up(entry: &HistoryEntry) -> bool {
    entry.kind == "sent"
        && entry.status == "failed"
        && (entry.extra.get("givenUp").and_then(Value::as_bool) == Some(true)
            || entry.extra.get("expired").and_then(Value::as_bool) == Some(true)
            || entry.extra.get("error").and_then(Value::as_str) == Some(GAVE_UP))
}

/// Whether a row is a send that expired: no block took it in time.
fn expired(entry: &HistoryEntry) -> bool {
    entry.extra.get("expired").and_then(Value::as_bool) == Some(true)
}

/// Whether a send went back to waiting because the block that confirmed it
/// was rolled back.
fn rolled_back(entry: &HistoryEntry) -> bool {
    entry.extra.get("rolledBack").and_then(Value::as_bool) == Some(true)
}

/// Whether a send given up on, or one that expired, can still go through:
/// none of its coins has been spent in a block. Its transaction stays
/// valid until then, so a block can still take it.
fn may_still_go(state: &WalletState, entry: &HistoryEntry) -> bool {
    given_up(entry) && !entry.input_hashes.iter().any(|h| state.utxos.get(h).is_some_and(|u| u.spent_height.is_some()))
}

/// A send this device built, as opposed to one the chain or the mempool
/// watcher wrote for a spend made elsewhere.
pub(crate) fn own_send(entry: &HistoryEntry) -> bool {
    entry.kind == "sent" && !entry.txid.is_empty() && entry.key.contains(":sent:")
}

/// The send given up on, still able to go through, whose inputs include this coin.
fn given_up_spending(state: &WalletState, hash: &str) -> Option<HistoryEntry> {
    state.history.values().find(|r| r.input_hashes.iter().any(|h| h == hash) && may_still_go(state, r)).cloned()
}

/// A send given up on that goes through after all: the same row again,
/// with its recipient and fee, no longer failed.
fn revived(entry: &HistoryEntry, status: &str, height: Option<u64>) -> HistoryEntry {
    let mut extra = entry.extra.clone();
    extra.insert("error".into(), Value::Null);
    extra.remove("givenUp");
    extra.remove("expired");
    HistoryEntry { status: status.into(), height, extra, ..entry.clone() }
}

fn outputs(entry: &HistoryEntry) -> Vec<String> {
    entry
        .extra
        .get("outputs")
        .and_then(Value::as_array)
        .map(|all| all.iter().filter_map(|o| o.get("commitment").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default()
}

fn sync_record(wallet_id: &str, height: i64, hash: Option<String>, now: u64) -> SyncState {
    SyncState { synced_height: height, synced_hash: hash, updated_at: now, extra: owner(wallet_id) }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The wallet's unspent coins, in the core's own representation.
pub fn unspent(state: &WalletState) -> Result<Vec<StoredUtxo>> {
    state
        .utxos
        .values()
        .filter(|u| u.spent_height.is_none())
        .map(|u| serde_json::from_value(u.stored.clone()).with_context(|| format!("store: coin {} is not readable", u.hash)))
        .collect()
}

/// Coins that can go into a send now: unspent, not held, and not time locked.
pub fn spendable(state: &WalletState, now: u64) -> Vec<Value> {
    state
        .utxos
        .values()
        .filter(|u| u.spent_height.is_none() && u.pending_txid.is_none() && u.release_date_ms.is_none_or(|r| r <= now))
        .map(|u| u.stored.clone())
        .collect()
}

/// Output commitments of the sends a block may still carry: the pending
/// ones, and this device's sends given up on or expired that can still go
/// through. A block that carries one has that send in it.
pub fn watched_commitments(state: &WalletState) -> Vec<String> {
    state
        .history
        .values()
        .filter(|h| h.kind == "sent" && (h.status == "pending" || (own_send(h) && may_still_go(state, h))))
        .flat_map(outputs)
        .collect()
}

/// The height the wallet has scanned to, or 0 before its first scan.
pub fn synced_tip(state: &WalletState) -> i64 {
    state.sync.as_ref().map_or(0, |s| s.synced_height)
}

pub fn next_key_indices(state: &WalletState) -> Result<NextKeyIndices> {
    Ok(scan_of(state)?.next_key_indices)
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

/// Where a pass begins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// Last height scanned, or the start height minus one before the first scan.
    pub synced_height: i64,
    /// The hash the next block must follow; none before the first scan.
    pub synced_hash: Option<String>,
}

/// Begin a pass against a node whose tip is at `tip_height`.
///
/// A wallet made while the node was unreachable has no start height yet:
/// it starts at `start_hint`, the block of its creation time less a margin,
/// which the app looks up, or at the tip seen now when there is none. A
/// start set above the chain (a typo at import, or a rescan aimed too far
/// ahead) would skip every block until the chain caught up, so it starts at
/// the tip. Only before the first scan: once the wallet has a position, a
/// node reporting a low tip must not rewrite where its history starts, and
/// one reporting a tip below that position is refused.
pub fn start_pass(state: &WalletState, tip_height: u64, start_hint: Option<u64>) -> Result<Outcome<Position>> {
    let mut scan = scan_of(state)?;
    let mut tx = Tx::new(state);
    if state.sync.is_none() && (scan.birthday_height == 0 || scan.birthday_height > tip_height) {
        scan.birthday_height = match start_hint {
            Some(hint) if scan.birthday_height == 0 && (1..=tip_height).contains(&hint) => hint,
            _ => tip_height,
        };
        tx.push(WalletChange::PutScan { scan: scan.clone() });
    }
    if let Some(sync) = &state.sync {
        if sync.synced_height > tip_height as i64 {
            bail!(
                "The node's chain ends at block {tip_height}, below block {} that this wallet has already scanned. The node may be out of date or on another chain; nothing was changed.",
                sync.synced_height
            );
        }
    }
    let position = match &state.sync {
        Some(sync) => Position { synced_height: sync.synced_height, synced_hash: sync.synced_hash.clone() },
        None => Position { synced_height: scan.birthday_height as i64 - 1, synced_hash: None },
    };
    Ok(tx.done(position))
}

/// The blocks a reorganisation is measured against: those kept below
/// `below`, oldest first, for the app to ask the node about.
pub fn fork_candidates(state: &WalletState, below: i64) -> Vec<(u64, String)> {
    state
        .blocks
        .values()
        .filter(|b| (b.height as i64) < below)
        .map(|b| (b.height, b.hash.clone()))
        .collect()
}

/// What a node's competing chain, shown so far, comes to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheck {
    /// The last block shown, to go on from; none when the answer had none.
    pub last: Option<Weighed>,
    /// Whether the chain shown holds more work than the blocks this wallet scanned.
    pub heavier: bool,
}

/// A kept block with the work it was kept with; none for one kept before blocks carried it.
fn weighed(block: &Block) -> Option<Weighed> {
    Some(Weighed {
        height: block.height,
        hash: block.hash.clone(),
        difficulty: serde_json::from_value(block.extra.get("difficulty")?.clone()).ok()?,
        cumulative_pow: serde_json::from_value(block.extra.get("cumulativePow")?.clone()).ok()?,
    })
}

/// Weigh a stretch of a node's competing chain, growing from the kept block
/// below `from`, or from `after`, the last block of the stretch before (see
/// `chain::weigh`). Nothing is written: a deep rollback waits until the
/// chain shown holds more work than the blocks this wallet scanned.
pub fn check_branch(
    state: &WalletState,
    network: Network,
    blocks: &[(Digest, BlockKernel)],
    from: u64,
    to: u64,
    after: Option<Weighed>,
) -> Result<BranchCheck> {
    let below = from.saturating_sub(1);
    let parent = match after {
        Some(after) => after,
        None => state.blocks.get(&below).and_then(weighed).ok_or_else(|| anyhow!("chain check: block {below} was not kept with its work"))?,
    };
    let last = chain::weigh(network, blocks, from, to, &parent)?;
    let ours = state.sync.as_ref().and_then(|s| u64::try_from(s.synced_height).ok()).and_then(|h| state.blocks.get(&h)).and_then(weighed);
    let heavier = matches!((&last, &ours), (Some(theirs), Some(ours)) if theirs.cumulative_pow > ours.cumulative_pow);
    Ok(BranchCheck { last, heavier })
}

/// Forget everything above `height`, including spends recorded above it.
/// Rows the chain produced go. A send this device built goes back to
/// pending and holds its coins again; one a block had confirmed is marked,
/// so that it is never taken for expired: it went through once, and the
/// chain that dropped it may be the node's word alone.
pub fn roll_back(state: &WalletState, wallet_id: &str, height: i64, hash: Option<String>, now: u64) -> Outcome {
    let mut tx = Tx::new(state);
    for u in state.utxos.values() {
        if u.confirmed_height as i64 > height {
            tx.push(WalletChange::DeleteUtxo { hash: u.hash.clone() });
        } else if u.spent_height.is_some_and(|s| s as i64 > height) {
            tx.push(WalletChange::PutUtxo { utxo: Utxo { spent_height: None, spent_txid: None, ..u.clone() } });
        }
    }
    tx.push(WalletChange::DeleteBlocksAbove { height });
    for h in state.history.values() {
        if h.height.is_some_and(|at| at as i64 > height) {
            if h.kind == "received" || h.txid.is_empty() {
                tx.push(WalletChange::DeleteHistory { key: h.key.clone() });
            } else {
                let mut extra = h.extra.clone();
                if h.status == "confirmed" {
                    extra.insert("rolledBack".into(), json!(true));
                } else {
                    extra.insert("error".into(), Value::Null);
                }
                tx.push(WalletChange::PutHistory { entry: HistoryEntry { status: "pending".into(), height: None, extra, ..h.clone() } });
                for input in &h.input_hashes {
                    set_hold(&mut tx, input, None, Some(&h.txid));
                }
            }
        }
    }
    tx.push(WalletChange::PutSync { sync: sync_record(wallet_id, height, hash, now) });
    tx.done(())
}

/// Write down what a scan found: new coins and their receipts, coins spent,
/// sends confirmed or failed, spends made elsewhere, the blocks, the new
/// position and the key counters.
pub fn persist_scan(
    state: &WalletState,
    wallet_id: &str,
    blocks: &[ScannedBlock],
    next_key_indices: NextKeyIndices,
    keep_blocks: u64,
    now: u64,
) -> Result<Outcome> {
    let mut tx = Tx::new(state);
    let Some(last) = blocks.last() else { return Ok(tx.done(())) };
    let scan = scan_of(state)?;

    // Coins held by this device's pending sends. A coin written afresh
    // (after a rollback removed it) is held again, or it would look
    // spendable while a transaction that spends it is still out there.
    let mut held_by: BTreeMap<String, String> = BTreeMap::new();
    for h in state.history.values() {
        if h.kind == "sent" && h.status == "pending" && !h.txid.is_empty() && !h.key.contains(":outgoing:") {
            for input in &h.input_hashes {
                held_by.insert(input.clone(), h.txid.clone());
            }
        }
    }

    for block in blocks {
        for u in &block.incoming {
            // The same block can be written twice: a fast restore looks
            // again at a block once it knows more coins. What is already
            // known about the coin (spent, or held) stays.
            let existing = tx.work.utxos.get(&u.hash).cloned();
            let mut extra = owner(wallet_id);
            extra.insert("key".into(), json!(record_key(wallet_id, &u.hash)));
            let utxo = Utxo {
                hash: u.hash.clone(),
                stored: serde_json::to_value(u).context("store: cannot write a coin")?,
                amount_nau: u.amount_nau.clone(),
                amount: u.amount.clone(),
                confirmed_height: u.confirmed_height,
                confirmed_timestamp_ms: u.confirmed_timestamp_ms,
                release_date_ms: u.release_date_ms,
                spent_height: existing.as_ref().and_then(|e| e.spent_height),
                spent_txid: existing.as_ref().and_then(|e| e.spent_txid.clone()),
                pending_txid: match &existing {
                    Some(e) => e.pending_txid.clone(),
                    None => held_by.get(&u.hash).cloned(),
                },
                extra,
            };
            tx.push(WalletChange::PutUtxo { utxo });

            let mut extra = owner(wallet_id);
            extra.insert("amountNau".into(), json!(u.amount_nau));
            extra.insert("feeNau".into(), Value::Null);
            extra.insert("recipient".into(), Value::Null);
            extra.insert("error".into(), Value::Null);
            extra.insert("releaseDateMs".into(), json!(u.release_date_ms));
            tx.push(WalletChange::PutHistory {
                entry: HistoryEntry {
                    key: record_key(wallet_id, &format!("recv:{}", u.hash)),
                    kind: "received".into(),
                    status: "confirmed".into(),
                    txid: String::new(),
                    timestamp_ms: u.confirmed_timestamp_ms,
                    height: Some(u.confirmed_height),
                    input_hashes: Vec::new(),
                    extra,
                },
            });
            // The same output was perhaps seen in the mempool first.
            if !u.commitment.is_empty() {
                tx.push(WalletChange::DeleteHistory { key: record_key(wallet_id, &format!("incoming:{}", u.commitment)) });
            }
        }

        // This device's sends in this block. A transaction a block takes
        // spends all its inputs there and puts all its outputs there, so a
        // send is in it when every coin of it this wallet knows is spent here
        // and the block carries every one of its outputs. Neither alone is
        // enough: another send of this device, or another device with the
        // same seed phrase, can spend the same coins, and two sends of this
        // device built at one height can share an output, since a payment of
        // one amount to one address then gets the same commitment. A send
        // given up on, or expired, goes through like any other while its
        // coins are unspent. Rows from before outputs were recorded keep the
        // old rule: a pending send whose held coin is spent went through; one
        // given up on cannot be told apart.
        let seen: BTreeSet<&str> = block.seen.iter().map(String::as_str).collect();
        let spent_here: BTreeSet<&str> = block.spent.iter().map(String::as_str).collect();
        let carried: Vec<HistoryEntry> = tx
            .work
            .history
            .values()
            .filter(|s| own_send(s) && (s.status == "pending" || given_up(s)))
            .filter(|s| {
                let recorded = outputs(s);
                if recorded.is_empty() {
                    s.status == "pending"
                        && s.input_hashes.iter().any(|h| {
                            spent_here.contains(h.as_str()) && tx.work.utxos.get(h).is_some_and(|c| c.pending_txid.as_deref() == Some(s.txid.as_str()))
                        })
                } else {
                    s.input_hashes.iter().any(|h| spent_here.contains(h.as_str()))
                        && s.input_hashes.iter().all(|h| spent_here.contains(h.as_str()) || !tx.work.utxos.contains_key(h))
                        && recorded.iter().all(|c| seen.contains(c.as_str()))
                }
            })
            .cloned()
            .collect();
        for sent in &carried {
            let entry = if sent.status == "pending" {
                HistoryEntry { status: "confirmed".into(), height: Some(block.height), ..sent.clone() }
            } else {
                revived(sent, "confirmed", Some(block.height))
            };
            tx.push(WalletChange::PutHistory { entry });
        }

        // Inputs spent by a transaction this device did not build, such as
        // a send from another device with the same phrase.
        let mut elsewhere: Vec<String> = Vec::new();
        let mut spent_nau: i128 = 0;
        for hash in &block.spent {
            let Some(existing) = tx.work.utxos.get(hash).cloned() else { continue };
            let spent_by = carried.iter().find(|s| s.input_hashes.contains(hash)).map(|s| s.txid.clone());
            tx.push(WalletChange::PutUtxo {
                utxo: Utxo {
                    spent_height: Some(block.height),
                    spent_txid: spent_by.clone(),
                    pending_txid: spent_by.clone(),
                    ..existing.clone()
                },
            });
            // A pending send that spends the same coin can no longer go through.
            let lost: Vec<HistoryEntry> = tx.work.history.values().filter(|r| own_send(r) && r.status == "pending" && r.input_hashes.contains(hash)).cloned().collect();
            for sent in lost {
                let mut extra = sent.extra.clone();
                extra.insert("error".into(), json!(if spent_by.is_some() { LOST_TO_OWN } else { LOST_ELSEWHERE }));
                tx.push(WalletChange::PutHistory {
                    entry: HistoryEntry { status: "failed".into(), height: Some(block.height), extra, ..sent.clone() },
                });
                // Whatever else it held is free again.
                let others: Vec<Utxo> = tx
                    .work
                    .utxos
                    .values()
                    .filter(|o| o.pending_txid.as_deref() == Some(sent.txid.as_str()) && o.spent_height.is_none() && o.hash != *hash)
                    .cloned()
                    .collect();
                for other in others {
                    tx.push(WalletChange::PutUtxo { utxo: Utxo { pending_txid: None, ..other } });
                }
            }
            // Not a send this device built (a coin the mempool watcher held
            // for a transaction seen elsewhere lands here too).
            if spent_by.is_none() {
                elsewhere.push(hash.clone());
                spent_nau += nau(&existing.amount_nau);
            }
        }
        if !elsewhere.is_empty() {
            // One "sent" row for the block. The recipient and the fee are not
            // known here; what this seed built in the same block is taken as
            // change, and a third party's payment in it is a receipt.
            let back: Vec<&StoredUtxo> = block.incoming.iter().filter(|u| u.own_build_height.is_some()).collect();
            let back_nau: i128 = back.iter().map(|u| nau(&u.amount_nau)).sum();
            let change = if back_nau <= spent_nau { back_nau } else { 0 };
            let mut extra = owner(wallet_id);
            extra.insert("amountNau".into(), json!((spent_nau - change).to_string()));
            extra.insert("feeNau".into(), Value::Null);
            extra.insert("recipient".into(), Value::Null);
            extra.insert("error".into(), Value::Null);
            extra.insert("changeNau".into(), if change > 0 { json!(change.to_string()) } else { Value::Null });
            extra.insert(
                "outputs".into(),
                json!(back.iter().filter(|u| !u.commitment.is_empty()).map(|u| json!({ "commitment": u.commitment, "role": "change" })).collect::<Vec<_>>()),
            );
            tx.push(WalletChange::PutHistory {
                entry: HistoryEntry {
                    key: record_key(wallet_id, &format!("spent:{}", block.height)),
                    kind: "sent".into(),
                    status: "confirmed".into(),
                    txid: String::new(),
                    timestamp_ms: block.timestamp_ms,
                    height: Some(block.height),
                    input_hashes: elsewhere.clone(),
                    extra,
                },
            });
        }
        // The watcher's pending rows for coins this block spent, whichever transaction spent them.
        let stale: Vec<String> = tx
            .work
            .history
            .values()
            .filter(|r| r.status == "pending" && r.key.contains(":outgoing:") && r.input_hashes.iter().any(|h| spent_here.contains(h.as_str())))
            .map(|r| r.key.clone())
            .collect();
        for key in stale {
            tx.push(WalletChange::DeleteHistory { key });
        }

        let mut extra = owner(wallet_id);
        extra.insert("key".into(), json!(record_key(wallet_id, &block.height.to_string())));
        if let (Some(difficulty), Some(work)) = (&block.difficulty, &block.cumulative_pow) {
            extra.insert("difficulty".into(), json!(difficulty));
            extra.insert("cumulativePow".into(), json!(work));
        }
        tx.push(WalletChange::PutBlock {
            block: Block { height: block.height, hash: block.hash.clone(), prev_hash: block.prev_hash.clone(), timestamp_ms: block.timestamp_ms, extra },
        });
    }

    // Trim old block records; deep reorgs beyond this fall back to a rescan.
    let cutoff = last.height as i64 - keep_blocks as i64;
    if cutoff > 0 {
        tx.push(WalletChange::DeleteBlocksUpTo { height: cutoff as u64 });
    }
    tx.push(WalletChange::PutSync { sync: sync_record(wallet_id, last.height as i64, Some(last.hash.clone()), now) });
    if scan.next_key_indices != next_key_indices {
        tx.push(WalletChange::PutScan { scan: ScanState { next_key_indices, ..scan } });
    }
    Ok(tx.done(()))
}

/// A fast restore has run: the ordinary scan takes over a little below the
/// tip, and the start height moves down to the lowest block that mattered.
pub fn finish_fast_restore(state: &WalletState, wallet_id: &str, handover: i64, lowest: u64, now: u64) -> Result<Outcome> {
    let scan = scan_of(state)?;
    let mut tx = Tx::new(state);
    tx.push(WalletChange::PutSync { sync: sync_record(wallet_id, handover, None, now) });
    let birthday = lowest.min((handover + 1).max(0) as u64).max(1);
    tx.push(WalletChange::PutScan {
        scan: ScanState { birthday_height: birthday, restore: None, restored_at: Some(now), ..scan },
    });
    Ok(tx.done(()))
}

/// Start scanning again from `height`: what scanning found goes, what a
/// person made (contacts, the wallet's own record) stays. Funds are
/// unaffected; only the local view is rebuilt.
///
/// So do this device's sends that have not settled: pending, given up on,
/// or expired. The chain cannot rebuild them, and a pending one forgotten
/// would free its coins for a second send that silently cancels the first.
/// Their coins come back held when the scan finds them again (see
/// `persist_scan`), and until then they are not there to spend.
pub fn reset_for_rescan(state: &WalletState, height: u64, fast: bool) -> Result<Outcome> {
    scan_of(state)?;
    let mut tx = Tx::new(state);
    tx.push(WalletChange::Reset);
    for entry in state.history.values().filter(|h| own_send(h) && (h.status == "pending" || given_up(h))) {
        tx.push(WalletChange::PutHistory { entry: entry.clone() });
    }
    tx.push(WalletChange::PutScan {
        scan: ScanState {
            birthday_height: height,
            next_key_indices: FRESH_KEY_INDICES,
            restore: fast.then(|| "fast".to_string()),
            restored_at: None,
        },
    });
    Ok(tx.done(()))
}

/// Drop the restore marker: a rebuild on a node with no coin index goes on
/// as a plain scan from the start height.
pub fn clear_restore(state: &WalletState) -> Result<Outcome> {
    let scan = scan_of(state)?;
    let mut tx = Tx::new(state);
    if scan.restore.is_some() {
        tx.push(WalletChange::PutScan { scan: ScanState { restore: None, ..scan } });
    }
    Ok(tx.done(()))
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

/// Hold a send's inputs and write its pending row, together.
pub fn record_pending(state: &WalletState, entry: HistoryEntry) -> Outcome {
    let mut tx = Tx::new(state);
    for hash in &entry.input_hashes {
        if let Some(coin) = tx.work.utxos.get(hash).cloned() {
            tx.push(WalletChange::PutUtxo { utxo: Utxo { pending_txid: Some(entry.txid.clone()), ..coin } });
        }
    }
    tx.push(WalletChange::PutHistory { entry });
    tx.done(())
}

fn release_inputs(tx: &mut Tx, entry: &HistoryEntry) {
    for hash in &entry.input_hashes {
        if let Some(coin) = tx.work.utxos.get(hash).cloned() {
            if coin.pending_txid.as_deref() == Some(entry.txid.as_str()) && coin.spent_height.is_none() {
                tx.push(WalletChange::PutUtxo { utxo: Utxo { pending_txid: None, ..coin } });
            }
        }
    }
}

/// The node refused a send: release its inputs and drop its row, as if it
/// had never been written.
pub fn discard_pending(state: &WalletState, wallet_id: &str, txid: &str) -> Outcome {
    let mut tx = Tx::new(state);
    if let Some(entry) = state.history.get(&record_key(wallet_id, &format!("sent:{txid}"))).cloned() {
        release_inputs(&mut tx, &entry);
        tx.push(WalletChange::DeleteHistory { key: entry.key });
    }
    tx.done(())
}

/// The person gave up on a pending send: release its inputs and mark it
/// failed. One no longer pending, which a block confirmed meanwhile, stays.
/// Answers whether the send was given up.
pub fn forget_send(state: &WalletState, wallet_id: &str, txid: &str) -> Outcome<bool> {
    let mut tx = Tx::new(state);
    let Some(entry) = state.history.get(&record_key(wallet_id, &format!("sent:{txid}"))).filter(|e| e.status == "pending").cloned() else {
        return tx.done(false);
    };
    release_inputs(&mut tx, &entry);
    let mut extra = entry.extra.clone();
    extra.insert("error".into(), json!(GAVE_UP));
    extra.insert("givenUp".into(), json!(true));
    tx.push(WalletChange::PutHistory { entry: HistoryEntry { status: "failed".into(), extra, ..entry } });
    tx.done(true)
}

/// When a pending send was stamped: the transaction's own timestamp, kept
/// on the row since it was, else the time the row was written, which is
/// later and so errs on the side of waiting.
fn stamped_at(entry: &HistoryEntry) -> u64 {
    entry.extra.get("stampMs").and_then(Value::as_u64).unwrap_or(entry.timestamp_ms)
}

/// How far past this device's clock the chain's time is taken to be.
const CLOCK_MARGIN_MS: u64 = 60 * 60 * 1000;

/// The chain's time as this wallet checked it: the timestamp of the newest
/// block it scanned, which links to the blocks before it and on Mainnet
/// carries its proof of work, but no more than an hour past this device's
/// clock `now`. None before a block is kept at the scan's position.
pub fn chain_time(state: &WalletState, now: u64) -> Option<u64> {
    let synced = u64::try_from(state.sync.as_ref()?.synced_height).ok()?;
    Some(state.blocks.get(&synced)?.timestamp_ms.min(now.saturating_add(CLOCK_MARGIN_MS)))
}

/// Pending sends of this device that no block took in time, by the chain's
/// time as this wallet checked it (`chain_time`): their coins are released
/// and each is marked as expired. Not one whose confirming block was rolled
/// back. Answers their transaction ids.
pub fn expire_sends(state: &WalletState, now: u64) -> Outcome<Vec<String>> {
    let mut tx = Tx::new(state);
    let mut expired = Vec::new();
    let Some(chain_now) = chain_time(state, now) else { return tx.done(expired) };
    for entry in state.history.values().filter(|h| own_send(h) && h.status == "pending" && !rolled_back(h)) {
        if chain_now <= stamped_at(entry).saturating_add(SEND_LIFETIME_MS) {
            continue;
        }
        release_inputs(&mut tx, entry);
        let mut extra = entry.extra.clone();
        extra.insert("error".into(), json!(EXPIRED));
        extra.insert("expired".into(), json!(true));
        tx.push(WalletChange::PutHistory { entry: HistoryEntry { status: "failed".into(), extra, ..entry.clone() } });
        expired.push(entry.txid.clone());
    }
    tx.done(expired)
}

// ---------------------------------------------------------------------------
// The mempool
// ---------------------------------------------------------------------------

/// Hold a coin for a transaction, or let it go, if it is still where the
/// caller last saw it: held by `from` and unspent.
fn set_hold(tx: &mut Tx, hash: &str, from: Option<&str>, to: Option<&str>) {
    if let Some(coin) = tx.work.utxos.get(hash).cloned() {
        if coin.pending_txid.as_deref() == from && coin.spent_height.is_none() {
            tx.push(WalletChange::PutUtxo { utxo: Utxo { pending_txid: to.map(str::to_string), ..coin } });
        }
    }
}

/// This wallet's coins, spent by a transaction it did not build: write the
/// pending row and hold the coins, unless the row is already there.
/// Answers whether it was written.
pub fn record_outgoing(state: &WalletState, row: HistoryEntry) -> Outcome<bool> {
    let mut tx = Tx::new(state);
    if state.history.contains_key(&row.key) {
        return tx.done(false);
    }
    // Coins this device's own pending send holds are that send's, whatever
    // the watcher made of the transaction.
    let own = |hash: &String| {
        state.utxos.get(hash).and_then(|c| c.pending_txid.as_ref()).is_some_and(|txid| {
            state.history.values().any(|r| r.kind == "sent" && r.status == "pending" && r.txid == *txid && !r.key.contains(":outgoing:"))
        })
    };
    if !row.input_hashes.is_empty() && row.input_hashes.iter().all(own) {
        return tx.done(false);
    }
    // The coins of a send given up on, spent after all: that send is going
    // through. Its row comes back as pending, with its recipient and fee,
    // and holds its coins again, instead of a second row for the same
    // payment without either. Not one that expired: no block can take it,
    // so whatever spends its coins now is another transaction.
    if let Some(sent) = row.input_hashes.iter().find_map(|h| given_up_spending(state, h)).filter(|s| !expired(s)) {
        tx.push(WalletChange::PutHistory { entry: revived(&sent, "pending", None) });
        for hash in &sent.input_hashes {
            set_hold(&mut tx, hash, None, Some(&sent.txid));
        }
        return tx.done(true);
    }
    let (inputs, txid) = (row.input_hashes.clone(), row.txid.clone());
    tx.push(WalletChange::PutHistory { entry: row });
    for hash in &inputs {
        set_hold(&mut tx, hash, None, Some(&txid));
    }
    tx.done(true)
}

/// A payment on its way in: write its pending row unless it is already there.
/// Answers whether it was written.
pub fn record_incoming(state: &WalletState, row: HistoryEntry) -> Outcome<bool> {
    let mut tx = Tx::new(state);
    if state.history.contains_key(&row.key) {
        return tx.done(false);
    }
    tx.push(WalletChange::PutHistory { entry: row });
    tx.done(true)
}

/// Drop a history row, if it is there.
pub fn drop_row(state: &WalletState, key: &str) -> Outcome {
    let mut tx = Tx::new(state);
    if state.history.contains_key(key) {
        tx.push(WalletChange::DeleteHistory { key: key.to_string() });
    }
    tx.done(())
}

/// A pending row whose transaction the node no longer holds: drop it, and
/// offer again the coins it held.
pub fn expire_row(state: &WalletState, key: &str) -> Outcome {
    let mut tx = Tx::new(state);
    if let Some(row) = state.history.get(key).cloned() {
        tx.push(WalletChange::DeleteHistory { key: row.key.clone() });
        for hash in &row.input_hashes {
            set_hold(&mut tx, hash, Some(&row.txid), None);
        }
    }
    tx.done(())
}

/// Record whether the node still holds each of the pending sends asked
/// about. Only rows that are still pending sends are touched: one the sync
/// confirmed while the node was being asked keeps its confirmation.
pub fn mark_mempool_checked(state: &WalletState, asked: &[String], present: &BTreeSet<String>, at: u64) -> Outcome {
    let mut tx = Tx::new(state);
    for key in asked {
        let Some(row) = state.history.get(key) else { continue };
        let commitments = outputs(row);
        if row.kind != "sent" || row.status != "pending" || commitments.is_empty() {
            continue;
        }
        let held = commitments.iter().any(|c| present.contains(c));
        let mut extra = row.extra.clone();
        let seen = if held { json!(at) } else { extra.get("mempoolSeenAt").cloned().unwrap_or(Value::Null) };
        extra.insert("mempoolSeenAt".into(), seen);
        extra.insert("mempoolCheckedAt".into(), json!(at));
        tx.push(WalletChange::PutHistory { entry: HistoryEntry { extra, ..row.clone() } });
    }
    tx.done(())
}

/// A record as the app shapes it, for an operation that takes one from the app.
pub fn history_entry(record: Value) -> Result<HistoryEntry> {
    serde_json::from_value(record).context("store: the history entry is not in a shape this build knows")
}

pub mod op;

#[cfg(test)]
mod tests;
