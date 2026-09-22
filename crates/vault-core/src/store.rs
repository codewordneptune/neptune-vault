//! The wallet's data, held by the engine rather than by the app.
//!
//! There are two kinds of log. The device log is readable by anyone who can
//! read the disk, and holds only what a lock screen needs: which wallets
//! exist, their sealed seeds, and the device's settings. Each wallet then
//! has a log of its own, sealed under a key that exists only while that
//! wallet is unlocked, and everything a wallet knows is in there: coins,
//! history, contacts, addresses, how far it has scanned. A locked wallet
//! on disk says that it exists and nothing else.
//!
//! State lives in memory. Nothing edits it in place: every edit is a typed
//! change, changes travel in batches, and a batch is applied only after it
//! has been written down. What is written is an append-only log of batches
//! with an occasional snapshot, so the storage underneath needs no opinions
//! about wallets. It keeps numbered byte strings per log and gives them
//! back. A SQLite file does that on a device and IndexedDB in a browser,
//! which is what lets one engine serve both.
//!
//! The order is prepare, write, confirm. [`Log::prepare`] checks a batch and
//! serialises it without touching the state; the host writes the bytes,
//! however long that takes; [`Log::confirm`] then applies it. A write that
//! fails leaves memory and storage agreeing, because memory was never ahead.
//! The split exists for the browser, where writing is asynchronous and the
//! engine cannot wait on it. [`Persisted`] runs the three steps in one call
//! for hosts whose storage answers at once.
//!
//! What sealing does not do: someone who can write to the disk can cut the
//! newest entries off a log, and the wallet will open as it was before
//! them. Every entry is bound to its log and its number, so entries cannot
//! be altered, reordered, or moved between wallets, but noticing a missing
//! tail needs a counter kept somewhere the attacker cannot reach, and this
//! has none. What is lost that way is rebuilt by the next scan.

use std::collections::BTreeMap;

use aes_gcm::aead::Aead;
use aes_gcm::aead::KeyInit;
use aes_gcm::aead::Payload;
use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use hkdf::Hkdf;
use rand::Rng;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::scan::NextKeyIndices;

/// The format this build writes. An entry with a higher number was written
/// by a newer build and is refused: reading it would drop what this build
/// does not know about, and the next write would make the loss permanent.
pub const FORMAT: u32 = 1;

/// How the refusal of a newer format starts, for the app to recognise.
pub const NEWER_FORMAT: &str = "store: written by a newer version";

/// The name of the one log that is not sealed.
pub const DEVICE_LOG: &str = "device";

/// The name of a wallet's log.
pub fn wallet_log(wallet_id: &str) -> String {
    format!("wallet:{wallet_id}")
}

// ---------------------------------------------------------------------------
// The device: readable while everything is locked
// ---------------------------------------------------------------------------

/// What a lock screen needs to know about a wallet, and no more. Its name,
/// so a person can pick it; its sealed seed, so a password can open it.
/// Not its address: an address on disk ties the device to the chain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletHeader {
    pub id: String,
    pub network: String,
    pub created_at: u64,
    /// The sealed seed. Opaque here: the store keeps it and never opens it.
    pub envelope: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Passkey unlock: the content key wrapped under the passkey's secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passkey: Option<Value>,
}

/// Per device, not per wallet: node addresses, the lock timeout, the theme.
/// The app's to read; the engine only needs to know which wallet is current.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub network: String,
    pub current_account_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceState {
    pub settings: Option<Settings>,
    pub wallets: BTreeMap<String, WalletHeader>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DeviceChange {
    PutSettings { settings: Settings },
    PutWallet { header: WalletHeader },
    DeleteWallet { id: String },
}

// ---------------------------------------------------------------------------
// A wallet: sealed until it is unlocked
// ---------------------------------------------------------------------------

/// The part of a wallet's own record that says something about it, other
/// than how it is scanned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletDetails {
    /// Address of key 0.
    pub address0: String,
    #[serde(default)]
    pub backup_confirmed: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// How a wallet is scanned: where its history starts, which keys to watch,
/// and whether a restore through the node's coin index is due. The sync
/// writes these in the same breath as the coins it finds, so they are kept
/// with the coins and not with the rest of the wallet's record: a key
/// counter that fell behind its coins would leave later payments unseen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    /// First height worth scanning; 0 is "unknown" and becomes the tip at first sync.
    pub birthday_height: u64,
    /// The next unused derivation index per key kind, advanced by scanning.
    pub next_key_indices: NextKeyIndices,
    /// `fast` while a restore through the node's coin index is due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<String>,
    /// When the wallet was last rebuilt through the coin index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_at: Option<u64>,
}

