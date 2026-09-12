//! Wallet core for Neptune Vault.
//!
//! Milestone 0 skeleton: proves that the wallet, mutator-set and RPC model
//! crates link for wasm32. The wallet API is added in milestone 1.

use wasm_bindgen::prelude::*;

/// Version of the wallet core package, for the UI's diagnostics screen.
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
