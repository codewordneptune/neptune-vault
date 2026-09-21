//! Moving a wallet out of the app's own database and into the engine's logs.
//!
//! This is the one step in the whole change that can lose someone's wallet,
//! so it is built to be checked rather than trusted. The app hands over
//! everything its database holds, as it holds it. From that come the
//! changes that build the new state, and, going the other way, the records
//! the new state amounts to. A migration is good when the second equals the
//! first, record for record, and the app switches over only then. Nothing
//! here deletes anything: the old database is left exactly as it was.
//!
//! It happens in two parts, because the new logs are sealed and the old
//! database was not. The device part needs no secret and runs at start-up:
//! which wallets exist, their sealed seeds, the settings. A wallet's own
//! part can only be written under that wallet's key, which exists only
//! while it is unlocked, so each wallet moves the first time it is opened.
//!
//! A record that does not have the shape this build expects stops the
//! migration of that wallet with an error that names it. The wallet stays
//! where it was, working as before. Guessing at a coin's fields is not a
//! thing to do quietly.

use anyhow::anyhow;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde_json::json;
use serde_json::Map;
use serde_json::Value;

use crate::store::Block;
use crate::store::Contact;
use crate::store::DeviceChange;
use crate::store::DeviceState;
use crate::store::HistoryEntry;
use crate::store::Settings;
use crate::store::SyncState;
use crate::store::Utxo;
use crate::store::WalletChange;
use crate::store::WalletDetails;
use crate::store::WalletHeader;
use crate::store::WalletState;

/// Where the last failed send is kept once it leaves the device's settings:
/// it names an amount and a recipient, which a locked wallet does not show.
pub const LAST_SEND_FAILURE: &str = "lastSendFailure";

/// The fields of the app's account record that a lock screen needs. The
/// rest of the record is the wallet's own business and is sealed with it.
const HEADER_FIELDS: [&str; 6] = ["id", "network", "createdAt", "envelope", "name", "passkey"];

/// Everything the app's database holds, as it holds it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dump {
    #[serde(default)]
    pub accounts: Vec<Value>,
    #[serde(default)]
    pub utxos: Vec<Value>,
    #[serde(default)]
    pub blocks: Vec<Value>,
    #[serde(default)]
    pub history: Vec<Value>,
    #[serde(default)]
    pub sync_state: Vec<Value>,
    #[serde(default)]
    pub contacts: Vec<Value>,
    #[serde(default)]
    pub settings: Option<Value>,
}

fn object<'a>(record: &'a Value, what: &str) -> Result<&'a Map<String, Value>> {
    record.as_object().ok_or_else(|| anyhow!("migrate: {what} is not a record"))
}

fn text<'a>(record: &'a Value, field: &str, what: &str) -> Result<&'a str> {
    record
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("migrate: {what} has no {field}"))
}

/// The records of one store that belong to one wallet.
fn owned<'a>(records: &'a [Value], wallet_id: &str) -> impl Iterator<Item = &'a Value> + 'a {
    let wallet_id = wallet_id.to_string();
    records
        .iter()
        .filter(move |r| r.get("accountId").and_then(Value::as_str) == Some(wallet_id.as_str()))
}

/// An account record as this build writes it. The first wallets kept one
/// counter, `nextKeyIndex`, where there are now three, and a record that
/// predates the backup check has no `backupConfirmed`.
fn normal_account(record: &Value) -> Result<Map<String, Value>> {
    let mut account = object(record, "an account")?.clone();
    let legacy = account.remove("nextKeyIndex");
    if !account.contains_key("nextKeyIndices") {
        let generation = legacy.as_ref().and_then(Value::as_u64).unwrap_or(1);
        account.insert("nextKeyIndices".into(), json!({ "generation": generation, "ec_hybrid": 0, "viewing": 0 }));
    }
    account.entry("backupConfirmed").or_insert(Value::Bool(false));
    Ok(account)
}

fn account<'a>(dump: &'a Dump, wallet_id: &str) -> Result<&'a Value> {
    dump.accounts
        .iter()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(wallet_id))
        .ok_or_else(|| anyhow!("migrate: no wallet {wallet_id} in the old database"))
}