/// A coin, with the bookkeeping the wallet keeps about it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Utxo {
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
    /// Last height fully scanned, or birthday minus one: -1 when the wallet
    /// has rolled back to before the first block.
    pub synced_height: i64,
    pub synced_hash: Option<String>,
    pub updated_at: u64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WalletState {
    pub details: Option<WalletDetails>,
    #[serde(default)]
    pub scan: Option<ScanState>,
    pub sync: Option<SyncState>,
    /// By coin key.
    pub utxos: BTreeMap<String, Utxo>,
    /// By height.
    pub blocks: BTreeMap<u64, Block>,
    /// By entry key.
    pub history: BTreeMap<String, HistoryEntry>,
    /// By contact id.
    pub contacts: BTreeMap<String, Contact>,
    /// What the app keeps about this wallet that must not be readable while
    /// it is locked, by name: the last failed send, with its amount and
    /// recipient, is the first of these.
    pub private: BTreeMap<String, Value>,
    /// Which parts of this wallet have moved here from the app's old
    /// database and are now kept here and nowhere else. The app moves over
    /// one part at a time; a part that is not named is still read from
    /// where it always was.
    #[serde(default)]
    pub migrated: std::collections::BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum WalletChange {
    PutDetails { details: WalletDetails },
    PutScan { scan: ScanState },
    /// Forget what scanning found (coins, blocks, history, position) and keep
    /// what a person made (details, contacts): a rescan starts here.
    Reset,
    PutSync { sync: SyncState },
    PutUtxo { utxo: Utxo },
    DeleteUtxo { hash: String },
    PutBlock { block: Block },
    /// A reorganisation: blocks above the fork point are no longer true.
    /// Below zero, that is every block.
    DeleteBlocksAbove { height: i64 },
    /// Trimming: blocks this old no longer help measure a reorganisation.
    DeleteBlocksUpTo { height: u64 },
    PutHistory { entry: HistoryEntry },
    DeleteHistory { key: String },
    PutContact { contact: Contact },
    DeleteContact { id: String },
    PutPrivate { key: String, value: Value },
    DeletePrivate { key: String },
    /// From here on this part of the wallet lives in this log.
    MarkMigrated { part: String },
}

// ---------------------------------------------------------------------------
// What a log is a log of
// ---------------------------------------------------------------------------

/// A state and the changes that can be made to it.
pub trait Model: Default + Clone + Serialize + DeserializeOwned {
    type Change: Clone + Serialize + DeserializeOwned;

    /// Whether the batch can be applied. Refusing here refuses it whole.
    fn check(&self, changes: &[Self::Change]) -> Result<()>;

    /// Apply a checked batch. Cannot fail, which is the point of checking
    /// first: a batch is applied whole or not at all.
    fn apply(&mut self, changes: Vec<Self::Change>);
}

impl Model for DeviceState {
    type Change = DeviceChange;

    fn check(&self, changes: &[DeviceChange]) -> Result<()> {
        let mut known: std::collections::BTreeSet<&str> =
            self.wallets.keys().map(String::as_str).collect();
        for change in changes {
            match change {
                DeviceChange::PutSettings { .. } => {}
                DeviceChange::PutWallet { header } => {
                    known.insert(&header.id);
                }
                DeviceChange::DeleteWallet { id } => {
                    if !known.remove(id.as_str()) {
                        bail!("store: no wallet {id} to delete");
                    }
                }
            }
        }
        Ok(())
    }

    fn apply(&mut self, changes: Vec<DeviceChange>) {
        for change in changes {
            match change {
                DeviceChange::PutSettings { settings } => self.settings = Some(settings),
                DeviceChange::PutWallet { header } => {
                    self.wallets.insert(header.id.clone(), header);
                }
                DeviceChange::DeleteWallet { id } => {
                    self.wallets.remove(&id);
                }
            }
        }
    }
}

impl Model for WalletState {
    type Change = WalletChange;

    /// Everything in a wallet's log belongs to that wallet by being in it,
    /// so there is nothing a change could point at that might not exist.
    fn check(&self, _changes: &[WalletChange]) -> Result<()> {
        Ok(())
    }

    fn apply(&mut self, changes: Vec<WalletChange>) {
        for change in changes {
            match change {
                WalletChange::PutDetails { details } => self.details = Some(details),
                WalletChange::PutScan { scan } => self.scan = Some(scan),
                WalletChange::Reset => {
                    self.sync = None;
                    self.utxos.clear();
                    self.blocks.clear();
                    self.history.clear();
                }
                WalletChange::PutSync { sync } => self.sync = Some(sync),
                WalletChange::PutUtxo { utxo } => {
                    self.utxos.insert(utxo.hash.clone(), utxo);
                }
                WalletChange::DeleteUtxo { hash } => {
                    self.utxos.remove(&hash);
                }
                WalletChange::PutBlock { block } => {
                    self.blocks.insert(block.height, block);
                }
                WalletChange::DeleteBlocksAbove { height } => match u64::try_from(height) {
                    Ok(height) => {
                        self.blocks.split_off(&height.saturating_add(1));
                    }
                    Err(_) => self.blocks.clear(),
                },
                WalletChange::DeleteBlocksUpTo { height } => {
                    self.blocks = self.blocks.split_off(&height.saturating_add(1));
                }
                WalletChange::PutHistory { entry } => {
                    self.history.insert(entry.key.clone(), entry);
                }
                WalletChange::DeleteHistory { key } => {
                    self.history.remove(&key);
                }
                WalletChange::PutContact { contact } => {
                    self.contacts.insert(contact.id.clone(), contact);
                }
                WalletChange::DeleteContact { id } => {
                    self.contacts.remove(&id);
                }
                WalletChange::PutPrivate { key, value } => {
                    self.private.insert(key, value);
                }
                WalletChange::DeletePrivate { key } => {
                    self.private.remove(&key);
                }
                WalletChange::MarkMigrated { part } => {
                    self.migrated.insert(part);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/// The key a wallet's log is sealed under. Derived from the wallet's content
/// key, never the content key itself: that one opens the seed, and a key
/// should have one job. Wiped when dropped, which is when the wallet locks.
pub struct LogKey(Zeroizing<[u8; 32]>);

impl LogKey {
    /// From the content key the seed envelope protects. The wallet's id goes
    /// into the derivation, so two wallets that somehow shared a content key
    /// would still not share a log key.
    pub fn derive(content_key: &[u8], wallet_id: &str) -> Result<LogKey> {
        if content_key.len() != 32 {
            bail!("store: a content key is 32 bytes");
        }
        let hkdf = Hkdf::<Sha256>::new(Some(b"neptune-vault"), content_key);
        let mut key = Zeroizing::new([0u8; 32]);
        hkdf.expand(format!("wallet log key v1:{wallet_id}").as_bytes(), key.as_mut())
            .map_err(|_| anyhow!("store: cannot derive the log key"))?;
        Ok(LogKey(key))
    }
}

impl std::fmt::Debug for LogKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogKey(..)")
    }
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    iv: String,
    ciphertext: String,
}

/// What an entry's seal is bound to: moving it to another log, another
/// number or another kind makes it fail to open.
fn binding(log: &str, seq: u64, kind: &str) -> Vec<u8> {
    format!("neptune-vault log v{FORMAT}|{log}|{seq}|{kind}").into_bytes()
}

fn seal(key: &LogKey, aad: &[u8], plaintext: &[u8]) -> Result<Sealed> {
    let iv: [u8; 12] = rand::rng().random();
    let ciphertext = Aes256Gcm::new(key.0.as_ref().into())
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plaintext, aad })
        .map_err(|_| anyhow!("store: cannot seal the entry"))?;
    Ok(Sealed { iv: BASE64.encode(iv), ciphertext: BASE64.encode(ciphertext) })
}

fn unseal(key: &LogKey, aad: &[u8], sealed: &Sealed, seq: u64) -> Result<Zeroizing<Vec<u8>>> {
    let damaged = || anyhow!("store: entry {seq} does not open: it was changed, moved, or sealed under another key");
    let iv = BASE64.decode(&sealed.iv).map_err(|_| damaged())?;
    let ciphertext = BASE64.decode(&sealed.ciphertext).map_err(|_| damaged())?;
    if iv.len() != 12 {
        return Err(damaged());
    }
    Aes256Gcm::new(key.0.as_ref().into())
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &ciphertext, aad })
        .map(Zeroizing::new)
        .map_err(|_| damaged())
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/// What an entry holds: a batch of changes, or the whole state as of a batch.
#[derive(Serialize, Deserialize)]
#[serde(bound = "")]
struct Body<M: Model> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    changes: Option<Vec<M::Change>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<M>,
}

