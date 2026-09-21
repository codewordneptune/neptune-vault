//! The engine's store, as a native shell runs it.
//!
//! The same logs, sealing, migration and ledger as the browser's, from the
//! same crate: only where the bytes go differs. In a browser they go to
//! IndexedDB, and the wallet worker keeps the order of things. Here they
//! go to files, and this keeps the order: an operation reads the wallet as
//! it is and decides, its batch is written down, only then does it take
//! effect, and the caller holds this store's lock throughout, so the next
//! operation begins only after.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use serde_json::Value;
use vault_core::account::Account;
use vault_core::ledger::op;
use vault_core::migrate;
use vault_core::store::wallet_log;
use vault_core::store::Log;
use vault_core::store::LogKey;
use vault_core::store::Persist;
use vault_core::store::Prepared;
use vault_core::store::WalletChange;
use vault_core::store::WalletState;
use vault_core::store::COMPACT_EVERY;
use zeroize::Zeroizing;

use crate::BridgeError;

type Result<T> = std::result::Result<T, BridgeError>;

fn locked() -> BridgeError {
    // Named as the browser's worker names it, so the app treats both alike.
    BridgeError::plain("wallet is locked")
}

struct Held {
    log: Log<WalletState>,
    since_snapshot: u64,
}

pub struct WalletStore {
    persist: Box<dyn Persist + Send>,
    content_key: Option<Zeroizing<Vec<u8>>>,
    logs: BTreeMap<String, Held>,
}

impl WalletStore {
    pub fn new(persist: Box<dyn Persist + Send>) -> Self {
        Self { persist, content_key: None, logs: BTreeMap::new() }
    }

    /// Keep the content key of the wallet just unlocked, or none on locking.
    /// Every open log goes with the old key.
    pub fn keep(&mut self, key: Option<Zeroizing<Vec<u8>>>) {
        self.content_key = key;
        self.logs.clear();
    }

    fn held(&mut self, wallet_id: &str) -> Result<&mut Held> {
        self.logs.get_mut(wallet_id).ok_or_else(locked)
    }

    /// Write a prepared batch, and only then let it take effect.
    fn write(persist: &mut dyn Persist, held: &mut Held, prepared: Prepared<WalletState>) -> Result<()> {
        persist.append(held.log.name(), prepared.seq, &prepared.bytes)?;
        held.log.confirm(prepared)?;
        held.since_snapshot += 1;
        if held.since_snapshot >= COMPACT_EVERY {
            // Best effort: a log longer than it needs to be is still correct.
            if let Ok(snapshot) = held.log.snapshot() {
                if persist.compact(held.log.name(), held.log.seq(), &snapshot).is_ok() {
                    held.since_snapshot = 0;
                }
            }
        }
        Ok(())
    }

    fn apply(&mut self, wallet_id: &str, changes: Vec<WalletChange>) -> Result<()> {
        if changes.is_empty() {
            return Ok(());
        }
        let Self { persist, logs, .. } = self;
        let held = logs.get_mut(wallet_id).ok_or_else(locked)?;
        let prepared = held.log.prepare(changes)?;
        Self::write(persist.as_mut(), held, prepared)
    }

    /// Open the unlocked wallet's log. Returns the parts that live in it.
    pub fn open(&mut self, wallet_id: &str) -> Result<Vec<String>> {
        if !self.logs.contains_key(wallet_id) {
            let content = self.content_key.as_ref().ok_or_else(locked)?;
            let key = LogKey::derive(content, wallet_id)?;
            let name = wallet_log(wallet_id);
            let entries = self.persist.load(&name)?;
            let since_snapshot = entries.len() as u64;
            let log = Log::open(&name, Some(key), entries)?;
            self.logs.insert(wallet_id.to_string(), Held { log, since_snapshot });
        }
        Ok(self.held(wallet_id)?.log.state().migrated.iter().cloned().collect())
    }

    /// Move parts over from the app's database, together, checked record for
    /// record against what they would become before a byte is written.
    pub fn migrate(&mut self, wallet_id: &str, parts: Vec<String>, dump: Value) -> Result<()> {
        let dump: migrate::Dump = serde_json::from_value(dump).map_err(|e| BridgeError::plain(format!("cannot decode the old database: {e}")))?;
        let held = self.held(wallet_id)?;
        let todo: Vec<&str> = parts.iter().map(String::as_str).filter(|p| !held.log.state().migrated.contains(*p)).collect();
        if todo.is_empty() {
            return Ok(());
        }
        let changes = migrate::parts_changes(&dump, wallet_id, &todo)?;
        let would_be = held.log.preview(&changes)?;
        for part in &todo {
            migrate::verify_part(&dump, wallet_id, part, &would_be)?;
        }
        self.apply(wallet_id, changes)
    }

