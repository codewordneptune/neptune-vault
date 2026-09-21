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
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use serde_json::Map;
use serde_json::Value;

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

/// Output commitments of this wallet's pending sends: a block that carries
/// one has that send in it.
pub fn watched_commitments(state: &WalletState) -> Vec<String> {
    state
        .history
        .values()
        .filter(|h| h.kind == "sent" && h.status == "pending")
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
/// A wallet made while the node was unreachable has no start height yet,
/// and one set above the chain (a typo at import, or a rescan aimed too far
/// ahead) would skip every block until the chain caught up: both start at
/// the tip seen now. Only before the first scan: once the wallet has a
/// position, a node reporting a low tip must not rewrite where its history
/// starts, and one reporting a tip below that position is refused.
pub fn start_pass(state: &WalletState, tip_height: u64) -> Result<Outcome<Position>> {
    let mut scan = scan_of(state)?;
    let mut tx = Tx::new(state);
    if state.sync.is_none() && (scan.birthday_height == 0 || scan.birthday_height > tip_height) {
        scan.birthday_height = tip_height;
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

/// Where a rollback lands when no kept block is canonical: before the start.
pub fn rollback_floor(state: &WalletState) -> Result<i64> {
    let birthday = scan_of(state).map(|s| s.birthday_height).unwrap_or(1);
    Ok(birthday as i64 - 1)
}

/// Forget everything above `height`, including spends recorded above it.
/// Rows the chain produced go; a send this device built goes back to pending.
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
                tx.push(WalletChange::PutHistory { entry: HistoryEntry { status: "pending".into(), height: None, ..h.clone() } });
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

        // Inputs spent by a transaction this device did not build, such as
        // a send from another device with the same phrase.
        let mut elsewhere: Vec<String> = Vec::new();
        let mut spent_nau: i128 = 0;
        let seen: BTreeSet<&str> = block.seen.iter().map(String::as_str).collect();
        for hash in &block.spent {
            let Some(existing) = tx.work.utxos.get(hash).cloned() else { continue };
            let sent = existing
                .pending_txid
                .as_ref()
                .and_then(|txid| tx.work.history.get(&record_key(wallet_id, &format!("sent:{txid}"))).cloned());
            // A send is in this block when the block carries its outputs. Its
            // inputs being spent is not enough: another device with the same
            // seed phrase can spend the same coins in another transaction,
            // and then this send never reached its recipient. Rows from
            // before outputs were recorded keep the old rule.
            let recorded = sent.as_ref().map(outputs).unwrap_or_default();
            let mine = sent.is_some() && (recorded.is_empty() || recorded.iter().any(|c| seen.contains(c.as_str())));
            tx.push(WalletChange::PutUtxo {
                utxo: Utxo {
                    spent_height: Some(block.height),
                    spent_txid: if mine { existing.pending_txid.clone() } else { None },
                    pending_txid: if mine { existing.pending_txid.clone() } else { None },
                    ..existing.clone()
                },
            });
            match &sent {
                Some(sent) if mine => {
                    if sent.status == "pending" {
                        tx.push(WalletChange::PutHistory {
                            entry: HistoryEntry { status: "confirmed".into(), height: Some(block.height), ..sent.clone() },
                        });
                    }
                }
                _ => {
                    if let Some(sent) = sent.as_ref().filter(|s| s.status == "pending") {
                        let mut extra = sent.extra.clone();
                        extra.insert("error".into(), json!("Not sent: its coins were spent by another transaction, made elsewhere with this seed phrase."));
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
                    // Not a send this device built (a coin the mempool
                    // watcher held for a transaction seen elsewhere lands here too).
                    elsewhere.push(hash.clone());
                    spent_nau += nau(&existing.amount_nau);
                }
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
            // The watcher's pending row for the same spend, if any.
            let spent: BTreeSet<&String> = elsewhere.iter().collect();
            let stale: Vec<String> = tx
                .work
                .history
                .values()
                .filter(|r| r.status == "pending" && r.key.contains(":outgoing:") && r.input_hashes.iter().any(|h| spent.contains(h)))
                .map(|r| r.key.clone())
                .collect();
            for key in stale {
                tx.push(WalletChange::DeleteHistory { key });
            }
        }

        let mut extra = owner(wallet_id);
        extra.insert("key".into(), json!(record_key(wallet_id, &block.height.to_string())));
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
pub fn reset_for_rescan(state: &WalletState, height: u64, fast: bool) -> Result<Outcome> {
    scan_of(state)?;
    let mut tx = Tx::new(state);
    tx.push(WalletChange::Reset);
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

/// The person gave up on a pending send: release its inputs and mark it failed.
pub fn forget_send(state: &WalletState, wallet_id: &str, txid: &str) -> Outcome {
    let mut tx = Tx::new(state);
    if let Some(entry) = state.history.get(&record_key(wallet_id, &format!("sent:{txid}"))).cloned() {
        release_inputs(&mut tx, &entry);
        let mut extra = entry.extra.clone();
        extra.insert("error".into(), json!("You gave up on this send."));
        tx.push(WalletChange::PutHistory { entry: HistoryEntry { status: "failed".into(), extra, ..entry } });
    }
    tx.done(())
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

#[cfg(test)]
mod tests;