/// One numbered entry of a log, as written. JSON, because the fields are
/// named in it: a format that goes by position breaks the day a field is
/// added. The format, number and kind are always in the clear, so that a
/// newer entry is recognised as newer before anything tries to open it; the
/// body is in the clear for the device and sealed for a wallet. The shape is
/// deliberately plain and not a tagged enum: serde reads those through a
/// buffer in which the state's integer keys (blocks by height) stop being
/// integers.
#[derive(Serialize, Deserialize)]
struct Entry {
    format: u32,
    seq: u64,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed: Option<Sealed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<Value>,
}

/// Only what every format will always have.
#[derive(Deserialize)]
struct Header {
    format: u32,
}

const CHANGES: &str = "changes";
const SNAPSHOT: &str = "snapshot";

/// A batch that has been checked and serialised and is waiting to be
/// written. Hand `bytes` to storage under `seq`, then give this back to
/// [`Log::confirm`].
#[derive(Debug)]
pub struct Prepared<M: Model> {
    pub seq: u64,
    pub bytes: Vec<u8>,
    changes: Vec<M::Change>,
}

/// A state, its position in its log, and the key the log is sealed under.
#[derive(Debug)]
pub struct Log<M: Model> {
    name: String,
    key: Option<LogKey>,
    state: M,
    /// The number of the last entry applied; 0 before the first.
    seq: u64,
}