    /// Start the chain afresh, for the sync to rebuild it from the chain.
    pub fn rebuild(&mut self, wallet_id: &str, dump: Value) -> Result<()> {
        let dump: migrate::Dump = serde_json::from_value(dump).map_err(|e| BridgeError::plain(format!("cannot decode the old database: {e}")))?;
        self.held(wallet_id)?;
        self.apply(wallet_id, migrate::rebuild_changes(&dump, wallet_id))
    }

    /// The records of one part, in the app's own shape.
    pub fn read(&mut self, wallet_id: &str, part: &str) -> Result<Vec<Value>> {
        Ok(migrate::part_records(self.held(wallet_id)?.log.state(), part)?)
    }

    /// Write a batch of changes, whole or not at all.
    pub fn commit(&mut self, wallet_id: &str, changes: Value) -> Result<()> {
        let changes: Vec<WalletChange> = serde_json::from_value(changes).map_err(|e| BridgeError::plain(format!("cannot decode the changes: {e}")))?;
        self.held(wallet_id)?;
        self.apply(wallet_id, changes)
    }

    /// One ledger operation, decided against the wallet as it is, written,
    /// then applied. `keys` is the unlocked wallet's account, for the
    /// operations that need it.
    pub fn ledger(&mut self, wallet_id: &str, op: Value, keys: Option<&mut Account>) -> Result<Value> {
        let op: op::Op = serde_json::from_value(op).map_err(|e| BridgeError::plain(format!("cannot decode the operation: {e}")))?;
        let outcome = op::run(self.held(wallet_id)?.log.state(), wallet_id, op, keys)?;
        self.apply(wallet_id, outcome.changes)?;
        Ok(outcome.value)
    }

    /// Forget a wallet's log entirely. Needs no key.
    pub fn remove(&mut self, wallet_id: &str) -> Result<()> {
        self.logs.remove(wallet_id);
        Ok(self.persist.remove(&wallet_log(wallet_id))?)
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// Logs as files: a directory per log, a file per batch, and one snapshot.
///
/// Every file is written whole under a temporary name, flushed to the disk,
/// and only then given its real name, so a file with a real name is always
/// complete. A log's directory is its name in hex, since a log's name has a
/// colon in it, which Windows does not allow in a file name.
pub struct FilePersist {
    root: PathBuf,
}

const SNAPSHOT: &str = "snapshot";

impl FilePersist {
    pub fn new(root: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&root).with_context(|| format!("cannot make {}", root.display()))?;
        Ok(Self { root })
    }

    fn dir(&self, log: &str) -> PathBuf {
        self.root.join(hex::encode(log))
    }

    fn batch(seq: u64) -> String {
        format!("{seq:020}.batch")
    }

    /// Write `bytes` to `path` so that it is either all there or not at all.
    fn write_whole(path: &PathBuf, bytes: &[u8]) -> anyhow::Result<()> {
        let temporary = path.with_extension("partial");
        let mut file = fs::File::create(&temporary).with_context(|| format!("cannot write {}", temporary.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path).with_context(|| format!("cannot name {}", path.display()))?;
        Ok(())
    }
}

impl Persist for FilePersist {
    fn logs(&mut self) -> anyhow::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str().and_then(|n| hex::decode(n).ok()).and_then(|b| String::from_utf8(b).ok()) {
                names.push(name);
            }
        }
        Ok(names)
    }