/// The device's settings without what belongs to a wallet.
fn normal_settings(record: &Value) -> Result<Map<String, Value>> {
    let mut settings = object(record, "the settings")?.clone();
    settings.remove(LAST_SEND_FAILURE);
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Forwards: the changes that build the new state
// ---------------------------------------------------------------------------

/// The part that needs no secret: settings, and a header for every wallet.
pub fn device_changes(dump: &Dump) -> Result<Vec<DeviceChange>> {
    let mut changes = Vec::new();
    if let Some(record) = &dump.settings {
        let settings: Settings = serde_json::from_value(Value::Object(normal_settings(record)?))
            .context("migrate: the settings are not in a shape this build knows")?;
        changes.push(DeviceChange::PutSettings { settings });
    }
    for record in &dump.accounts {
        let id = text(record, "id", "an account")?;
        let fields = normal_account(record)?;
        let header: Map<String, Value> = fields
            .into_iter()
            .filter(|(name, _)| HEADER_FIELDS.contains(&name.as_str()))
            .collect();
        let header: WalletHeader = serde_json::from_value(Value::Object(header))
            .with_context(|| format!("migrate: wallet {id} is not in a shape this build knows"))?;
        changes.push(DeviceChange::PutWallet { header });
    }
    Ok(changes)
}

fn typed<T: serde::de::DeserializeOwned>(record: &Value, what: &str) -> Result<T> {
    let name = record.get("key").or_else(|| record.get("id")).and_then(Value::as_str).unwrap_or("?");
    serde_json::from_value(record.clone())
        .with_context(|| format!("migrate: {what} {name} is not in a shape this build knows"))
}

/// Everything one wallet owns, as one batch for its sealed log.
pub fn wallet_changes(dump: &Dump, wallet_id: &str) -> Result<Vec<WalletChange>> {
    let details: Map<String, Value> = normal_account(account(dump, wallet_id)?)?
        .into_iter()
        .filter(|(name, _)| !HEADER_FIELDS.contains(&name.as_str()))
        .collect();
    let details: WalletDetails = serde_json::from_value(Value::Object(details))
        .with_context(|| format!("migrate: wallet {wallet_id} is not in a shape this build knows"))?;
    let mut changes = vec![WalletChange::PutDetails { details }];

    for record in owned(&dump.sync_state, wallet_id) {
        changes.push(WalletChange::PutSync { sync: typed::<SyncState>(record, "the sync position of")? });
    }
    for record in owned(&dump.utxos, wallet_id) {
        changes.push(WalletChange::PutUtxo { utxo: typed::<Utxo>(record, "coin")? });
    }
    for record in owned(&dump.blocks, wallet_id) {
        changes.push(WalletChange::PutBlock { block: typed::<Block>(record, "block")? });
    }
    for record in owned(&dump.history, wallet_id) {
        changes.push(WalletChange::PutHistory { entry: typed::<HistoryEntry>(record, "history entry")? });
    }
    for record in owned(&dump.contacts, wallet_id) {
        changes.push(WalletChange::PutContact { contact: typed::<Contact>(record, "contact")? });
    }
    if let Some(failure) = dump.settings.as_ref().and_then(|s| s.get(LAST_SEND_FAILURE)) {
        if failure.get("accountId").and_then(Value::as_str) == Some(wallet_id) {
            changes.push(WalletChange::PutPrivate { key: LAST_SEND_FAILURE.into(), value: failure.clone() });
        }
    }
    Ok(changes)
}

// ---------------------------------------------------------------------------
// Backwards: the records the new state amounts to
// ---------------------------------------------------------------------------

fn as_record<T: serde::Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).context("migrate: cannot write a record back out")
}

/// The app's account record, put back together from its two halves.
pub fn account_record(header: &WalletHeader, details: &WalletDetails) -> Result<Value> {
    let mut record = object(&as_record(header)?, "a header")?.clone();
    record.extend(object(&as_record(details)?, "the details")?.clone());
    Ok(Value::Object(record))
}

/// Records sorted by their key, so two sets compare whatever order they came in.
fn sorted(mut records: Vec<Value>, by: &str) -> Vec<Value> {
    records.sort_by(|a, b| a.get(by).map(Value::to_string).cmp(&b.get(by).map(Value::to_string)));
    records
}

fn same(what: &str, old: Vec<Value>, new: Vec<Value>, by: &str) -> Result<()> {
    let (old, new) = (sorted(old, by), sorted(new, by));
    if old.len() != new.len() {
        bail!("migrate: the old database has {} {what} and the new state has {}", old.len(), new.len());
    }
    for (o, n) in old.iter().zip(&new) {
        if o != n {
            let name = o.get(by).map(Value::to_string).unwrap_or_default();
            bail!("migrate: {what} {name} did not come through unchanged");
        }
    }
    Ok(())
}

/// Whether the device log says what the old database said.
pub fn verify_device(dump: &Dump, device: &DeviceState) -> Result<()> {
    let old = dump.settings.as_ref().map(normal_settings).transpose()?.map(Value::Object);
    let new = device.settings.as_ref().map(as_record).transpose()?;
    if old != new {
        bail!("migrate: the settings did not come through unchanged");
    }
    let ids = |records: &[Value]| -> Vec<Value> {
        records.iter().map(|a| json!({ "id": a.get("id").cloned().unwrap_or(Value::Null) })).collect()
    };
    let new_ids: Vec<Value> = device.wallets.keys().map(|id| json!({ "id": id })).collect();
    same("wallets", ids(&dump.accounts), new_ids, "id")
}