impl<M: Model> Log<M> {
    /// Rebuild the state from what storage holds, in any order. The newest
    /// snapshot is the starting point and every later batch is replayed over
    /// it. Older entries are ignored, because compaction writes the snapshot
    /// before it deletes what the snapshot covers, and a crash between the
    /// two leaves both. `key` is None for the device log and the wallet's
    /// key for a wallet's.
    pub fn open(name: &str, key: Option<LogKey>, entries: Vec<Vec<u8>>) -> Result<Log<M>> {
        let mut log = Log { name: name.to_string(), key, state: M::default(), seq: 0 };
        let mut parsed = Vec::with_capacity(entries.len());
        for bytes in &entries {
            let header: Header =
                serde_json::from_slice(bytes).context("store: an entry is not readable")?;
            if header.format > FORMAT {
                bail!("{NEWER_FORMAT} (format {}, this build reads {FORMAT})", header.format);
            }
            let entry: Entry =
                serde_json::from_slice(bytes).context("store: an entry is not readable")?;
            parsed.push(entry);
        }
        // A snapshot sorts after the batch it is numbered as, since it includes it.
        parsed.sort_by_key(|e| (e.seq, e.kind == SNAPSHOT));
        let start = parsed.iter().rposition(|e| e.kind == SNAPSHOT).unwrap_or(0);

        for entry in parsed.into_iter().skip(start) {
            let seq = entry.seq;
            let body = log.read_body(&entry)?;
            match (entry.kind.as_str(), body.changes, body.state) {
                (SNAPSHOT, None, Some(state)) => {
                    log.state = state;
                    log.seq = seq;
                }
                (CHANGES, Some(changes), None) => {
                    if seq != log.seq + 1 {
                        bail!("store: entry {} is missing; the log goes from {} to {seq}", log.seq + 1, log.seq);
                    }
                    log.state
                        .check(&changes)
                        .with_context(|| format!("store: entry {seq} does not apply"))?;
                    log.state.apply(changes);
                    log.seq = seq;
                }
                (kind, _, _) => bail!("store: entry {seq} is not a well-formed {kind}"),
            }
        }
        Ok(log)
    }

    fn read_body(&self, entry: &Entry) -> Result<Body<M>> {
        let seq = entry.seq;
        match (&self.key, &entry.sealed, &entry.body) {
            (Some(key), Some(sealed), None) => {
                let plain = unseal(key, &binding(&self.name, seq, &entry.kind), sealed, seq)?;
                serde_json::from_slice(&plain).with_context(|| format!("store: entry {seq} is not readable"))
            }
            (None, None, Some(body)) => serde_json::from_value(body.clone())
                .with_context(|| format!("store: entry {seq} is not readable")),
            // A sealed log with an entry in the clear, or the reverse, is a
            // log someone has been writing into.
            (Some(_), _, _) => bail!("store: entry {seq} of a sealed log is not sealed"),
            (None, _, _) => bail!("store: entry {seq} is sealed and this log has no key"),
        }
    }

    fn write(&self, seq: u64, kind: &str, body: &Body<M>) -> Result<Vec<u8>> {
        let (sealed, body) = match &self.key {
            Some(key) => {
                let plain = Zeroizing::new(serde_json::to_vec(body).context("store: cannot serialise")?);
                (Some(seal(key, &binding(&self.name, seq, kind), &plain)?), None)
            }
            None => (None, Some(serde_json::to_value(body).context("store: cannot serialise")?)),
        };
        let entry = Entry { format: FORMAT, seq, kind: kind.to_string(), sealed, body };
        serde_json::to_vec(&entry).context("store: cannot serialise")
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn state(&self) -> &M {
        &self.state
    }

    /// The number of the last entry applied.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Check a batch and serialise it, changing nothing.
    pub fn prepare(&self, changes: Vec<M::Change>) -> Result<Prepared<M>> {
        self.state.check(&changes)?;
        let seq = self.seq + 1;
        let body = Body { changes: Some(changes), state: None };
        let bytes = self.write(seq, CHANGES, &body)?;
        let changes = body.changes.expect("built as a batch just above");
        Ok(Prepared { seq, bytes, changes })
    }

    /// What the state would be with this batch applied, without applying it:
    /// for checking a migration before a byte of it is written.
    pub fn preview(&self, changes: &[M::Change]) -> Result<M> {
        self.state.check(changes)?;
        let mut state = self.state.clone();
        state.apply(changes.to_vec());
        Ok(state)
    }

    /// Apply a batch that storage now holds. Batches are confirmed in the
    /// order they were prepared; one prepared against an older state is
    /// refused, since what it was checked against is no longer true.
    pub fn confirm(&mut self, prepared: Prepared<M>) -> Result<()> {
        if prepared.seq != self.seq + 1 {
            bail!("store: batch {} was prepared before batch {} was confirmed", prepared.seq, self.seq);
        }
        self.state.apply(prepared.changes);
        self.seq = prepared.seq;
        Ok(())
    }

    /// The whole state as one entry, numbered as the last batch it includes.
    /// Once storage holds it, every entry up to that number can go.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        self.write(self.seq, SNAPSHOT, &Body { changes: None, state: Some(self.state.clone()) })
    }
}

// ---------------------------------------------------------------------------
// Storage that answers at once
// ---------------------------------------------------------------------------

