//! The native shell: a window showing the same web app, and the commands
//! that carry its calls to the Rust underneath instead of to wasm.
//!
//! There is deliberately no logic here. Every command decodes its
//! arguments, calls [`vault_bridge`], and hands back what it returns. That
//! is what keeps the bridge usable by a shell that is not Tauri.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri::webview::PageLoadEvent;
use tauri::Manager;
use tauri::State;
use vault_bridge::envelope::{SealedBox, SeedEnvelope, SeedUnlock};
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
    seed_unlock: bool,
) -> Result<Option<SeedUnlock>> {
    app.vault.unlock_envelope(&envelope, &password, &network, seed_unlock)
}

#[tauri::command]
fn wallet_unlock_envelope_with_secret(
    app: State<'_, App>,
    envelope: SeedEnvelope,
    wrapped: SealedBox,
    secret: String,
    network: String,
    seed_unlock: bool,
) -> Result<Option<SeedUnlock>> {
    let secret = bytes("the secret", &secret)?;
    app.vault
        .unlock_envelope_with_secret(&envelope, &wrapped, &secret, &network, seed_unlock)
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
fn store_set_aside(app: State<'_, App>, account_id: String, dump: Value, now: u64) -> Result<u32> {
    app.vault.store_set_aside(&account_id, dump, now)
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
    on_event: Channel<ProveEvent>,
) -> Result<ProveOutcome> {
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
// The app around the wallet
// ---------------------------------------------------------------------------

fn app_error(message: impl Into<String>) -> BridgeError {
    BridgeError {
        name: "Error".to_string(),
        message: message.into(),
    }
}

/// Offers the native Save dialog and writes `contents` where the person
/// chooses. The dialog is opened here, not from the page, so the page can
/// never write to a path of its own choosing. The path saved to, or none
/// when the person cancelled. The kind of file follows the suggested name:
/// History as a spreadsheet, or a backup.
#[tauri::command]
async fn app_save_file(app: tauri::AppHandle, suggested_name: String, contents: String) -> Result<Option<String>> {
    let (kind, extension) = if suggested_name.ends_with(".csv") { ("Spreadsheet", "csv") } else { ("Neptune Vault backup", "json") };
    let chosen = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter(kind, &[extension])
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| app_error(format!("That place cannot be saved to: {e}")))?;
    std::fs::write(&path, contents.as_bytes()).map_err(|e| app_error(format!("The file could not be written: {e}")))?;
    Ok(Some(path.display().to_string()))
}

/// Where a link may lead from the app: the project's own pages, opened in
/// the system's browser. Anything else is refused, so a page that went
/// wrong cannot send the person to a site of its choosing. Kept in step
/// with web/src/app/links.ts.
const LINK_HOSTS: &[&str] = &["useneptune.org", "t.me", "talk.neptune.cash", "github.com", "neptune.cash", "neptunefundamentals.org"];

fn allowed_link(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    LINK_HOSTS.contains(&host)
}

/// Opens one of the project's pages in the system's browser.
#[tauri::command]
fn app_open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    if !allowed_link(&url) {
        return Err(app_error("That link is not one the app opens."));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| app_error(format!("The link could not be opened: {e}")))
}

/// Reads the QR code in a camera frame or picture: greyscale pixels, one
/// byte each, rows from the top. None when there is no code to read.
#[tauri::command]
async fn app_read_qr(luma: String, width: u32) -> Result<Option<String>> {
    let luma = bytes("frame", &luma)?;
    let height = luma.len().checked_div(width as usize).unwrap_or(0) as u32;
    tauri::async_runtime::spawn_blocking(move || vault_bridge::read_qr(luma, width, height))
        .await
        .map_err(|e| app_error(format!("The frame could not be read: {e}")))
}

/// Keeps the window out of screenshots, screen recordings and the
/// recent-apps preview while `on` (Android's FLAG_SECURE): the page asks
/// for it while a seed phrase is shown or typed. Elsewhere it does nothing.
#[tauri::command]
fn app_secure_screen(app: tauri::AppHandle, on: bool) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        // WindowManager.LayoutParams.FLAG_SECURE
        const FLAG_SECURE: i32 = 0x2000;
        let window = app.get_webview_window("main").ok_or_else(|| app_error("The app's window is not open."))?;
        window
            .with_webview(move |webview| {
                // Runs on Android's UI thread, where a window's flags are set.
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let set = env
                        .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])
                        .and_then(|window| window.l())
                        .and_then(|window| env.call_method(&window, if on { "addFlags" } else { "clearFlags" }, "(I)V", &[FLAG_SECURE.into()]));
                    // A Java exception left pending would break the next call into Java.
                    if set.is_err() && env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                });
            })
            .map_err(|e| app_error(format!("The screen could not be protected: {e}")))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, on);
    Ok(())
}

