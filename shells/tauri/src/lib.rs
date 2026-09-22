//! The native shell: a window showing the same web app, and the commands
//! that carry its calls to the Rust underneath instead of to wasm.
//!
//! There is deliberately no logic here. Every command decodes its
//! arguments, calls [`vault_bridge`], and hands back what it returns. That
//! is what keeps the bridge usable by a shell that is not Tauri.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri::State;
use vault_bridge::envelope::{SealedBox, SeedEnvelope};
use vault_bridge::{BridgeError, Prover, ProveEvent, ProveOutcome, SendPlan, Vault};

/// What the app holds for as long as it is running: one wallet, one prover.
struct App {
    vault: Arc<Vault>,
    prover: Arc<Prover>,
}

type Result<T> = std::result::Result<T, BridgeError>;

fn bytes(what: &str, base64: &str) -> Result<Vec<u8>> {
    vault_bridge::decode_bytes(what, base64)
}

// ---------------------------------------------------------------------------
// The wallet core
// ---------------------------------------------------------------------------

#[tauri::command]
fn wallet_core_version() -> String {
    vault_bridge::core_version()
}

#[tauri::command]
fn wallet_claim_version(network: String, block_height: u64) -> Result<u32> {
    vault_bridge::claim_version(&network, block_height)
}

#[tauri::command]
fn wallet_generate_phrase() -> Vec<String> {
    vault_bridge::generate_phrase()
}