/// Storage as the engine needs it: numbered byte strings, kept per log.
/// It is told nothing about what the bytes mean.
pub trait Persist {
    /// The names of every log held.
    fn logs(&mut self) -> Result<Vec<String>>;
    /// Every entry of one log, in any order. Empty when there is no such log.
    fn load(&mut self, log: &str) -> Result<Vec<Vec<u8>>>;
    /// Keep `bytes` as entry `seq` of `log`. Durable by the time this returns.
    fn append(&mut self, log: &str, seq: u64, bytes: &[u8]) -> Result<()>;
    /// Keep `snapshot` as of `seq`, then drop every batch up to `seq`. In
    /// that order: a crash between the two leaves too much, never too little.
    fn compact(&mut self, log: &str, seq: u64, snapshot: &[u8]) -> Result<()>;
    /// Forget a log entirely.
    fn remove(&mut self, log: &str) -> Result<()>;
}

/// Batches kept between snapshots before a log is folded into a new one.
pub const COMPACT_EVERY: u64 = 256;

struct Open<M: Model> {
    log: Log<M>,
    since_snapshot: u64,
}

/// The device, the wallets that are unlocked, and the storage under them,
/// for hosts whose storage is synchronous.
pub struct Persisted<P: Persist> {
    backend: P,
    device: Open<DeviceState>,
    unlocked: BTreeMap<String, Open<WalletState>>,
}

fn commit<M: Model, P: Persist>(backend: &mut P, open: &mut Open<M>, changes: Vec<M::Change>) -> Result<()> {
    let prepared = open.log.prepare(changes)?;
    backend.append(open.log.name(), prepared.seq, &prepared.bytes)?;
    open.log.confirm(prepared)?;
    open.since_snapshot += 1;
    if open.since_snapshot >= COMPACT_EVERY {
        // Best effort: a log that is longer than it needs to be is still a
        // correct log, so failing to shorten it is not a failed commit.
        if let Ok(snapshot) = open.log.snapshot() {
            if backend.compact(open.log.name(), open.log.seq(), &snapshot).is_ok() {
                open.since_snapshot = 0;
            }
        }
    }
    Ok(())
}

impl<P: Persist> Persisted<P> {
    /// Read the device log, and clear away any wallet log whose wallet is
    /// gone: deleting a wallet removes it from the device first and drops
    /// its log second, so a crash between the two leaves a log nobody can
    /// reach, and this is where it goes.
    pub fn open(mut backend: P) -> Result<Self> {
        let entries = backend.load(DEVICE_LOG)?;
        let since_snapshot = entries.len() as u64;
        let device = Log::<DeviceState>::open(DEVICE_LOG, None, entries)?;
        for name in backend.logs()? {
            if let Some(id) = name.strip_prefix("wallet:") {
                if !device.state().wallets.contains_key(id) {
                    backend.remove(&name)?;
                }
            }
        }
        Ok(Self { backend, device: Open { log: device, since_snapshot }, unlocked: BTreeMap::new() })
    }

    pub fn device(&self) -> &DeviceState {
        self.device.log.state()
    }

    pub fn commit_device(&mut self, changes: Vec<DeviceChange>) -> Result<()> {
        if changes.iter().any(|c| matches!(c, DeviceChange::DeleteWallet { .. })) {
            bail!("store: a wallet is deleted with delete_wallet, which also drops its log");
        }
        commit(&mut self.backend, &mut self.device, changes)
    }

    /// Read a wallet's log into memory under its key. Fails when the key is
    /// wrong, which with a key derived from the right content key means the
    /// log was damaged or swapped.
    pub fn unlock(&mut self, wallet_id: &str, key: LogKey) -> Result<()> {
        if !self.device().wallets.contains_key(wallet_id) {
            bail!("store: no wallet {wallet_id}");
        }
        let name = wallet_log(wallet_id);
        let entries = self.backend.load(&name)?;
        let since_snapshot = entries.len() as u64;
        let log = Log::<WalletState>::open(&name, Some(key), entries)?;
        self.unlocked.insert(wallet_id.to_string(), Open { log, since_snapshot });
        Ok(())
    }

    /// Drop a wallet's state and key from memory.
    pub fn lock(&mut self, wallet_id: &str) {
        self.unlocked.remove(wallet_id);
    }

    pub fn lock_all(&mut self) {
        self.unlocked.clear();
    }

    /// An unlocked wallet's state; None while it is locked.
    pub fn wallet(&self, wallet_id: &str) -> Option<&WalletState> {
        self.unlocked.get(wallet_id).map(|open| open.log.state())
    }

    pub fn commit_wallet(&mut self, wallet_id: &str, changes: Vec<WalletChange>) -> Result<()> {
        let open = self
            .unlocked
            .get_mut(wallet_id)
            .ok_or_else(|| anyhow!("store: wallet {wallet_id} is locked"))?;
        commit(&mut self.backend, open, changes)
    }

    /// Remove a wallet from the device, then drop its log.
    pub fn delete_wallet(&mut self, wallet_id: &str) -> Result<()> {
        commit(&mut self.backend, &mut self.device, vec![DeviceChange::DeleteWallet { id: wallet_id.to_string() }])?;
        self.unlocked.remove(wallet_id);
        self.backend.remove(&wallet_log(wallet_id))
    }
}

