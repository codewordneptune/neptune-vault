//! The wallet core and the prover, as a native shell calls them.
//!
//! In a browser the web app reaches this same Rust as wasm in two workers,
//! and the worker holds the unlocked account in its own memory. A native
//! shell has no worker, so the account lives here instead, behind a mutex,
//! and is dropped on `lock` exactly as terminating the worker drops it.
//!
//! Nothing here knows which shell is calling. Tauri, or anything else, is a
//! thin layer of commands over these methods: it decodes arguments, hands
//! progress along, and turns [`BridgeError`] into whatever its own IPC
//! carries. Keeping that layer outside this crate means an Android or iOS
//! shell that is not Tauri can use the same bridge unchanged.
//!
//! Byte arguments arrive and leave as base64, which is what the shells'
//! JSON IPC carries cheaply; see the web app's `backend/native/bridge.ts`
//! for the other side of that decision.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_primitives::network::Network;
use serde::Serialize;
use serde_json::Value;
use vault_core::{account, amount, chain, kdf, scan, send};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// A failure, with the name the web app matches on.
///
/// The app tells a wrong password from a broken file, and a call cut off by
/// locking from a call that failed, so the name travels with the message and
/// the client turns it back into the class it already catches.
#[derive(Debug, Clone, Serialize)]
pub struct BridgeError {
    pub name: String,
    pub message: String,
}

impl BridgeError {
    fn new(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: name.to_string(),
            message: message.into(),
        }
    }

    fn plain(message: impl Into<String>) -> Self {
        Self::new("Error", message)
    }

    fn locked() -> Self {
        Self::new("WalletLockedError", "The wallet is locked.")
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BridgeError {}

impl From<anyhow::Error> for BridgeError {
    fn from(e: anyhow::Error) -> Self {
        Self::plain(format!("{e:#}"))
    }
}

pub type Result<T> = std::result::Result<T, BridgeError>;

fn decoding(what: &str, e: impl std::fmt::Display) -> BridgeError {
    BridgeError::plain(format!("cannot decode {what}: {e}"))
}

fn encoding(e: impl std::fmt::Display) -> BridgeError {
    BridgeError::plain(format!("cannot encode the result: {e}"))
}

fn parse_network(network: &str) -> Result<Network> {
    network
        .parse()
        .map_err(|_| BridgeError::plain(format!("unknown network: {network}")))
}

fn from_value<T: serde::de::DeserializeOwned>(what: &str, value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| decoding(what, e))
}

fn to_value<T: Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(encoding)
}

/// A JSON-RPC response as the node sends it; only `result` matters here.
#[derive(serde::Deserialize)]
struct Envelope<T> {
    result: T,
}

fn result_of<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T> {
    serde_json::from_str::<Envelope<T>>(text)
        .map(|e| e.result)
        .map_err(|e| decoding(what, e))
}

// ---------------------------------------------------------------------------
// Stateless calls
// ---------------------------------------------------------------------------

/// Version of the wallet core, for the diagnostics screen.
pub fn core_version() -> String {
    vault_core::version().to_string()
}

/// The claim version the rules require at a height (5 before the fork, 8 after).
pub fn claim_version(network: &str, block_height: u64) -> Result<u32> {
    let network = parse_network(network)?;
    let rule_set = ConsensusRuleSet::infer_from(network, block_height.into());
    Ok(vault_prover::claim_version(rule_set))
}

/// A fresh 18-word seed phrase.
pub fn generate_phrase() -> Vec<String> {
    account::Account::generate_phrase()
}

/// Argon2id key derivation for the seed envelope. Returns 32 bytes.
pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    m_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Vec<u8>> {
    kdf::derive_key(password, salt, m_kib, t_cost, p_cost)
        .map(|key| key.to_vec())
        .map_err(Into::into)
}

/// Parse an amount typed by a person into nau.
pub fn parse_amount(text: &str) -> Result<String> {
    amount::parse(text).map(amount::to_nau_string).map_err(Into::into)
}

/// Format an amount in nau for display.
pub fn format_amount(nau: &str) -> Result<String> {
    amount::from_nau_string(nau).map(amount::format).map_err(Into::into)
}

/// Whether `encoded` is a valid receiving address for `network`.
pub fn is_valid_address(encoded: &str, network: &str) -> Result<bool> {
    let network = parse_network(network)?;
    Ok(account::parse_recipient(encoded, network).is_ok())
}