    fn load(&mut self, log: &str) -> anyhow::Result<Vec<Vec<u8>>> {
        let dir = self.dir(log);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            // A partial file is one a crash interrupted before it was named.
            if name.ends_with(".batch") || name == SNAPSHOT {
                entries.push(fs::read(&path)?);
            }
        }
        Ok(entries)
    }

    fn append(&mut self, log: &str, seq: u64, bytes: &[u8]) -> anyhow::Result<()> {
        let dir = self.dir(log);
        fs::create_dir_all(&dir)?;
        let path = dir.join(Self::batch(seq));
        // Two writers would each believe they had written entry n.
        if path.exists() {
            bail!("store: entry {seq} of {log} is already written");
        }
        Self::write_whole(&path, bytes)
    }

    fn compact(&mut self, log: &str, seq: u64, snapshot: &[u8]) -> anyhow::Result<()> {
        let dir = self.dir(log);
        fs::create_dir_all(&dir)?;
        // The snapshot first, then what it covers: a crash between the two
        // leaves too much, never too little.
        Self::write_whole(&dir.join(SNAPSHOT), snapshot)?;
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let covered = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".batch"))
                .and_then(|n| n.parse::<u64>().ok())
                .is_some_and(|n| n <= seq);
            if covered {
                fs::remove_file(&path)?;
            }
        }
        Ok(())
    }

    fn remove(&mut self, log: &str) -> anyhow::Result<()> {
        let dir = self.dir(log);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| anyhow!("cannot remove {}: {e}", dir.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use vault_core::store::MemoryPersist;

    use super::*;

    const W: &str = "w-1";

    fn account() -> Value {
        json!({ "id": W, "network": "regtest", "createdAt": 1, "envelope": {}, "address0": "nolgar1a",
                "birthdayHeight": 100, "nextKeyIndices": { "generation": 1, "ec_hybrid": 0, "viewing": 0 }, "backupConfirmed": true })
    }

    fn opened(persist: Box<dyn Persist + Send>) -> WalletStore {
        let mut store = WalletStore::new(persist);
        store.keep(Some(Zeroizing::new(vec![7u8; 32])));
        store.open(W).unwrap();
        store
    }

    fn chain() -> Vec<String> {
        migrate::CHAIN.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn a_wallet_moves_over_runs_the_ledger_and_is_there_after_reopening() {
        let root = std::env::temp_dir().join(format!("vault-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        {
            let mut store = opened(Box::new(FilePersist::new(root.clone()).unwrap()));
            store.migrate(W, chain(), json!({ "accounts": [account()] })).unwrap();
            let position = store.ledger(W, json!({ "op": "startPass", "tipHeight": 500 }), None).unwrap();
            assert_eq!(position, json!({ "syncedHeight": 99, "syncedHash": null }));
        }
        let mut again = opened(Box::new(FilePersist::new(root.clone()).unwrap()));
        let moved = again.open(W).unwrap();
        assert!(chain().iter().all(|p| moved.contains(p)));
        assert_eq!(again.read(W, "scan").unwrap()[0]["birthdayHeight"], json!(100));

        // On disk: a directory with a name Windows allows, and nothing readable in it.
        let dirs: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(dirs, [hex::encode(wallet_log(W))]);
        let raw: Vec<u8> = fs::read_dir(root.join(&dirs[0])).unwrap().flat_map(|e| fs::read(e.unwrap().path()).unwrap()).collect();
        assert!(!String::from_utf8_lossy(&raw).contains("nolgar1a"));

        again.remove(W).unwrap();
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_locked_store_answers_as_a_locked_wallet_does() {
        let mut store = WalletStore::new(Box::new(MemoryPersist::default()));
        assert_eq!(store.open(W).unwrap_err().message, "wallet is locked");
        let mut store = opened(Box::new(MemoryPersist::default()));
        store.keep(None);
        assert_eq!(store.read(W, "utxos").unwrap_err().message, "wallet is locked");
    }

    #[test]
    fn a_keyed_operation_without_keys_is_refused() {
        let mut store = opened(Box::new(MemoryPersist::default()));
        store.migrate(W, chain(), json!({ "accounts": [account()] })).unwrap();
        assert!(store.ledger(W, json!({ "op": "announcementFlags" }), None).is_err());
    }

    #[test]
    fn a_rebuild_starts_the_chain_afresh_from_the_record() {
        let mut store = opened(Box::new(MemoryPersist::default()));
        store.rebuild(W, json!({ "accounts": [account()] })).unwrap();
        let scan = &store.read(W, "scan").unwrap()[0];
        assert_eq!((scan["birthdayHeight"].clone(), scan["restore"].clone()), (json!(100), json!("rebuild")));
    }

    #[test]
    fn a_file_written_twice_under_one_number_is_refused() {
        let root = std::env::temp_dir().join(format!("vault-store-twice-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut files = FilePersist::new(root.clone()).unwrap();
        files.append("log", 1, b"one").unwrap();
        assert!(files.append("log", 1, b"two").is_err());
        assert_eq!(files.load("log").unwrap(), vec![b"one".to_vec()]);
        files.compact("log", 1, b"snap").unwrap();
        assert_eq!(files.load("log").unwrap(), vec![b"snap".to_vec()]);
        let _ = fs::remove_dir_all(&root);
    }
}