/// Whether a wallet's new state says, record for record, what the old
/// database said about it. The switch-over happens only when this passes.
pub fn verify_wallet(dump: &Dump, header: &WalletHeader, state: &WalletState) -> Result<()> {
    let id = header.id.as_str();
    let details = state.details.as_ref().ok_or_else(|| anyhow!("migrate: wallet {id} has no details"))?;
    let old_account = Value::Object(normal_account(account(dump, id)?)?);
    if old_account != account_record(header, details)? {
        bail!("migrate: the record of wallet {id} did not come through unchanged");
    }

    let all = |records: &[Value]| owned(records, id).cloned().collect::<Vec<_>>();
    let written = |records: Vec<Result<Value>>| records.into_iter().collect::<Result<Vec<_>>>();
    same("coins", all(&dump.utxos), written(state.utxos.values().map(as_record).collect())?, "key")?;
    same("blocks", all(&dump.blocks), written(state.blocks.values().map(as_record).collect())?, "key")?;
    same("history entries", all(&dump.history), written(state.history.values().map(as_record).collect())?, "key")?;
    same("contacts", all(&dump.contacts), written(state.contacts.values().map(as_record).collect())?, "key")?;
    same("sync positions", all(&dump.sync_state), written(state.sync.iter().map(as_record).collect())?, "accountId")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::DEVICE_LOG;
    use crate::store::Log;
    use crate::store::LogKey;
    use crate::store::wallet_log;

    /// A database as the app leaves it: two wallets, one of them from the
    /// first version with its single key counter, and a failed send on file.
    fn dump() -> Dump {
        serde_json::from_value(json!({
            "settings": {
                "id": "settings", "network": "main", "currentAccountId": "a",
                "nodeUrls": { "main": "https://node.example", "testnet": "", "regtest": "/regtest-node" },
                "lockTimeoutMs": 300000, "hideBalance": true,
                "lastSendFailure": { "at": 5, "accountId": "a", "amount": "12.5", "recipient": "nolgam1payee", "message": "no route" }
            },
            "accounts": [
                { "id": "a", "network": "main", "createdAt": 1700000000000u64, "birthdayHeight": 40000,
                  "envelope": { "version": 1, "kdf": { "name": "argon2id" } }, "address0": "nolgam1mine",
                  "nextKeyIndices": { "generation": 3, "ec_hybrid": 1, "viewing": 0 }, "backupConfirmed": true,
                  "name": "Savings", "lastBackupAt": 1700000001000u64,
                  "passkey": { "credentialId": "c", "prfSalt": "s", "wrappedContentKey": { "iv": "i", "ciphertext": "x" } } },
                { "id": "old", "network": "main", "createdAt": 1690000000000u64, "birthdayHeight": 0,
                  "envelope": { "version": 1 }, "address0": "nolgam1first", "nextKeyIndex": 7 }
            ],
            "utxos": [
                { "key": "a:c1:10", "accountId": "a", "hash": "c1:10", "stored": { "hash": "c1:10", "recovery": { "aocl_index": 10 } },
                  "amountNau": "5000", "amount": "0.005", "confirmedHeight": 41000, "confirmedTimestampMs": 1700000002000u64,
                  "releaseDateMs": null, "spentHeight": null, "spentTxid": null, "pendingTxid": "tx9" },
                { "key": "old:c2:11", "accountId": "old", "hash": "c2:11", "stored": {},
                  "amountNau": "1", "amount": "0.000001", "confirmedHeight": 9, "confirmedTimestampMs": 9,
                  "releaseDateMs": 1800000000000u64, "spentHeight": 12, "spentTxid": "tx1", "pendingTxid": null }
            ],
            "blocks": [
                { "key": "a:41000", "accountId": "a", "height": 41000, "hash": "h1", "prevHash": "h0", "timestampMs": 1 },
                { "key": "a:41001", "accountId": "a", "height": 41001, "hash": "h2", "prevHash": "h1", "timestampMs": 2 }
            ],
            "history": [
                { "key": "a:sent:tx9", "accountId": "a", "kind": "sent", "status": "pending", "txid": "tx9",
                  "amountNau": "4000", "feeNau": "10", "timestampMs": 3, "height": null, "inputHashes": ["c1:10"],
                  "recipient": "nolgam1payee", "error": null, "note": "rent",
                  "outputs": [{ "commitment": "cm", "role": "recipient" }] }
            ],
            "syncState": [{ "accountId": "a", "syncedHeight": 41001, "syncedHash": "h2", "updatedAt": 4 }],
            "contacts": [
                { "key": "a:k1", "id": "k1", "accountId": "a", "name": "Landlord", "address": "nolgam1payee",
                  "kind": "Standard", "createdAt": 1, "updatedAt": 2 }
            ]
        }))
        .unwrap()
    }

    fn migrated(dump: &Dump, id: &str) -> (DeviceState, WalletState) {
        let mut device = Log::<DeviceState>::open(DEVICE_LOG, None, Vec::new()).unwrap();
        let batch = device.prepare(device_changes(dump).unwrap()).unwrap();
        device.confirm(batch).unwrap();
        let key = LogKey::derive(&[3u8; 32], id).unwrap();
        let mut wallet = Log::<WalletState>::open(&wallet_log(id), Some(key), Vec::new()).unwrap();
        let batch = wallet.prepare(wallet_changes(dump, id).unwrap()).unwrap();
        wallet.confirm(batch).unwrap();
        (device.state().clone(), wallet.state().clone())
    }

    #[test]
    fn a_wallet_comes_through_record_for_record() {
        let dump = dump();
        let (device, wallet) = migrated(&dump, "a");
        verify_device(&dump, &device).unwrap();
        verify_wallet(&dump, &device.wallets["a"], &wallet).unwrap();
        assert_eq!(wallet.utxos.len(), 1, "the other wallet's coin stays with the other wallet");
        assert_eq!(wallet.history["a:sent:tx9"].extra["note"], json!("rent"));
    }

    #[test]
    fn a_wallet_from_the_first_version_comes_through_too() {
        let dump = dump();
        let (device, wallet) = migrated(&dump, "old");
        verify_wallet(&dump, &device.wallets["old"], &wallet).unwrap();
        let details = wallet.details.unwrap();
        assert_eq!(details.next_key_indices.generation, 7);
        assert!(!details.backup_confirmed);
        assert!(!details.extra.contains_key("nextKeyIndex"));
    }

    #[test]
    fn the_lock_screen_gets_the_name_and_the_seed_and_not_the_address() {
        let dump = dump();
        let (device, wallet) = migrated(&dump, "a");
        let header = serde_json::to_value(&device.wallets["a"]).unwrap();
        assert_eq!(header["name"], json!("Savings"));
        assert!(header.get("passkey").is_some() && header.get("envelope").is_some());
        assert!(header.get("address0").is_none() && header.get("birthdayHeight").is_none());
        assert_eq!(wallet.details.unwrap().address0, "nolgam1mine");
    }

    #[test]
    fn the_failed_send_leaves_the_settings_and_goes_to_the_wallet_it_names() {
        let dump = dump();
        let (device, wallet) = migrated(&dump, "a");
        let settings = serde_json::to_value(device.settings.as_ref().unwrap()).unwrap();
        assert!(settings.get(LAST_SEND_FAILURE).is_none());
        assert_eq!(settings["hideBalance"], json!(true));
        assert_eq!(wallet.private[LAST_SEND_FAILURE]["recipient"], json!("nolgam1payee"));
        let (_, other) = migrated(&dump, "old");
        assert!(other.private.is_empty());
    }

    #[test]
    fn a_change_anywhere_is_caught_by_the_check() {
        let dump = dump();
        let (device, wallet) = migrated(&dump, "a");
        let header = &device.wallets["a"];

        let mut lost = wallet.clone();
        lost.utxos.clear();
        assert!(verify_wallet(&dump, header, &lost).unwrap_err().to_string().contains("coins"));

        let mut altered = wallet.clone();
        altered.utxos.get_mut("c1:10").unwrap().amount_nau = "5001".into();
        assert!(verify_wallet(&dump, header, &altered).unwrap_err().to_string().contains("a:c1:10"));

        let mut dropped = wallet.clone();
        dropped.history.get_mut("a:sent:tx9").unwrap().extra.remove("note");
        assert!(verify_wallet(&dump, header, &dropped).is_err());

        let mut renamed = header.clone();
        renamed.name = Some("Spending".into());
        assert!(verify_wallet(&dump, &renamed, &wallet).is_err());
    }

    #[test]
    fn a_record_this_build_does_not_recognise_stops_that_wallet_and_names_it() {
        let mut dump = dump();
        dump.utxos[0].as_object_mut().unwrap().remove("amountNau");
        let error = format!("{:#}", wallet_changes(&dump, "a").unwrap_err());
        assert!(error.contains("coin a:c1:10"), "{error}");
        // The other wallet is not held back by it.
        wallet_changes(&dump, "old").unwrap();
    }

    #[test]
    fn an_empty_database_migrates_to_an_empty_device() {
        let dump = Dump::default();
        assert!(device_changes(&dump).unwrap().is_empty());
        verify_device(&dump, &DeviceState::default()).unwrap();
    }
}