/// Storage in memory, for tests and for hosts with nowhere to write.
#[derive(Default)]
pub struct MemoryPersist {
    /// Per log: batches by number, and the snapshot if one was taken.
    pub logs: BTreeMap<String, (BTreeMap<u64, Vec<u8>>, Option<Vec<u8>>)>,
    /// Make the next append fail, to test that a failed write changes nothing.
    pub fail_next_append: bool,
    /// Make the next removal fail, to stand in for a crash after a wallet
    /// left the device and before its log was dropped.
    pub fail_next_remove: bool,
}

impl Persist for MemoryPersist {
    fn logs(&mut self) -> Result<Vec<String>> {
        Ok(self.logs.keys().cloned().collect())
    }

    fn load(&mut self, log: &str) -> Result<Vec<Vec<u8>>> {
        let Some((batches, snapshot)) = self.logs.get(log) else { return Ok(Vec::new()) };
        Ok(batches.values().cloned().chain(snapshot.clone()).collect())
    }

    fn append(&mut self, log: &str, seq: u64, bytes: &[u8]) -> Result<()> {
        if std::mem::take(&mut self.fail_next_append) {
            bail!("the disk is full");
        }
        self.logs.entry(log.to_string()).or_default().0.insert(seq, bytes.to_vec());
        Ok(())
    }

    fn compact(&mut self, log: &str, seq: u64, snapshot: &[u8]) -> Result<()> {
        let held = self.logs.entry(log.to_string()).or_default();
        held.1 = Some(snapshot.to_vec());
        held.0 = held.0.split_off(&(seq + 1));
        Ok(())
    }

