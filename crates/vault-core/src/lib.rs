//! Wallet core for Neptune Vault.
//!
//! The Rust modules run natively (for tests) and in the browser. The
//! wasm-bindgen surface at the bottom is what the web app's wallet worker
//! calls. Data crosses the boundary as JSON strings for anything the node
//! also speaks in JSON, and as byte arrays for witnesses, kernels and proofs.

pub mod account;
pub mod amount;
pub mod chain;
pub mod kdf;
pub mod ledger;
pub mod migrate;
pub mod scan;
pub mod send;
pub mod store;

/// Version of this package, for the diagnostics screen. Read here rather
/// than in each wrapper, so every caller reports the core it is actually
/// running.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use neptune_primitives::network::Network;
    use wasm_bindgen::prelude::*;

    use crate::account;
    use crate::amount;
    use crate::chain;
    use crate::kdf;
    use crate::ledger;
    use crate::migrate;
    use crate::scan;
    use crate::send;
    use crate::store;

    /// A JSON-RPC response as the node sends it; only `result` matters here.
    #[derive(serde::Deserialize)]
    struct Envelope<T> {
        result: T,
    }

    fn js_err(e: anyhow::Error) -> JsError {
        JsError::new(&format!("{e:#}"))
    }

    fn parse_network(network: &str) -> Result<Network, JsError> {
        network
            .parse()
            .map_err(|_| JsError::new(&format!("unknown network: {network}")))
    }

    /// Version of the wallet core package, for the diagnostics screen.
    #[wasm_bindgen]
    pub fn core_version() -> String {
        crate::version().to_string()
    }

    /// A fresh 18-word seed phrase.
    #[wasm_bindgen]
    pub fn generate_phrase() -> Vec<String> {
        console_error_panic_hook::set_once();
        account::Account::generate_phrase()
    }

    /// Argon2id key derivation for the seed envelope. Returns 32 bytes.
    #[wasm_bindgen]
    pub fn derive_key(
        password: &[u8],
        salt: &[u8],
        m_kib: u32,
        t_cost: u32,
        p_cost: u32,
    ) -> Result<Vec<u8>, JsError> {
        let key = kdf::derive_key(password, salt, m_kib, t_cost, p_cost).map_err(js_err)?;
        Ok(key.to_vec())
    }

    /// Parse an NPT amount; returns the amount in nau as a decimal string.
    #[wasm_bindgen]
    pub fn parse_amount(text: &str) -> Result<String, JsError> {
        amount::parse(text).map(amount::to_nau_string).map_err(js_err)
    }

    /// Format an amount given in nau as a decimal string.
    #[wasm_bindgen]
    pub fn format_amount(nau: &str) -> Result<String, JsError> {
        amount::from_nau_string(nau).map(amount::format).map_err(js_err)
    }

    /// The Triton VM claim version the consensus rules require for a
    /// transaction confirmed against `block_height` on `network`: 5 before
    /// the delta fork, 8 after. The app picks the prover package by it.
    #[wasm_bindgen]
    pub fn claim_version(network: &str, block_height: u64) -> Result<u32, JsError> {
        use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
        use neptune_consensus::consensus_rule_set::TritonProofVersion;
        let network = parse_network(network)?;
        let rule_set = ConsensusRuleSet::infer_from(network, block_height.into());
        Ok(match rule_set.triton_proof_version() {
            TritonProofVersion::V0 => 0,
            TritonProofVersion::V1 => 1,
            TritonProofVersion::V5 => 5,
            TritonProofVersion::V8 => 8,
        })
    }

    /// Whether `encoded` is a valid receiving address for `network`.
    #[wasm_bindgen]
    pub fn is_valid_address(encoded: &str, network: &str) -> Result<bool, JsError> {
        let network = parse_network(network)?;
        Ok(account::parse_recipient(encoded, network).is_ok())
    }

    /// Why `words` cannot be a seed phrase, or undefined when they can.
    #[wasm_bindgen]
    pub fn phrase_problem(words: Vec<String>) -> Option<String> {
        account::phrase_problem(&words)
    }

    /// An unlocked account. Holds the seed in wasm memory; drop it to lock.
    #[wasm_bindgen]
    pub struct Account(account::Account);

    #[wasm_bindgen]
    impl Account {
        #[wasm_bindgen(constructor)]
        pub fn from_phrase(words: Vec<String>, network: &str) -> Result<Account, JsError> {
            console_error_panic_hook::set_once();
            let network = parse_network(network)?;
            account::Account::from_phrase(&words, network)
                .map(Account)
                .map_err(js_err)
        }

        // There is deliberately no way to read the phrase back out of an
        // unlocked account. Showing it means opening the stored envelope
        // with the password again, so neither a person holding an unlocked
        // phone nor a script in the page gets it for the asking.

        /// bech32m receiving address of the nth key of `kind`
        /// (`generation`, `ec_hybrid` or `viewing`).
        pub fn address(&mut self, kind: &str, index: u64) -> Result<String, JsError> {
            let kind = account::KeyKind::parse(kind).map_err(js_err)?;
            self.0.address(kind, index).map_err(js_err)
        }

        /// Scan a batch of blocks. `blocks_response` is the node's raw
        /// JSON-RPC response text for `wallet_getBlocks` (kept as text so
        /// u64 and u128 values are not rounded by JavaScript), `unspent_json`
        /// the app's unspent `StoredUtxo` array, `next_key_indices_json` a
        /// `NextKeyIndices`. Returns a `ScanResult` as JSON.
        pub fn scan_blocks(
            &mut self,
            blocks_response: &str,
            unspent_json: &str,
            next_key_indices_json: &str,
            expectation_json: &str,
        ) -> Result<String, JsError> {
            let expectation: chain::Expectation = serde_json::from_str(expectation_json)
                .map_err(|e| JsError::new(&format!("cannot decode the expectation: {e}")))?;
            let envelope: Envelope<neptune_rpc_api::model::message::GetBlocksResponse> =
                serde_json::from_str(blocks_response)
                    .map_err(|e| JsError::new(&format!("cannot decode blocks: {e}")))?;
            let blocks = envelope.result.blocks;
            let unspent = serde_json::from_str(unspent_json)
                .map_err(|e| JsError::new(&format!("cannot decode unspent utxos: {e}")))?;
            let next_key_indices = serde_json::from_str(next_key_indices_json)
                .map_err(|e| JsError::new(&format!("cannot decode next key indices: {e}")))?;
            let result = scan::scan_blocks(&mut self.0, blocks, unspent, next_key_indices, &expectation)
                .map_err(js_err)?;
            serde_json::to_string(&result).map_err(|e| JsError::new(&e.to_string()))
        }

        /// Scan one unmined transaction. `kernel_response` is the node's raw
        /// JSON-RPC response text for `mempool_getTransactionKernel`; the other
        /// arguments are as for `scan_blocks`. Returns a `MempoolScan` as JSON,
        /// empty when the node no longer has the transaction.
        pub fn scan_mempool_kernel(
            &mut self,
            kernel_response: &str,
            unspent_json: &str,
            next_key_indices_json: &str,
            tip_height: f64,
        ) -> Result<String, JsError> {
            let envelope: Envelope<neptune_rpc_api::model::message::GetTransactionKernelResponse> =
                serde_json::from_str(kernel_response)
                    .map_err(|e| JsError::new(&format!("cannot decode mempool kernel: {e}")))?;
            let result = match envelope.result.kernel {
                None => scan::MempoolScan::default(),
                Some(kernel) => {
                    let kernel: neptune_consensus::transaction::transaction_kernel::TransactionKernel = kernel.into();
                    let unspent: Vec<scan::StoredUtxo> = serde_json::from_str(unspent_json)
                        .map_err(|e| JsError::new(&format!("cannot decode unspent utxos: {e}")))?;
                    let next_key_indices = serde_json::from_str(next_key_indices_json)
                        .map_err(|e| JsError::new(&format!("cannot decode next key indices: {e}")))?;
                    scan::scan_mempool_kernel(&mut self.0, &kernel, &unspent, next_key_indices, tip_height as u64)
                }
            };
            serde_json::to_string(&result).map_err(|e| JsError::new(&e.to_string()))
        }

        /// The announcement flags of this wallet's keys up to the lookahead, as
        /// the JSON parameter of `utxoindex_blockHeightsByFlags`. Kept as text:
        /// the identifiers are 64-bit values JavaScript numbers cannot hold.
        pub fn announcement_flags(&mut self, next_key_indices_json: &str) -> Result<String, JsError> {
            let next_key_indices = serde_json::from_str(next_key_indices_json)
                .map_err(|e| JsError::new(&format!("cannot decode next key indices: {e}")))?;
            let flags = scan::announcement_flags(&mut self.0, &next_key_indices);
            serde_json::to_string(&flags).map_err(|e| JsError::new(&e.to_string()))
        }

        /// The absolute index sets of `unspent_json`, as the JSON parameter of
        /// `utxoindex_blockHeightsByAbsoluteIndexSets` (and of the
        /// membership-proof request). Kept as text for the same reason.
        pub fn absolute_index_sets(&self, unspent_json: &str) -> Result<String, JsError> {
            let unspent: Vec<scan::StoredUtxo> = serde_json::from_str(unspent_json)
                .map_err(|e| JsError::new(&format!("cannot decode unspent utxos: {e}")))?;
            serde_json::to_string(&scan::absolute_index_sets(&unspent)).map_err(|e| JsError::new(&e.to_string()))
        }

        /// Choose inputs for a send. Returns an `InputPlan` as JSON, whose
        /// `absolute_index_sets` is the parameter of `wallet_restoreMembershipProof`.
        pub fn plan_inputs(
            &self,
            unspent_json: &str,
            request_json: &str,
            now_ms: f64,
        ) -> Result<String, JsError> {
            let unspent: Vec<scan::StoredUtxo> = serde_json::from_str(unspent_json)
                .map_err(|e| JsError::new(&format!("cannot decode unspent utxos: {e}")))?;
            let request: send::SendRequest = serde_json::from_str(request_json)
                .map_err(|e| JsError::new(&format!("cannot decode send request: {e}")))?;
            let plan = send::plan_inputs(&unspent, &request, now_ms as u64).map_err(js_err)?;
            serde_json::to_string(&plan).map_err(|e| JsError::new(&e.to_string()))
        }

        /// Build the witness for a send. `snapshot_response` is the node's raw
        /// JSON-RPC response text for `wallet_restoreMembershipProof`,
        /// `tip_header_response` the raw text for `chain_tipHeader`.
        pub fn build_send(
            &mut self,
            inputs_json: &str,
            snapshot_response: &str,
            tip_header_response: &str,
            request_json: &str,
            now_ms: f64,
        ) -> Result<SendPlan, JsError> {
            let inputs: Vec<scan::StoredUtxo> = serde_json::from_str(inputs_json)
                .map_err(|e| JsError::new(&format!("cannot decode inputs: {e}")))?;
            let snapshot: Envelope<neptune_rpc_api::model::message::RestoreMembershipProofResponse> =
                serde_json::from_str(snapshot_response)
                    .map_err(|e| JsError::new(&format!("cannot decode membership proof snapshot: {e}")))?;
            let snapshot = snapshot.result.snapshot;
            let tip_header: Envelope<neptune_rpc_api::model::message::TipHeaderResponse> =
                serde_json::from_str(tip_header_response)
                    .map_err(|e| JsError::new(&format!("cannot decode tip header: {e}")))?;
            let tip_header = tip_header.result.header;
            let request: send::SendRequest = serde_json::from_str(request_json)
                .map_err(|e| JsError::new(&format!("cannot decode send request: {e}")))?;
            send::build_send(&mut self.0, &inputs, snapshot, tip_header, &request, now_ms as u64)
                .map(SendPlan)
                .map_err(js_err)
        }
    }

    /// Result of `build_send`: bytes for the prover and the assembler, and a
    /// JSON summary for the pending record.
    #[wasm_bindgen]
    pub struct SendPlan(send::SendPlan);

    #[wasm_bindgen]
    impl SendPlan {
        /// bincode `PrimitiveWitness`, the prover's input.
        pub fn witness(&self) -> Vec<u8> {
            self.0.witness.clone()
        }

        /// bincode `TransactionKernel`, for `assemble_submission`.
        pub fn kernel(&self) -> Vec<u8> {
            self.0.kernel.clone()
        }

        /// `SendSummary` as JSON.
        pub fn summary(&self) -> Result<String, JsError> {
            serde_json::to_string(&self.0.summary).map_err(|e| JsError::new(&e.to_string()))
        }
    }

    /// One wallet's sealed log, held by the wallet worker while that wallet
    /// is unlocked. The worker owns the storage and the order of things:
    /// it asks for a batch to be prepared, writes the bytes, and only then
    /// confirms. The key is derived in here from the content key and is
    /// never handed back out.
    #[wasm_bindgen]
    pub struct WalletLog {
        wallet_id: String,
        log: store::Log<store::WalletState>,
        pending: Option<store::Prepared<store::WalletState>>,
    }

    #[wasm_bindgen]
    impl WalletLog {
        /// Open a wallet's log from what storage holds. `entries` is an array
        /// of Uint8Array, in any order; empty for a wallet that has no log yet.
        #[wasm_bindgen(constructor)]
        pub fn open(wallet_id: &str, content_key: &[u8], entries: js_sys::Array) -> Result<WalletLog, JsError> {
            console_error_panic_hook::set_once();
            let key = store::LogKey::derive(content_key, wallet_id).map_err(js_err)?;
            let entries = entries.iter().map(|e| js_sys::Uint8Array::new(&e).to_vec()).collect();
            let log = store::Log::open(&store::wallet_log(wallet_id), Some(key), entries).map_err(js_err)?;
            Ok(WalletLog { wallet_id: wallet_id.to_string(), log, pending: None })
        }

        /// The name storage keeps this log under.
        pub fn name(&self) -> String {
            self.log.name().to_string()
        }

        /// The number of the last entry applied.
        pub fn seq(&self) -> f64 {
            self.log.seq() as f64
        }

        /// The parts of this wallet that live in this log and nowhere else.
        pub fn migrated(&self) -> Vec<String> {
            self.log.state().migrated.iter().cloned().collect()
        }

        /// The records of one part, as a JSON array in the app's own shape.
        pub fn read(&self, part: &str) -> Result<String, JsError> {
            let records = migrate::part_records(self.log.state(), part).map_err(js_err)?;
            serde_json::to_string(&records).map_err(|e| JsError::new(&e.to_string()))
        }

        fn hold(&mut self, prepared: store::Prepared<store::WalletState>) -> Vec<u8> {
            let bytes = prepared.bytes.clone();
            self.pending = Some(prepared);
            bytes
        }

        /// Check and seal a batch of changes (a JSON array). Returns the bytes
        /// to write as entry `pending_seq`; nothing changes until `confirm`.
        pub fn prepare(&mut self, changes_json: &str) -> Result<Vec<u8>, JsError> {
            let changes: Vec<store::WalletChange> = serde_json::from_str(changes_json)
                .map_err(|e| JsError::new(&format!("cannot decode the changes: {e}")))?;
            let prepared = self.log.prepare(changes).map_err(js_err)?;
            Ok(self.hold(prepared))
        }

        /// The same for one part coming over from the app's old database.
        /// `dump_json` is what that database holds. The batch is checked
        /// against the dump, record for record, before it is prepared, so a
        /// part that would not come through unchanged is never written.
        pub fn prepare_migration(&mut self, dump_json: &str, parts_json: &str) -> Result<Vec<u8>, JsError> {
            let dump: migrate::Dump = serde_json::from_str(dump_json)
                .map_err(|e| JsError::new(&format!("cannot decode the old database: {e}")))?;
            let parts: Vec<String> = serde_json::from_str(parts_json)
                .map_err(|e| JsError::new(&format!("cannot decode the parts: {e}")))?;
            let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
            let changes = migrate::parts_changes(&dump, &self.wallet_id, &parts).map_err(js_err)?;
            let would_be = self.log.preview(&changes).map_err(js_err)?;
            for part in &parts {
                migrate::verify_part(&dump, &self.wallet_id, part, &would_be).map_err(js_err)?;
            }
            let prepared = self.log.prepare(changes).map_err(js_err)?;
            Ok(self.hold(prepared))
        }

        /// Run one ledger operation (a JSON `{ "op": ... }`) against the wallet
        /// as it is. When it changes anything, the batch is prepared and
        /// waits for the worker to write it: `pending_bytes`, then `confirm`.
        /// Returns the operation's answer as JSON.
        pub fn run(&mut self, op_json: &str) -> Result<String, JsError> {
            self.run_op(op_json, None)
        }

        /// The same for an operation that needs the wallet's keys.
        pub fn run_with_keys(&mut self, account: &mut Account, op_json: &str) -> Result<String, JsError> {
            self.run_op(op_json, Some(&mut account.0))
        }

        fn run_op(&mut self, op_json: &str, keys: Option<&mut crate::account::Account>) -> Result<String, JsError> {
            if self.pending.is_some() {
                return Err(JsError::new("a batch is already waiting to be written"));
            }
            let op: ledger::op::Op = serde_json::from_str(op_json)
                .map_err(|e| JsError::new(&format!("cannot decode the operation: {e}")))?;
            let outcome = ledger::op::run(self.log.state(), &self.wallet_id, op, keys).map_err(js_err)?;
            if !outcome.changes.is_empty() {
                let prepared = self.log.prepare(outcome.changes).map_err(js_err)?;
                self.hold(prepared);
            }
            serde_json::to_string(&outcome.value).map_err(|e| JsError::new(&e.to_string()))
        }

        /// The bytes of the batch waiting to be written, if any.
        pub fn pending_bytes(&self) -> Option<Vec<u8>> {
            self.pending.as_ref().map(|p| p.bytes.clone())
        }

        /// The number the prepared batch is to be written under.
        pub fn pending_seq(&self) -> Option<f64> {
            self.pending.as_ref().map(|p| p.seq as f64)
        }

        /// Apply the prepared batch, now that storage holds it.
        pub fn confirm(&mut self) -> Result<(), JsError> {
            let prepared = self.pending.take().ok_or_else(|| JsError::new("no batch is waiting"))?;
            self.log.confirm(prepared).map_err(js_err)
        }

        /// Drop the prepared batch: the write failed, and nothing changed.
        pub fn abandon(&mut self) {
            self.pending = None;
        }

        /// The whole state, sealed, numbered as the last batch it includes.
        pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
            self.log.snapshot().map_err(js_err)
        }
    }

    /// Mock ProofCollection for mock-proof networks (regtest), bincode.
    #[wasm_bindgen]
    pub fn mock_proof_collection(witness: &[u8]) -> Result<Vec<u8>, JsError> {
        send::mock_proof_collection(witness).map_err(js_err)
    }

    /// Combine a kernel and a proof collection into the transaction JSON,
    /// the parameter of `wallet_submitTransaction`.
    #[wasm_bindgen]
    pub fn assemble_submission(kernel: &[u8], proof_collection: &[u8]) -> Result<String, JsError> {
        let request = send::assemble_submission(kernel, proof_collection).map_err(js_err)?;
        serde_json::to_string(&request).map_err(|e| JsError::new(&e.to_string()))
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