/// Why `words` cannot be a seed phrase, in plain words, or none when they can.
pub fn phrase_problem(words: &[String]) -> Option<String> {
    account::phrase_problem(words)
}

/// Mock ProofCollection for mock-proof networks (regtest), bincode.
pub fn mock_proof_collection(witness: &[u8]) -> Result<Vec<u8>> {
    send::mock_proof_collection(witness).map_err(Into::into)
}

/// Combine a kernel and a proof collection into the transaction to submit.
pub fn assemble_submission(kernel: &[u8], proof_collection: &[u8]) -> Result<Value> {
    let request = send::assemble_submission(kernel, proof_collection)?;
    to_value(&request)
}

// ---------------------------------------------------------------------------
// The unlocked account
// ---------------------------------------------------------------------------

/// What `build_send` gives back: bytes for the prover and the assembler, and
/// the summary for the pending record.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendPlan {
    /// bincode `PrimitiveWitness`, base64.
    pub witness: String,
    /// bincode `TransactionKernel`, base64.
    pub kernel: String,
    pub summary: Value,
}

/// The wallet as the shell holds it: an account, or none while locked.
#[derive(Default)]
pub struct Vault {
    account: Mutex<Option<account::Account>>,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `f` against the unlocked account, or fail because there is none.
    fn with<T>(&self, f: impl FnOnce(&mut account::Account) -> Result<T>) -> Result<T> {
        let mut guard = self.account.lock().map_err(|_| BridgeError::locked())?;
        match guard.as_mut() {
            None => Err(BridgeError::locked()),
            Some(account) => f(account),
        }
    }

    /// Load an account from its phrase, replacing any already unlocked.
    pub fn unlock(&self, words: &[String], network: &str) -> Result<()> {
        let network = parse_network(network)?;
        let account = account::Account::from_phrase(words, network)?;
        let mut guard = self.account.lock().map_err(|_| BridgeError::locked())?;
        *guard = Some(account);
        Ok(())
    }

    /// Drop the account, and the seed with it.
    pub fn lock(&self) -> Result<()> {
        let mut guard = self.account.lock().map_err(|_| BridgeError::locked())?;
        *guard = None;
        Ok(())
    }

