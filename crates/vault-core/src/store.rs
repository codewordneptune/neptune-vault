//! The wallet's data, held by the engine rather than by the app.
//!
//! The whole wallet lives in memory as [`WalletState`]. Nothing edits it in
//! place: every change is a typed [`Change`], changes travel in batches, and
//! a batch is applied only after it has been written down. What is written
//! is an append-only log of batches with an occasional snapshot, so the
//! storage underneath needs no opinions about wallets at all. It keeps
//! numbered byte strings, in order, and gives them back. A SQLite file does
//! that on a device and IndexedDB does it in a browser, which is what lets
//! one engine serve both without speaking either one's language.
//!
//! The order is prepare, write, confirm. [`Store::prepare`] checks a batch
//! and serialises it without touching the state; the host writes the bytes,
//! however long that takes; [`Store::confirm`] then applies it. A write that
//! fails leaves memory and storage agreeing, because memory was never ahead.
//! The split exists for the browser, where writing is asynchronous and the
//! engine cannot wait on it. [`Persisted`] runs the three steps in one call
//! for hosts whose storage answers at once.
//!
//! Records keep the field names the web app has always used, so moving a
//! wallet over from the app's own database is one batch of puts. Fields
//! this module has no use for ride along in `extra` and are written back
//! untouched.

use std::collections::BTreeMap;

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use crate::scan::NextKeyIndices;

/// The format this build writes. An entry with a higher number was written
/// by a newer build and is refused: reading it would drop what this build
/// does not know about, and the next write would make the loss permanent.
pub const FORMAT: u32 = 1;