#[tauri::command]
fn wallet_derive_key(
    password: String,
    salt: String,
    m_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<String> {
    let password = bytes("the password", &password)?;
    let salt = bytes("the salt", &salt)?;
    let key = vault_bridge::derive_key(&password, &salt, m_kib, t_cost, p_cost)?;
    Ok(vault_bridge::encode_bytes(&key))
}

#[tauri::command]
fn wallet_parse_amount(text: String) -> Result<String> {
    vault_bridge::parse_amount(&text)
}

#[tauri::command]
fn wallet_format_amount(nau: String) -> Result<String> {
    vault_bridge::format_amount(&nau)
}

#[tauri::command]
fn wallet_is_valid_address(encoded: String, network: String) -> Result<bool> {
    vault_bridge::is_valid_address(&encoded, &network)
}

#[tauri::command]
fn wallet_phrase_problem(words: Vec<String>) -> Option<String> {
    vault_bridge::phrase_problem(&words)
}

/// `content_key` comes with a new wallet, whose envelope was sealed on the
/// page: the key its data is sealed under, handed over once.
#[tauri::command]
fn wallet_unlock(app: State<'_, App>, phrase: Vec<String>, network: String, content_key: Option<String>) -> Result<()> {
    match content_key {
        Some(key) => app.vault.unlock_with_content_key(&phrase, &network, bytes("the content key", &key)?),
        None => app.vault.unlock(&phrase, &network),
    }
}

#[tauri::command]
fn wallet_unlock_envelope(
    app: State<'_, App>,
    envelope: SeedEnvelope,
    password: String,
    network: String,
) -> Result<()> {
    app.vault.unlock_envelope(&envelope, &password, &network)
}

#[tauri::command]
fn wallet_unlock_envelope_with_secret(
    app: State<'_, App>,
    envelope: SeedEnvelope,
    wrapped: SealedBox,
    secret: String,
    network: String,
) -> Result<()> {
    let secret = bytes("the passkey secret", &secret)?;
    app.vault
        .unlock_envelope_with_secret(&envelope, &wrapped, &secret, &network)
}

#[tauri::command]
fn wallet_open_envelope(
    app: State<'_, App>,
    envelope: SeedEnvelope,
    password: String,
    want_phrase: bool,
) -> Result<Option<Vec<String>>> {
    app.vault.open_envelope(&envelope, &password, want_phrase)
}

#[tauri::command]
fn wallet_lock(app: State<'_, App>) -> Result<()> {
    app.vault.lock()
}

#[tauri::command]
fn wallet_is_unlocked(app: State<'_, App>) -> bool {
    app.vault.is_unlocked()
}

#[tauri::command]
fn wallet_address(app: State<'_, App>, kind: String, index: u64) -> Result<String> {
    app.vault.address(&kind, index)
}

#[tauri::command]
fn wallet_announcement_flags(app: State<'_, App>, next_key_indices: Value) -> Result<String> {
    app.vault.announcement_flags(next_key_indices)
}

#[tauri::command]
fn wallet_absolute_index_sets(app: State<'_, App>, unspent: Value) -> Result<String> {
    app.vault.absolute_index_sets(unspent)
}

#[tauri::command]
fn wallet_scan_blocks(
    app: State<'_, App>,
    blocks_response: String,
    unspent: Value,
    next_key_indices: Value,
    expectation: Value,
) -> Result<Value> {
    app.vault
        .scan_blocks(&blocks_response, unspent, next_key_indices, expectation)
}

#[tauri::command]
fn wallet_scan_mempool_kernel(
    app: State<'_, App>,
    kernel_response: String,
    unspent: Value,
    next_key_indices: Value,
    tip_height: u64,
) -> Result<Value> {
    app.vault
        .scan_mempool_kernel(&kernel_response, unspent, next_key_indices, tip_height)
}

#[tauri::command]
fn wallet_plan_inputs(
    app: State<'_, App>,
    unspent: Value,
    request: Value,
    now_ms: u64,
) -> Result<Value> {
    app.vault.plan_inputs(unspent, request, now_ms)
}

#[tauri::command]
fn wallet_build_send(
    app: State<'_, App>,
    inputs: Value,
    snapshot_response: String,
    tip_header_response: String,
    request: Value,
    now_ms: u64,
) -> Result<SendPlan> {
    app.vault.build_send(
        inputs,
        &snapshot_response,
        &tip_header_response,
        request,
        now_ms,
    )
}

#[tauri::command]
fn wallet_mock_proof_collection(witness: String) -> Result<String> {
    let witness = bytes("the witness", &witness)?;
    Ok(vault_bridge::encode_bytes(
        &vault_bridge::mock_proof_collection(&witness)?,
    ))
}

#[tauri::command]
fn wallet_assemble_submission(kernel: String, proof_collection: String) -> Result<Value> {
    let kernel = bytes("the kernel", &kernel)?;
    let proof_collection = bytes("the proof collection", &proof_collection)?;
    vault_bridge::assemble_submission(&kernel, &proof_collection)
}

// ---------------------------------------------------------------------------
// The wallet's data
// ---------------------------------------------------------------------------

#[tauri::command]
fn store_open(app: State<'_, App>, account_id: String) -> Result<Vec<String>> {
    app.vault.store_open(&account_id)
}

#[tauri::command]
fn store_migrate(app: State<'_, App>, account_id: String, parts: Vec<String>, dump: Value) -> Result<()> {
    app.vault.store_migrate(&account_id, parts, dump)
}

#[tauri::command]
fn store_rebuild(app: State<'_, App>, account_id: String, dump: Value) -> Result<()> {
    app.vault.store_rebuild(&account_id, dump)
}

#[tauri::command]
fn store_read(app: State<'_, App>, account_id: String, part: String) -> Result<Vec<Value>> {
    app.vault.store_read(&account_id, &part)
}

#[tauri::command]
fn store_commit(app: State<'_, App>, account_id: String, changes: Value) -> Result<()> {
    app.vault.store_commit(&account_id, changes)
}

#[tauri::command]
fn store_remove(app: State<'_, App>, account_id: String) -> Result<()> {
    app.vault.store_remove(&account_id)
}

/// One ledger operation. On a blocking thread: scanning a batch of blocks
/// takes a while, and a synchronous command would hold the window's thread.
#[tauri::command]
async fn wallet_ledger(app: State<'_, App>, account_id: String, op: Value) -> Result<Value> {
    let vault = app.vault.clone();
    tauri::async_runtime::spawn_blocking(move || vault.ledger(&account_id, op))
        .await
        .map_err(|e| BridgeError {
            name: "Error".to_string(),
            message: format!("the wallet's thread stopped: {e}"),
        })?
}

// ---------------------------------------------------------------------------
// The prover
// ---------------------------------------------------------------------------

/// Prove a ProofCollection, reporting each sub-proof as it goes.
///
/// The work runs on a blocking thread. A proof takes minutes, and a
/// synchronous command would hold the thread the window is drawn on for all
/// of them.
#[tauri::command]
async fn prover_prove(
    app: State<'_, App>,
    witness: String,
    network: String,
    block_height: u64,
    threads: usize,
    legacy: bool,
    on_event: Channel<ProveEvent>,
) -> Result<ProveOutcome> {
    if legacy {
        // The pre-fork prover is a separate workspace on purpose, so that the
        // two generations of the consensus crates never share a dependency
        // graph, and it is due to be deleted a week after the fork. Rather
        // than link it in or drop the flag on the floor, say plainly that
        // this build cannot make a claim-version-5 proof.
        return Err(BridgeError {
            name: "Error".to_string(),
            message: "This build cannot make pre-fork proofs. Send from the web app until the fork, or update this app after it.".to_string(),
        });
    }
    let witness = bytes("the witness", &witness)?;
    let prover = app.prover.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = |event: ProveEvent| {
            // A closed channel means the window went away mid-proof. The
            // proof is finished anyway; there is simply nobody to tell.
            let _ = on_event.send(event);
        };
        prover.prove(&witness, &network, block_height, threads, &mut report)
    })
    .await
    .map_err(|e| BridgeError {
        name: "Error".to_string(),
        message: format!("the proving thread stopped: {e}"),
    })?
}

#[tauri::command]
fn prover_cancel(app: State<'_, App>) {
    app.prover.cancel();
}

// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The wallet's sealed logs live in the app's own data folder, a
            // path this app chose, and not in the web view's storage.
            let logs = app.path().app_data_dir()?.join("logs");
            let vault = Vault::with_store_dir(logs).map_err(|e| e.message)?;
            app.manage(App {
                vault: Arc::new(vault),
                prover: Arc::new(Prover::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            wallet_core_version,
            wallet_claim_version,
            wallet_generate_phrase,
            wallet_derive_key,
            wallet_parse_amount,
            wallet_format_amount,
            wallet_is_valid_address,
            wallet_phrase_problem,
            wallet_unlock,
            wallet_unlock_envelope,
            wallet_unlock_envelope_with_secret,
            wallet_open_envelope,
            wallet_lock,
            wallet_is_unlocked,
            wallet_address,
            wallet_announcement_flags,
            wallet_absolute_index_sets,
            wallet_scan_blocks,
            wallet_scan_mempool_kernel,
            wallet_plan_inputs,
            wallet_build_send,
            wallet_mock_proof_collection,
            wallet_assemble_submission,
            store_open,
            store_migrate,
            store_rebuild,
            store_read,
            store_commit,
            store_remove,
            wallet_ledger,
            prover_prove,
            prover_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("the app could not start");
}