/// The space the phone's status and navigation bars, and a camera cutout,
/// take on each side, in the page's CSS pixels.
#[derive(Clone, Copy, Default, serde::Serialize)]
struct Insets {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// The system bars' sizes, for the page to keep clear of them. The Android
/// app draws under the bars, and Android's web view gives
/// env(safe-area-inset-*) as 0 or wrongly before version 140. Zero where
/// they cannot be read, and on the desktop, where nothing is drawn under them.
#[tauri::command]
async fn app_insets(app: tauri::AppHandle) -> Result<Insets> {
    #[cfg(target_os = "android")]
    let insets = android_insets(app).await;
    #[cfg(not(target_os = "android"))]
    let insets = {
        let _ = app;
        Insets::default()
    };
    Ok(insets)
}

#[cfg(target_os = "android")]
async fn android_insets(app: tauri::AppHandle) -> Insets {
    let Some(window) = app.get_webview_window("main") else {
        return Insets::default();
    };
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let asked = window.with_webview(move |webview| {
        // Runs on Android's UI thread, where the window's insets are read.
        webview.jni_handle().exec(move |env, activity, _webview| {
            let read = (|| -> jni::errors::Result<Insets> {
                let window = env.call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?.l()?;
                let decor = env.call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?.l()?;
                let insets = env.call_method(&decor, "getRootWindowInsets", "()Landroid/view/WindowInsets;", &[])?.l()?;
                if insets.is_null() {
                    return Ok(Insets::default());
                }
                let sdk = env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()?;
                let px = if sdk >= 30 {
                    // The bars and the cutout, never the keyboard.
                    let bars = env.call_static_method("android/view/WindowInsets$Type", "systemBars", "()I", &[])?.i()?;
                    let cutout = env.call_static_method("android/view/WindowInsets$Type", "displayCutout", "()I", &[])?.i()?;
                    let sides = env.call_method(&insets, "getInsets", "(I)Landroid/graphics/Insets;", &[(bars | cutout).into()])?.l()?;
                    let mut side = |name: &str| env.get_field(&sides, name, "I").and_then(|v| v.i());
                    [side("top")?, side("right")?, side("bottom")?, side("left")?]
                } else {
                    let mut side = |name: &str| env.call_method(&insets, name, "()I", &[]).and_then(|v| v.i());
                    [side("getStableInsetTop")?, side("getStableInsetRight")?, side("getStableInsetBottom")?, side("getStableInsetLeft")?]
                };
                let resources = env.call_method(activity, "getResources", "()Landroid/content/res/Resources;", &[])?.l()?;
                let metrics = env.call_method(&resources, "getDisplayMetrics", "()Landroid/util/DisplayMetrics;", &[])?.l()?;
                let density = f64::from(env.get_field(&metrics, "density", "F")?.f()?);
                let css = |px: i32| f64::from(px) / density;
                Ok(Insets { top: css(px[0]), right: css(px[1]), bottom: css(px[2]), left: css(px[3]) })
            })();
            // A Java exception left pending would break the next call into Java.
            if read.is_err() && env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            let _ = tx.send(read.ok());
        });
    });
    if asked.is_err() {
        return Insets::default();
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(2)).ok().flatten())
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------

/// The app. The desktop binary calls it from main.rs; Android and iOS load
/// the library and call it through the entry point Tauri generates here.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Registered first, so a second launch is caught before it starts
    // anything: it brings the running window forward and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    // A payment link (neptunecash:) tapped or clicked in another app or on a
    // web page opens this one, and the page fills in Send from it. The scheme
    // is in tauri.conf.json, which puts it in the Android manifest and has
    // the desktop installers register it; on Windows and Linux a link starts
    // a second copy of the app, which hands it to this one (single instance).
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // A development build is not installed, so it registers the
            // scheme itself, to try links with.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
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
        // A page that starts again, from Reload on the error screen or a web
        // view the system rebuilt, gets a locked wallet: the page that
        // unlocked it is gone, and the new one shows a lock screen. A proof
        // the old page started is abandoned with it.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                if let Some(app) = webview.try_state::<App>() {
                    let _ = app.vault.lock();
                    app.prover.cancel();
                }
            }
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
            store_set_aside,
            store_read,
            store_commit,
            store_remove,
            wallet_ledger,
            prover_prove,
            prover_cancel,
            app_save_file,
            app_open_url,
            app_secure_screen,
            app_insets,
            app_read_qr,
        ])
        .run(tauri::generate_context!())
        .expect("the app could not start");
}