/// How the refusal of a newer format starts, for the app to recognise.
pub const NEWER_FORMAT: &str = "store: written by a newer version";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// One wallet on this device.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub network: String,
    pub created_at: u64,
    /// First height worth scanning; 0 is "unknown" and becomes the tip at first sync.
    pub birthday_height: u64,
    /// The sealed seed. Opaque here: the store keeps it and never opens it.
    pub envelope: Value,
    /// Address of key 0, so receiving works before unlocking.
    pub address0: String,
    pub next_key_indices: NextKeyIndices,
    #[serde(default)]
    pub backup_confirmed: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A coin, with the bookkeeping the wallet keeps about it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Utxo {
    pub account_id: String,
    /// The core's key for the coin: its hash, a colon, its index on the chain.
    pub hash: String,
    /// The core's own record of the coin, kept exactly as the scan produced it.
    pub stored: Value,
    pub amount_nau: String,
    pub amount: String,
    pub confirmed_height: u64,
    pub confirmed_timestamp_ms: u64,
    pub release_date_ms: Option<u64>,
    pub spent_height: Option<u64>,
    pub spent_txid: Option<String>,
    /// Held by a pending send.
    pub pending_txid: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A scanned block, kept for a while so a reorganisation can be measured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub account_id: String,
    pub height: u64,
    pub hash: String,
    pub prev_hash: String,
    pub timestamp_ms: u64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A line of history. Most of it is the app's to read, so beyond what the
/// engine needs to find and order entries, the fields ride in `extra`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub key: String,
    pub account_id: String,
    pub kind: String,
    pub status: String,
    pub txid: String,
    pub timestamp_ms: u64,
    pub height: Option<u64>,
    #[serde(default)]
    pub input_hashes: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub account_id: String,
    /// Last height fully scanned, or birthday minus one.
    pub synced_height: u64,
    pub synced_hash: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub address: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Per device, not per wallet. Almost all of it is the app's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub network: String,
    pub current_account_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Everything one wallet owns. Deleting the wallet deletes this, whole.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountState {
    pub account: Account,
    pub sync: Option<SyncState>,
    /// By coin key.
    pub utxos: BTreeMap<String, Utxo>,
    /// By height.
    pub blocks: BTreeMap<u64, Block>,
    /// By entry key.
    pub history: BTreeMap<String, HistoryEntry>,
    /// By contact id.
    pub contacts: BTreeMap<String, Contact>,
}

impl AccountState {
    fn new(account: Account) -> Self {
        Self {
            account,
            sync: None,
            utxos: BTreeMap::new(),
            blocks: BTreeMap::new(),
            history: BTreeMap::new(),
            contacts: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WalletState {
    pub settings: Option<Settings>,
    pub accounts: BTreeMap<String, AccountState>,
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/// One edit to the wallet. Everything that belongs to a wallet names it, and
/// a change for a wallet that does not exist is refused, which is the check
/// a foreign key would make.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Change {
    PutSettings { settings: Settings },
    /// Create a wallet, or replace its record and keep what it owns.
    PutAccount { account: Account },
    /// Remove a wallet and everything it owns, in one step.
    #[serde(rename_all = "camelCase")]
    DeleteAccount { account_id: String },
    /// Forget what scanning found (coins, blocks, history, position) and keep
    /// what a person made (the record itself, contacts): a rescan starts here.
    #[serde(rename_all = "camelCase")]
    ResetAccount { account_id: String },
    PutSync { sync: SyncState },
    PutUtxo { utxo: Utxo },
    #[serde(rename_all = "camelCase")]
    DeleteUtxo { account_id: String, hash: String },
    PutBlock { block: Block },
    /// A reorganisation: blocks above the fork point are no longer true.
    #[serde(rename_all = "camelCase")]
    DeleteBlocksAbove { account_id: String, height: u64 },
    /// Trimming: blocks this old no longer help measure a reorganisation.
    #[serde(rename_all = "camelCase")]
    DeleteBlocksUpTo { account_id: String, height: u64 },
    PutHistory { entry: HistoryEntry },
    #[serde(rename_all = "camelCase")]
    DeleteHistory { account_id: String, key: String },
    PutContact { contact: Contact },
    #[serde(rename_all = "camelCase")]
    DeleteContact { account_id: String, id: String },
}

impl Change {
    /// The wallet this change needs to exist, if any.
    fn requires(&self) -> Option<&str> {
        match self {
            Change::PutSettings { .. } | Change::PutAccount { .. } => None,
            Change::DeleteAccount { account_id }
            | Change::ResetAccount { account_id }
            | Change::DeleteUtxo { account_id, .. }
            | Change::DeleteBlocksAbove { account_id, .. }
            | Change::DeleteBlocksUpTo { account_id, .. }
            | Change::DeleteHistory { account_id, .. }
            | Change::DeleteContact { account_id, .. } => Some(account_id),
            Change::PutSync { sync } => Some(&sync.account_id),
            Change::PutUtxo { utxo } => Some(&utxo.account_id),
            Change::PutBlock { block } => Some(&block.account_id),
            Change::PutHistory { entry } => Some(&entry.account_id),
            Change::PutContact { contact } => Some(&contact.account_id),
        }
    }
}

/// Whether every change in the batch has the wallet it needs, counting
/// wallets the batch itself creates and removes along the way.
fn check(state: &WalletState, changes: &[Change]) -> Result<()> {
    let mut known: std::collections::BTreeSet<&str> =
        state.accounts.keys().map(String::as_str).collect();
    for change in changes {
        if let Some(id) = change.requires() {
            if !known.contains(id) {
                bail!("store: no wallet {id} for this change");
            }
        }
        match change {
            Change::PutAccount { account } => {
                known.insert(&account.id);
            }
            Change::DeleteAccount { account_id } => {
                known.remove(account_id.as_str());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Apply a checked batch. Cannot fail, which is the point of checking first:
/// a batch is applied whole or not at all.
fn apply(state: &mut WalletState, changes: Vec<Change>) {
    for change in changes {
        match change {
            Change::PutSettings { settings } => state.settings = Some(settings),
            Change::PutAccount { account } => match state.accounts.get_mut(&account.id) {
                Some(existing) => existing.account = account,
                None => {
                    state
                        .accounts
                        .insert(account.id.clone(), AccountState::new(account));
                }
            },
            Change::DeleteAccount { account_id } => {
                state.accounts.remove(&account_id);
            }
            other => {
                let id = other.requires().expect("every remaining change names a wallet");
                let owned = state
                    .accounts
                    .get_mut(id)
                    .expect("the batch was checked before it was applied");
                match other {
                    Change::ResetAccount { .. } => {
                        owned.sync = None;
                        owned.utxos.clear();
                        owned.blocks.clear();
                        owned.history.clear();
                    }
                    Change::PutSync { sync } => owned.sync = Some(sync),
                    Change::PutUtxo { utxo } => {
                        owned.utxos.insert(utxo.hash.clone(), utxo);
                    }
                    Change::DeleteUtxo { hash, .. } => {
                        owned.utxos.remove(&hash);
                    }
                    Change::PutBlock { block } => {
                        owned.blocks.insert(block.height, block);
                    }
                    Change::DeleteBlocksAbove { height, .. } => {
                        owned.blocks.split_off(&(height + 1));
                    }
                    Change::DeleteBlocksUpTo { height, .. } => {
                        owned.blocks = owned.blocks.split_off(&(height + 1));
                    }
                    Change::PutHistory { entry } => {
                        owned.history.insert(entry.key.clone(), entry);
                    }
                    Change::DeleteHistory { key, .. } => {
                        owned.history.remove(&key);
                    }
                    Change::PutContact { contact } => {
                        owned.contacts.insert(contact.id.clone(), contact);
                    }
                    Change::DeleteContact { id, .. } => {
                        owned.contacts.remove(&id);
                    }
                    Change::PutSettings { .. }
                    | Change::PutAccount { .. }
                    | Change::DeleteAccount { .. } => unreachable!("handled above"),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/// What an entry holds: a batch of changes, or the whole state as of a batch.
enum Body {
    Changes(Vec<Change>),
    Snapshot(WalletState),
}

/// One numbered entry of the log, as written. JSON, because the fields are
/// named in it: a format that goes by position breaks the day a field is
/// added. The shape is deliberately plain, a kind and one of two fields,
/// and not a tagged enum: serde reads those through a buffer in which the
/// state's integer keys (blocks by height) stop being integers.
#[derive(Serialize, Deserialize)]
struct Entry {
    format: u32,
    seq: u64,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    changes: Option<Vec<Change>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<WalletState>,
}

impl Entry {
    fn changes(seq: u64, changes: Vec<Change>) -> Self {
        Self { format: FORMAT, seq, kind: "changes".into(), changes: Some(changes), state: None }
    }

    fn snapshot(seq: u64, state: WalletState) -> Self {
        Self { format: FORMAT, seq, kind: "snapshot".into(), changes: None, state: Some(state) }
    }

    fn into_body(self) -> Result<Body> {
        match (self.kind.as_str(), self.changes, self.state) {
            ("changes", Some(changes), None) => Ok(Body::Changes(changes)),
            ("snapshot", None, Some(state)) => Ok(Body::Snapshot(state)),
            (kind, _, _) => bail!("store: entry {} is not a well-formed {kind}", self.seq),
        }
    }
}

/// Only what every format will always have, read before anything else so
/// that a newer entry is recognised as newer rather than as damaged.
#[derive(Deserialize)]
struct Header {
    format: u32,
}

/// A batch that has been checked and serialised and is waiting to be
/// written. Hand `bytes` to storage under `seq`, then give this back to
/// [`Store::confirm`].
#[derive(Debug)]
pub struct Prepared {
    pub seq: u64,
    pub bytes: Vec<u8>,
    changes: Vec<Change>,
}

/// The wallet state and its position in the log.
#[derive(Debug, Default)]
pub struct Store {
    state: WalletState,
    /// The number of the last entry applied; 0 before the first.
    seq: u64,
}

impl Store {
    /// Rebuild the state from what storage holds, in any order. The newest
    /// snapshot is the starting point and every later batch is replayed over
    /// it. Older entries are ignored, because compaction writes the snapshot
    /// before it deletes what the snapshot covers, and a crash between the
    /// two leaves both.
    pub fn open(entries: Vec<Vec<u8>>) -> Result<Store> {
        let mut parsed = Vec::with_capacity(entries.len());
        for bytes in &entries {
            let header: Header =
                serde_json::from_slice(bytes).context("store: an entry is not readable")?;
            if header.format > FORMAT {
                bail!("{NEWER_FORMAT} (format {}, this build reads {FORMAT})", header.format);
            }
            let entry: Entry =
                serde_json::from_slice(bytes).context("store: an entry is not readable")?;
            let seq = entry.seq;
            parsed.push((seq, entry.into_body()?));
        }
        // A snapshot sorts after the batch it is numbered as, since it includes it.
        parsed.sort_by_key(|(seq, body)| (*seq, matches!(body, Body::Snapshot(_))));

        let start = parsed
            .iter()
            .rposition(|(_, body)| matches!(body, Body::Snapshot(_)))
            .unwrap_or(0);
        let mut store = Store::default();
        for (seq, body) in parsed.into_iter().skip(start) {
            match body {
                Body::Snapshot(state) => {
                    store.state = state;
                    store.seq = seq;
                }
                Body::Changes(changes) => {
                    if seq != store.seq + 1 {
                        bail!(
                            "store: entry {} is missing; the log goes from {} to {}",
                            store.seq + 1,
                            store.seq,
                            seq
                        );
                    }
                    check(&store.state, &changes)
                        .with_context(|| format!("store: entry {seq} does not apply"))?;
                    apply(&mut store.state, changes);
                    store.seq = seq;
                }
            }
        }
        Ok(store)
    }

    pub fn state(&self) -> &WalletState {
        &self.state
    }

    /// The number of the last entry applied.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Check a batch and serialise it, changing nothing.
    pub fn prepare(&self, changes: Vec<Change>) -> Result<Prepared> {
        check(&self.state, &changes)?;
        let seq = self.seq + 1;
        let entry = Entry::changes(seq, changes);
        let bytes = serde_json::to_vec(&entry).context("store: cannot serialise the batch")?;
        let changes = entry.changes.expect("built as a batch just above");
        Ok(Prepared { seq, bytes, changes })
    }

    /// Apply a batch that storage now holds. Batches are confirmed in the
    /// order they were prepared; one prepared against an older state is
    /// refused, since what it was checked against is no longer true.
    pub fn confirm(&mut self, prepared: Prepared) -> Result<()> {
        if prepared.seq != self.seq + 1 {
            return Err(anyhow!(
                "store: batch {} was prepared before batch {} was confirmed",
                prepared.seq,
                self.seq
            ));
        }
        apply(&mut self.state, prepared.changes);
        self.seq = prepared.seq;
        Ok(())
    }

    /// The whole state as one entry, numbered as the last batch it includes.
    /// Once storage holds it, every entry up to that number can go.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let entry = Entry::snapshot(self.seq, self.state.clone());
        serde_json::to_vec(&entry).context("store: cannot serialise the snapshot")
    }
}

// ---------------------------------------------------------------------------
// Storage that answers at once
// ---------------------------------------------------------------------------

/// Storage as the engine needs it: numbered byte strings, kept in order.
/// It is told nothing about what the bytes mean.
pub trait Persist {
    /// Every entry held, in any order.
    fn load(&mut self) -> Result<Vec<Vec<u8>>>;
    /// Keep `bytes` as entry `seq`. Durable by the time this returns.
    fn append(&mut self, seq: u64, bytes: &[u8]) -> Result<()>;
    /// Keep `snapshot` as of `seq`, then drop every batch up to `seq`. In
    /// that order: a crash between the two leaves too much, never too little.
    fn compact(&mut self, seq: u64, snapshot: &[u8]) -> Result<()>;
}

/// Batches kept between snapshots before the log is folded into a new one.
pub const COMPACT_EVERY: u64 = 256;

/// A store and the storage under it, for hosts whose storage is synchronous.
pub struct Persisted<P: Persist> {
    store: Store,
    backend: P,
    since_snapshot: u64,
}

impl<P: Persist> Persisted<P> {
    pub fn open(mut backend: P) -> Result<Self> {
        let entries = backend.load()?;
        let since_snapshot = entries.len() as u64;
        let store = Store::open(entries)?;
        Ok(Self { store, backend, since_snapshot })
    }

    pub fn state(&self) -> &WalletState {
        self.store.state()
    }

    /// Write a batch down, then apply it. If the write fails, nothing changed.
    pub fn commit(&mut self, changes: Vec<Change>) -> Result<()> {
        let prepared = self.store.prepare(changes)?;
        self.backend.append(prepared.seq, &prepared.bytes)?;
        self.store.confirm(prepared)?;
        self.since_snapshot += 1;
        if self.since_snapshot >= COMPACT_EVERY {
            // Best effort: a log that is longer than it needs to be is still
            // a correct log, so failing to shorten it is not a failed commit.
            if let Ok(snapshot) = self.store.snapshot() {
                if self.backend.compact(self.store.seq(), &snapshot).is_ok() {
                    self.since_snapshot = 0;
                }
            }
        }
        Ok(())
    }
}

/// Storage in memory, for tests and for hosts with nowhere to write.
#[derive(Default)]
pub struct MemoryPersist {
    pub batches: BTreeMap<u64, Vec<u8>>,
    pub snapshot: Option<(u64, Vec<u8>)>,
    /// Make the next append fail, to test that a failed write changes nothing.
    pub fail_next_append: bool,
}

impl Persist for MemoryPersist {
    fn load(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut entries: Vec<Vec<u8>> = self.batches.values().cloned().collect();
        if let Some((_, snapshot)) = &self.snapshot {
            entries.push(snapshot.clone());
        }
        Ok(entries)
    }

    fn append(&mut self, seq: u64, bytes: &[u8]) -> Result<()> {
        if std::mem::take(&mut self.fail_next_append) {
            bail!("the disk is full");
        }
        self.batches.insert(seq, bytes.to_vec());
        Ok(())
    }

    fn compact(&mut self, seq: u64, snapshot: &[u8]) -> Result<()> {
        self.snapshot = Some((seq, snapshot.to_vec()));
        self.batches = self.batches.split_off(&(seq + 1));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(id: &str) -> Account {
        serde_json::from_value(json!({
            "id": id,
            "network": "main",
            "createdAt": 1,
            "birthdayHeight": 100,
            "envelope": { "version": 1 },
            "address0": "nolgam1abc",
            "nextKeyIndices": { "generation": 1, "ec_hybrid": 0, "viewing": 0 },
            "backupConfirmed": true,
            "name": "Savings",
            "lastBackupAt": 42
        }))
        .unwrap()
    }

    fn utxo(account_id: &str, hash: &str) -> Utxo {
        serde_json::from_value(json!({
            "key": format!("{account_id}:{hash}"),
            "accountId": account_id,
            "hash": hash,
            "stored": { "hash": hash, "recovery": { "aocl_index": 7 } },
            "amountNau": "5",
            "amount": "0.0000005",
            "confirmedHeight": 120,
            "confirmedTimestampMs": 9,
            "releaseDateMs": null,
            "spentHeight": null,
            "spentTxid": null,
            "pendingTxid": null
        }))
        .unwrap()
    }

    fn block(account_id: &str, height: u64) -> Block {
        Block {
            account_id: account_id.to_string(),
            height,
            hash: format!("h{height}"),
            prev_hash: format!("h{}", height - 1),
            timestamp_ms: height,
            extra: Map::new(),
        }
    }

    fn contact(account_id: &str, id: &str) -> Contact {
        Contact {
            id: id.to_string(),
            account_id: account_id.to_string(),
            name: "Al".to_string(),
            address: "nolgam1xyz".to_string(),
            extra: Map::new(),
        }
    }

    fn filled() -> Persisted<MemoryPersist> {
        let mut wallet = Persisted::open(MemoryPersist::default()).unwrap();
        wallet
            .commit(vec![
                Change::PutAccount { account: account("a") },
                Change::PutUtxo { utxo: utxo("a", "c1:0") },
                Change::PutBlock { block: block("a", 120) },
                Change::PutBlock { block: block("a", 121) },
                Change::PutContact { contact: contact("a", "k1") },
            ])
            .unwrap();
        wallet
    }

    #[test]
    fn what_was_committed_is_there_after_reopening() {
        let wallet = filled();
        let before = wallet.state().clone();
        let reopened = Persisted::open(wallet.backend).unwrap();
        assert_eq!(reopened.state(), &before);
        assert_eq!(reopened.state().accounts["a"].utxos.len(), 1);
    }

    #[test]
    fn fields_the_engine_has_no_use_for_are_written_back_untouched() {
        let wallet = filled();
        let kept = &wallet.state().accounts["a"].account;
        assert_eq!(kept.extra["name"], json!("Savings"));
        assert_eq!(kept.extra["lastBackupAt"], json!(42));
        let round: Value = serde_json::to_value(kept).unwrap();
        assert_eq!(round["name"], json!("Savings"));
        assert_eq!(wallet.state().accounts["a"].utxos["c1:0"].extra["key"], json!("a:c1:0"));
    }

    #[test]
    fn deleting_a_wallet_takes_everything_it_owns() {
        let mut wallet = filled();
        wallet.commit(vec![Change::PutAccount { account: account("b") }]).unwrap();
        wallet.commit(vec![Change::DeleteAccount { account_id: "a".into() }]).unwrap();
        assert!(!wallet.state().accounts.contains_key("a"));
        assert!(wallet.state().accounts.contains_key("b"));
    }

    #[test]
    fn a_reset_forgets_what_scanning_found_and_keeps_what_a_person_made() {
        let mut wallet = filled();
        wallet.commit(vec![Change::ResetAccount { account_id: "a".into() }]).unwrap();
        let owned = &wallet.state().accounts["a"];
        assert!(owned.utxos.is_empty() && owned.blocks.is_empty() && owned.sync.is_none());
        assert_eq!(owned.contacts.len(), 1);
    }

    #[test]
    fn a_change_for_a_wallet_that_does_not_exist_is_refused_whole() {
        let mut wallet = filled();
        let before = wallet.state().clone();
        let refused = wallet.commit(vec![
            Change::PutUtxo { utxo: utxo("a", "c2:1") },
            Change::PutUtxo { utxo: utxo("ghost", "c3:2") },
        ]);
        assert!(refused.unwrap_err().to_string().contains("ghost"));
        assert_eq!(wallet.state(), &before);
        assert_eq!(wallet.backend.batches.len(), 1);
    }

    #[test]
    fn a_batch_may_use_the_wallet_it_creates_and_not_the_one_it_deletes() {
        let mut wallet = filled();
        wallet
            .commit(vec![
                Change::PutAccount { account: account("n") },
                Change::PutContact { contact: contact("n", "k") },
            ])
            .unwrap();
        let refused = wallet.commit(vec![
            Change::DeleteAccount { account_id: "n".into() },
            Change::PutContact { contact: contact("n", "k2") },
        ]);
        assert!(refused.is_err());
        assert!(wallet.state().accounts.contains_key("n"));
    }

    #[test]
    fn a_write_that_fails_changes_nothing() {
        let mut wallet = filled();
        let before = wallet.state().clone();
        wallet.backend.fail_next_append = true;
        assert!(wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", "c2:1") }]).is_err());
        assert_eq!(wallet.state(), &before);
        // And the next one goes through under the number the failed one had.
        wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", "c2:1") }]).unwrap();
        assert_eq!(wallet.state().accounts["a"].utxos.len(), 2);
    }

    #[test]
    fn a_reorganisation_and_a_trim_cut_the_blocks_from_either_end() {
        let mut wallet = filled();
        wallet.commit(vec![Change::PutBlock { block: block("a", 122) }]).unwrap();
        wallet
            .commit(vec![Change::DeleteBlocksAbove { account_id: "a".into(), height: 121 }])
            .unwrap();
        assert_eq!(wallet.state().accounts["a"].blocks.keys().copied().collect::<Vec<_>>(), [120, 121]);
        wallet
            .commit(vec![Change::DeleteBlocksUpTo { account_id: "a".into(), height: 120 }])
            .unwrap();
        assert_eq!(wallet.state().accounts["a"].blocks.keys().copied().collect::<Vec<_>>(), [121]);
    }

    #[test]
    fn compaction_keeps_the_state_and_shortens_the_log() {
        let mut wallet = filled();
        for i in 0..COMPACT_EVERY {
            wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", &format!("c:{i}")) }]).unwrap();
        }
        assert!(wallet.backend.snapshot.is_some());
        assert!((wallet.backend.batches.len() as u64) < COMPACT_EVERY);
        let before = wallet.state().clone();
        let reopened = Persisted::open(wallet.backend).unwrap();
        assert_eq!(reopened.state(), &before);
    }

    #[test]
    fn a_crash_between_the_snapshot_and_the_trim_is_harmless() {
        let mut wallet = filled();
        wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", "c2:1") }]).unwrap();
        let before = wallet.state().clone();
        // The snapshot was written and the entries it covers were never dropped.
        let snapshot = wallet.store.snapshot().unwrap();
        wallet.backend.snapshot = Some((wallet.store.seq(), snapshot));
        let reopened = Persisted::open(wallet.backend).unwrap();
        assert_eq!(reopened.state(), &before);
    }

    #[test]
    fn a_missing_entry_is_noticed() {
        let mut wallet = filled();
        wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", "c2:1") }]).unwrap();
        wallet.commit(vec![Change::PutUtxo { utxo: utxo("a", "c3:2") }]).unwrap();
        wallet.backend.batches.remove(&2);
        let error = Persisted::open(wallet.backend).err().unwrap().to_string();
        assert!(error.contains("entry 2 is missing"), "{error}");
    }

    #[test]
    fn an_entry_from_a_newer_build_is_refused_and_named_as_such() {
        let mut wallet = filled();
        let newer = json!({ "format": FORMAT + 1, "seq": 2, "kind": "changes", "changes": [{ "op": "somethingNew" }] });
        wallet.backend.batches.insert(2, serde_json::to_vec(&newer).unwrap());
        let error = Persisted::open(wallet.backend).err().unwrap().to_string();
        assert!(error.starts_with(NEWER_FORMAT), "{error}");
    }

    #[test]
    fn a_batch_prepared_against_an_older_state_is_refused() {
        let mut store = Store::default();
        let first = store.prepare(vec![Change::PutAccount { account: account("a") }]).unwrap();
        let stale = store.prepare(vec![Change::PutAccount { account: account("b") }]).unwrap();
        store.confirm(first).unwrap();
        assert!(store.confirm(stale).is_err());
        assert!(!store.state().accounts.contains_key("b"));
    }

    #[test]
    fn the_written_form_names_its_fields_as_the_app_does() {
        let store = Store::default();
        let prepared = store.prepare(vec![Change::PutAccount { account: account("a") }]).unwrap();
        let written: Value = serde_json::from_slice(&prepared.bytes).unwrap();
        assert_eq!(written["format"], json!(FORMAT));
        assert_eq!(written["kind"], json!("changes"));
        assert_eq!(written["changes"][0]["op"], json!("putAccount"));
        assert_eq!(written["changes"][0]["account"]["birthdayHeight"], json!(100));
    }
}