    pub fn is_unlocked(&self) -> bool {
        self.account
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// bech32m receiving address of the nth key of `kind`.
    pub fn address(&self, kind: &str, index: u64) -> Result<String> {
        let kind = account::KeyKind::parse(kind)?;
        self.with(|account| account.address(kind, index).map_err(Into::into))
    }

    /// The announcement flags of this wallet's keys up to the lookahead, as
    /// the JSON text of the index request. Text, because the identifiers are
    /// 64-bit values a JavaScript number cannot hold.
    pub fn announcement_flags(&self, next_key_indices: Value) -> Result<String> {
        let next_key_indices = from_value("next key indices", next_key_indices)?;
        self.with(|account| {
            let flags = scan::announcement_flags(account, &next_key_indices);
            serde_json::to_string(&flags).map_err(encoding)
        })
    }

    /// The absolute index sets of these coins, as the JSON text of the index
    /// request. Text for the same reason.
    pub fn absolute_index_sets(&self, unspent: Value) -> Result<String> {
        let unspent: Vec<scan::StoredUtxo> = from_value("unspent utxos", unspent)?;
        serde_json::to_string(&scan::absolute_index_sets(&unspent)).map_err(encoding)
    }

    /// Scan a batch of blocks. `blocks_response` is the node's raw JSON-RPC
    /// response text for `wallet_getBlocks`, kept as text so that its u64 and
    /// u128 values are not rounded on the way here.
    pub fn scan_blocks(
        &self,
        blocks_response: &str,
        unspent: Value,
        next_key_indices: Value,
        expectation: Value,
    ) -> Result<Value> {
        let expectation: chain::Expectation = from_value("the expectation", expectation)?;
        let blocks = result_of::<neptune_rpc_api::model::message::GetBlocksResponse>(
            "blocks",
            blocks_response,
        )?
        .blocks;
        let unspent = from_value("unspent utxos", unspent)?;
        let next_key_indices = from_value("next key indices", next_key_indices)?;
        self.with(|account| {
            let result =
                scan::scan_blocks(account, blocks, unspent, next_key_indices, &expectation)?;
            to_value(&result)
        })
    }

    /// Scan one unmined transaction. `kernel_response` is the node's raw
    /// JSON-RPC response text for `mempool_getTransactionKernel`; empty when
    /// the node no longer has the transaction.
    pub fn scan_mempool_kernel(
        &self,
        kernel_response: &str,
        unspent: Value,
        next_key_indices: Value,
        tip_height: u64,
    ) -> Result<Value> {
        let kernel = result_of::<neptune_rpc_api::model::message::GetTransactionKernelResponse>(
            "the mempool kernel",
            kernel_response,
        )?
        .kernel;
        let Some(kernel) = kernel else {
            return to_value(&scan::MempoolScan::default());
        };
        let kernel: neptune_consensus::transaction::transaction_kernel::TransactionKernel =
            kernel.into();
        let unspent: Vec<scan::StoredUtxo> = from_value("unspent utxos", unspent)?;
        let next_key_indices = from_value("next key indices", next_key_indices)?;
        self.with(|account| {
            let result =
                scan::scan_mempool_kernel(account, &kernel, &unspent, next_key_indices, tip_height);
            to_value(&result)
        })
    }

    /// Choose inputs for a send.
    pub fn plan_inputs(&self, unspent: Value, request: Value, now_ms: u64) -> Result<Value> {
        let unspent: Vec<scan::StoredUtxo> = from_value("unspent utxos", unspent)?;
        let request: send::SendRequest = from_value("the send request", request)?;
        let plan = send::plan_inputs(&unspent, &request, now_ms)?;
        to_value(&plan)
    }

    /// Build the witness for a send. `snapshot_response` is the node's raw
    /// response text for `wallet_restoreMembershipProof`, `tip_header_response`
    /// the raw text for `chain_tipHeader`.
    pub fn build_send(
        &self,
        inputs: Value,
        snapshot_response: &str,
        tip_header_response: &str,
        request: Value,
        now_ms: u64,
    ) -> Result<SendPlan> {
        let inputs: Vec<scan::StoredUtxo> = from_value("the inputs", inputs)?;
        let snapshot =
            result_of::<neptune_rpc_api::model::message::RestoreMembershipProofResponse>(
                "the membership proof snapshot",
                snapshot_response,
            )?
            .snapshot;
        let tip_header = result_of::<neptune_rpc_api::model::message::TipHeaderResponse>(
            "the tip header",
            tip_header_response,
        )?
        .header;
        let request: send::SendRequest = from_value("the send request", request)?;
        self.with(|account| {
            let plan =
                send::build_send(account, &inputs, snapshot, tip_header, &request, now_ms)?;
            Ok(SendPlan {
                witness: BASE64.encode(&plan.witness),
                kernel: BASE64.encode(&plan.kernel),
                summary: to_value(&plan.summary)?,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Proving
// ---------------------------------------------------------------------------

/// What proving reports, in the shape the web app already folds into a bar.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProveEvent {
    /// Sent once, before the first sub-proof.
    Ready { total: usize, threads: usize },
    #[serde(rename_all = "camelCase")]
    Started {
        name: String,
        index: usize,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    Finished {
        name: String,
        index: usize,
        total: usize,
        millis: f64,
        memory_bytes: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProveOutcome {
    /// bincode `ProofCollection`, base64.
    pub proof_collection: String,
    pub memory_bytes: u64,
    pub threads: usize,
}

/// Proving, and the one flag that stops it.
#[derive(Default)]
pub struct Prover {
    cancelled: AtomicBool,
}

impl Prover {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many threads to use when the caller asks for none in particular.
    pub fn default_threads() -> usize {
        num_cpus::get()
    }

    /// Ask the running proof to stop.
    ///
    /// The proof itself cannot be interrupted part-way: triton-vm reports
    /// progress but takes no say in whether to continue, so a cancelled run
    /// finishes its current sub-proof and is then abandoned, and its result
    /// discarded. The web client settles its own promise at once, so nothing
    /// on that side waits for this. Giving `prove_proof_collection` a
    /// "should I continue" callback would let the work stop at the next
    /// sub-proof boundary instead, and is the right follow-up.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Prove a ProofCollection for a bincode `PrimitiveWitness`.
    ///
    /// The rule set, and so the claim version, follows from the network and
    /// the height the transaction will be confirmed against. `progress` is
    /// called before and after every sub-proof.
    pub fn prove(
        &self,
        witness: &[u8],
        network: &str,
        block_height: u64,
        threads: usize,
        progress: &mut (dyn FnMut(ProveEvent) + Send),
    ) -> Result<ProveOutcome> {
        self.cancelled.store(false, Ordering::SeqCst);

        let witness: neptune_consensus::transaction::primitive_witness::PrimitiveWitness =
            bincode::deserialize(witness).map_err(|e| decoding("the witness", e))?;
        let network = parse_network(network)?;
        let rule_set = ConsensusRuleSet::infer_from(network, block_height.into());

        let threads = if threads == 0 {
            Self::default_threads()
        } else {
            threads
        };
        let total = vault_prover::num_sub_proofs(&witness);
        progress(ProveEvent::Ready { total, threads });

        let mut report = |event: vault_prover::ProgressEvent| match event {
            vault_prover::ProgressEvent::Started { name, index, total } => {
                progress(ProveEvent::Started { name, index, total })
            }
            vault_prover::ProgressEvent::Finished {
                name,
                index,
                total,
                millis,
                ..
            } => progress(ProveEvent::Finished {
                name,
                index,
                total,
                millis,
                memory_bytes: 0,
            }),
        };

        // A pool of exactly the requested size, so asking for fewer threads
        // means fewer, rather than however many rayon chose the first time.
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .map_err(|e| BridgeError::plain(format!("cannot start {threads} threads: {e}")))?;

        let collection = pool.install(|| {
            vault_prover::prove_proof_collection(
                &witness,
                rule_set,
                vault_prover::LdeTrace::Cache,
                false,
                &mut report,
            )
        })?;

        if self.cancelled.swap(false, Ordering::SeqCst) {
            return Err(BridgeError::new(
                "ProofCancelledError",
                "The proof was cancelled.",
            ));
        }

        let bytes = bincode::serialize(&collection)
            .map_err(|e| BridgeError::plain(format!("cannot encode the proof collection: {e}")))?;
        Ok(ProveOutcome {
            proof_collection: BASE64.encode(&bytes),
            memory_bytes: 0,
            threads,
        })
    }
}

/// Decode a base64 argument.
pub fn decode_bytes(what: &str, text: &str) -> Result<Vec<u8>> {
    BASE64.decode(text).map_err(|e| decoding(what, e))
}

/// Encode bytes for the return trip.
pub fn encode_bytes(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The state machine the whole native backend rests on: an account is
    /// there after unlocking, gone after locking, and asking while locked
    /// fails by the name the web app matches on.
    #[test]
    fn locking_drops_the_account() {
        let vault = Vault::new();
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.address("generation", 0).unwrap_err().name,
            "WalletLockedError"
        );

        let phrase = generate_phrase();
        vault.unlock(&phrase, "main").unwrap();
        assert!(vault.is_unlocked());

        let address = vault.address("generation", 0).unwrap();
        assert!(is_valid_address(&address, "main").unwrap());

        vault.lock().unwrap();
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.address("generation", 0).unwrap_err().name,
            "WalletLockedError"
        );
    }

    #[test]
    fn unlocking_again_replaces_the_account() {
        let vault = Vault::new();
        vault.unlock(&generate_phrase(), "main").unwrap();
        let first = vault.address("generation", 0).unwrap();
        vault.unlock(&generate_phrase(), "main").unwrap();
        assert_ne!(first, vault.address("generation", 0).unwrap());
    }

    #[test]
    fn amounts_survive_the_round_trip() {
        let nau = parse_amount("1.25").unwrap();
        assert_eq!(format_amount(&nau).unwrap(), "1.25");
        assert!(parse_amount("not an amount").is_err());
    }

    #[test]
    fn a_bad_phrase_is_explained() {
        assert!(phrase_problem(&["fish".to_string()]).is_some());
        assert!(phrase_problem(&generate_phrase()).is_none());
    }

    #[test]
    fn an_unknown_network_is_named_in_the_error() {
        let message = is_valid_address("anything", "narnia").unwrap_err().message;
        assert!(message.contains("narnia"), "{message}");
    }
}