    fn remove(&mut self, log: &str) -> Result<()> {
        if std::mem::take(&mut self.fail_next_remove) {
            bail!("the power went");
        }
        self.logs.remove(log);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(n: u8) -> LogKey {
        LogKey::derive(&[n; 32], "a").unwrap()
    }

    fn header(id: &str) -> WalletHeader {
        serde_json::from_value(json!({
            "id": id, "network": "main", "createdAt": 1,
            "envelope": { "version": 1 }, "name": "Savings"
        }))
        .unwrap()
    }

    fn details() -> WalletDetails {
        serde_json::from_value(json!({
            "address0": "nolgam1secretaddress",
            "backupConfirmed": true,
            "lastBackupAt": 42
        }))
        .unwrap()
    }

    fn utxo(hash: &str) -> Utxo {
        serde_json::from_value(json!({
            "key": format!("a:{hash}"), "accountId": "a", "hash": hash,
            "stored": { "hash": hash, "recovery": { "aocl_index": 7 } },
            "amountNau": "5", "amount": "0.0000005",
            "confirmedHeight": 120, "confirmedTimestampMs": 9,
            "releaseDateMs": null, "spentHeight": null, "spentTxid": null, "pendingTxid": null
        }))
        .unwrap()
    }

    fn block(height: u64) -> Block {
        Block { height, hash: format!("h{height}"), prev_hash: format!("h{}", height - 1), timestamp_ms: height, extra: Map::new() }
    }

    fn contact(id: &str) -> Contact {
        Contact { id: id.to_string(), name: "Alice Recipient".to_string(), address: "nolgam1xyz".to_string(), extra: Map::new() }
    }

    /// A device with one wallet, unlocked, with a little of everything in it.
    fn filled() -> Persisted<MemoryPersist> {
        let mut vault = Persisted::open(MemoryPersist::default()).unwrap();
        vault.commit_device(vec![DeviceChange::PutWallet { header: header("a") }]).unwrap();
        vault.unlock("a", key(1)).unwrap();
        vault
            .commit_wallet("a", vec![
                WalletChange::PutDetails { details: details() },
                WalletChange::PutUtxo { utxo: utxo("c1:0") },
                WalletChange::PutBlock { block: block(120) },
                WalletChange::PutBlock { block: block(121) },
                WalletChange::PutContact { contact: contact("k1") },
            ])
            .unwrap();
        vault
    }

    fn reopened(vault: Persisted<MemoryPersist>) -> Persisted<MemoryPersist> {
        Persisted::open(vault.backend).unwrap()
    }

    #[test]
    fn what_was_committed_is_there_after_reopening_and_unlocking() {
        let vault = filled();
        let before = vault.wallet("a").unwrap().clone();
        let mut again = reopened(vault);
        assert_eq!(again.device().wallets["a"].name.as_deref(), Some("Savings"));
        assert!(again.wallet("a").is_none(), "a wallet is locked until it is unlocked");
        again.unlock("a", key(1)).unwrap();
        assert_eq!(again.wallet("a").unwrap(), &before);
    }

    #[test]
    fn a_locked_wallet_on_disk_says_that_it_exists_and_nothing_else() {
        let vault = filled();
        let mut all = Vec::new();
        for (batches, snapshot) in vault.backend.logs.values() {
            for bytes in batches.values().chain(snapshot.iter()) {
                all.extend_from_slice(bytes);
            }
        }
        let disk = String::from_utf8_lossy(&all);
        assert!(disk.contains("Savings"), "the lock screen needs the name");
        for secret in ["nolgam1secretaddress", "Alice Recipient", "nolgam1xyz", "c1:0", "amountNau", "h120"] {
            assert!(!disk.contains(secret), "{secret} is readable on disk");
        }
    }

    #[test]
    fn the_wrong_key_opens_nothing() {
        let mut again = reopened(filled());
        let error = again.unlock("a", key(2)).unwrap_err().to_string();
        assert!(error.contains("does not open"), "{error}");
        assert!(again.wallet("a").is_none());
    }

    #[test]
    fn an_entry_moved_to_another_number_or_another_wallet_does_not_open() {
        let mut vault = filled();
        vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c2:1") }]).unwrap();

        // Swap the numbers of two entries of the same log.
        let mut swapped = MemoryPersist::default();
        swapped.logs = vault.backend.logs.clone();
        let batches = &mut swapped.logs.get_mut("wallet:a").unwrap().0;
        let (first, second) = (batches[&1].clone(), batches[&2].clone());
        let renumber = |bytes: &[u8], seq: u64| {
            let mut v: Value = serde_json::from_slice(bytes).unwrap();
            v["seq"] = json!(seq);
            serde_json::to_vec(&v).unwrap()
        };
        batches.insert(1, renumber(&second, 1));
        batches.insert(2, renumber(&first, 2));
        let mut again = Persisted::open(swapped).unwrap();
        assert!(again.unlock("a", key(1)).is_err());

        // Give one wallet's log to another wallet sealed under the same key.
        // The other wallet has to exist first, or its log is swept as an orphan.
        vault.commit_device(vec![DeviceChange::PutWallet { header: header("b") }]).unwrap();
        let mut moved = MemoryPersist::default();
        moved.logs = vault.backend.logs.clone();
        let log = moved.logs["wallet:a"].clone();
        moved.logs.insert("wallet:b".into(), log);
        let mut again = Persisted::open(moved).unwrap();
        assert!(again.backend.logs.contains_key("wallet:b"));
        assert!(again.unlock("b", key(1)).is_err());
        again.unlock("a", key(1)).unwrap();
    }

    #[test]
    fn an_entry_in_the_clear_inside_a_sealed_log_is_refused() {
        let mut vault = filled();
        let forged = json!({ "format": FORMAT, "seq": 2, "kind": "changes", "body": { "changes": [{ "op": "reset" }] } });
        vault.backend.logs.get_mut("wallet:a").unwrap().0.insert(2, serde_json::to_vec(&forged).unwrap());
        let mut again = reopened(vault);
        let error = again.unlock("a", key(1)).unwrap_err().to_string();
        assert!(error.contains("is not sealed"), "{error}");
    }

    #[test]
    fn the_log_key_is_not_the_content_key_and_differs_per_wallet() {
        let content = [7u8; 32];
        let a = LogKey::derive(&content, "a").unwrap();
        let b = LogKey::derive(&content, "b").unwrap();
        assert_ne!(a.0.as_ref(), &content);
        assert_ne!(a.0.as_ref(), b.0.as_ref());
        assert!(LogKey::derive(&[0u8; 16], "a").is_err());
    }

    #[test]
    fn fields_the_engine_has_no_use_for_are_written_back_untouched() {
        let vault = filled();
        let wallet = vault.wallet("a").unwrap();
        assert_eq!(wallet.details.as_ref().unwrap().extra["lastBackupAt"], json!(42));
        assert_eq!(wallet.utxos["c1:0"].extra["key"], json!("a:c1:0"));
        let round = serde_json::to_value(&wallet.utxos["c1:0"]).unwrap();
        assert_eq!(round["accountId"], json!("a"));
    }

    #[test]
    fn deleting_a_wallet_takes_its_log_and_leaves_the_others() {
        let mut vault = filled();
        vault.commit_device(vec![DeviceChange::PutWallet { header: header("b") }]).unwrap();
        vault.delete_wallet("a").unwrap();
        assert!(!vault.device().wallets.contains_key("a"));
        assert!(vault.wallet("a").is_none());
        assert!(!vault.backend.logs.contains_key("wallet:a"));
        assert!(vault.device().wallets.contains_key("b"));
    }

    #[test]
    fn a_crash_between_leaving_the_device_and_dropping_the_log_is_swept_up() {
        let mut vault = filled();
        vault.backend.fail_next_remove = true;
        assert!(vault.delete_wallet("a").is_err());
        assert!(vault.backend.logs.contains_key("wallet:a"), "the log outlived its wallet");
        let again = reopened(vault);
        assert!(!again.device().wallets.contains_key("a"));
        assert!(!again.backend.logs.contains_key("wallet:a"));
    }

    #[test]
    fn a_wallet_cannot_be_deleted_by_the_back_door() {
        let mut vault = filled();
        assert!(vault.commit_device(vec![DeviceChange::DeleteWallet { id: "a".into() }]).is_err());
        assert!(vault.device().wallets.contains_key("a"));
    }

    #[test]
    fn a_reset_forgets_what_scanning_found_and_keeps_what_a_person_made() {
        let mut vault = filled();
        vault.commit_wallet("a", vec![WalletChange::Reset]).unwrap();
        let wallet = vault.wallet("a").unwrap();
        assert!(wallet.utxos.is_empty() && wallet.blocks.is_empty() && wallet.sync.is_none());
        assert_eq!(wallet.contacts.len(), 1);
        assert!(wallet.details.is_some());
    }

    #[test]
    fn a_locked_wallet_takes_no_changes() {
        let mut vault = filled();
        vault.lock("a");
        let error = vault.commit_wallet("a", vec![WalletChange::Reset]).unwrap_err().to_string();
        assert!(error.contains("locked"), "{error}");
    }

    #[test]
    fn a_write_that_fails_changes_nothing() {
        let mut vault = filled();
        let before = vault.wallet("a").unwrap().clone();
        vault.backend.fail_next_append = true;
        assert!(vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c2:1") }]).is_err());
        assert_eq!(vault.wallet("a").unwrap(), &before);
        // And the next one goes through under the number the failed one had.
        vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c2:1") }]).unwrap();
        assert_eq!(vault.wallet("a").unwrap().utxos.len(), 2);
    }

    #[test]
    fn a_reorganisation_and_a_trim_cut_the_blocks_from_either_end() {
        let mut vault = filled();
        vault.commit_wallet("a", vec![WalletChange::PutBlock { block: block(122) }]).unwrap();
        vault.commit_wallet("a", vec![WalletChange::DeleteBlocksAbove { height: 121 }]).unwrap();
        assert_eq!(vault.wallet("a").unwrap().blocks.keys().copied().collect::<Vec<_>>(), [120, 121]);
        vault.commit_wallet("a", vec![WalletChange::DeleteBlocksUpTo { height: 120 }]).unwrap();
        assert_eq!(vault.wallet("a").unwrap().blocks.keys().copied().collect::<Vec<_>>(), [121]);
    }

    #[test]
    fn compaction_keeps_the_state_and_shortens_the_log() {
        let mut vault = filled();
        for i in 0..COMPACT_EVERY {
            vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo(&format!("c:{i}")) }]).unwrap();
        }
        let (batches, snapshot) = &vault.backend.logs["wallet:a"];
        assert!(snapshot.is_some());
        assert!((batches.len() as u64) < COMPACT_EVERY);
        let before = vault.wallet("a").unwrap().clone();
        let mut again = reopened(vault);
        again.unlock("a", key(1)).unwrap();
        assert_eq!(again.wallet("a").unwrap(), &before);
    }

    #[test]
    fn a_crash_between_the_snapshot_and_the_trim_is_harmless() {
        let mut vault = filled();
        vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c2:1") }]).unwrap();
        let before = vault.wallet("a").unwrap().clone();
        // The snapshot was written and the entries it covers were never dropped.
        let snapshot = vault.unlocked["a"].log.snapshot().unwrap();
        vault.backend.logs.get_mut("wallet:a").unwrap().1 = Some(snapshot);
        let mut again = reopened(vault);
        again.unlock("a", key(1)).unwrap();
        assert_eq!(again.wallet("a").unwrap(), &before);
    }

    #[test]
    fn a_missing_entry_is_noticed() {
        let mut vault = filled();
        vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c2:1") }]).unwrap();
        vault.commit_wallet("a", vec![WalletChange::PutUtxo { utxo: utxo("c3:2") }]).unwrap();
        vault.backend.logs.get_mut("wallet:a").unwrap().0.remove(&2);
        let mut again = reopened(vault);
        let error = again.unlock("a", key(1)).unwrap_err().to_string();
        assert!(error.contains("entry 2 is missing"), "{error}");
    }

    #[test]
    fn an_entry_from_a_newer_build_is_refused_by_name_before_anything_opens_it() {
        let mut vault = filled();
        let newer = json!({ "format": FORMAT + 1, "seq": 2, "kind": "changes", "sealed": { "iv": "", "ciphertext": "" } });
        vault.backend.logs.get_mut("wallet:a").unwrap().0.insert(2, serde_json::to_vec(&newer).unwrap());
        let mut again = reopened(vault);
        let error = again.unlock("a", key(1)).unwrap_err().to_string();
        assert!(error.starts_with(NEWER_FORMAT), "{error}");
    }

    #[test]
    fn a_batch_prepared_against_an_older_state_is_refused() {
        let mut log = Log::<DeviceState>::open(DEVICE_LOG, None, Vec::new()).unwrap();
        let first = log.prepare(vec![DeviceChange::PutWallet { header: header("a") }]).unwrap();
        let stale = log.prepare(vec![DeviceChange::PutWallet { header: header("b") }]).unwrap();
        log.confirm(first).unwrap();
        assert!(log.confirm(stale).is_err());
        assert!(!log.state().wallets.contains_key("b"));
    }

    #[test]
    fn the_device_log_names_its_fields_as_the_app_does() {
        let log = Log::<DeviceState>::open(DEVICE_LOG, None, Vec::new()).unwrap();
        let prepared = log.prepare(vec![DeviceChange::PutWallet { header: header("a") }]).unwrap();
        let written: Value = serde_json::from_slice(&prepared.bytes).unwrap();
        assert_eq!(written["format"], json!(FORMAT));
        assert_eq!(written["kind"], json!("changes"));
        assert_eq!(written["body"]["changes"][0]["op"], json!("putWallet"));
        assert_eq!(written["body"]["changes"][0]["header"]["createdAt"], json!(1));
    }
}
