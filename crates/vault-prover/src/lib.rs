//! ProofCollection proving for Neptune Vault.
//!
//! The Rust core in [`collection`] runs natively and in the browser. The
//! wasm-bindgen surface below is what the web app's prover worker calls.

pub mod collection;

pub use collection::claim_version;
pub use collection::num_sub_proofs;
pub use collection::prove_proof_collection;
pub use collection::LdeTrace;
pub use collection::ProgressEvent;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
    use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
    use neptune_primitives::network::Network;
    use wasm_bindgen::prelude::*;

    /// Version of the prover package, for the UI's diagnostics screen.
    #[wasm_bindgen]
    pub fn prover_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Number of Triton VM proofs a ProofCollection for this witness needs.
    ///
    /// `witness` is a bincode-serialized `PrimitiveWitness`.
    #[wasm_bindgen]
    pub fn count_sub_proofs(witness: &[u8]) -> Result<usize, JsError> {
        let witness: PrimitiveWitness = bincode::deserialize(witness)
            .map_err(|e| JsError::new(&format!("cannot decode witness: {e}")))?;
        Ok(super::num_sub_proofs(&witness))
    }

    /// Prove a ProofCollection for a bincode-serialized `PrimitiveWitness`.
    ///
    /// The rule set (and so the claim version) is inferred from `network`
    /// ("main", "testnet", ...) and the height of the block the transaction
    /// will be confirmed against. `cache_lde_trace` trades memory for speed,
    /// see `LdeTrace`. `on_progress` receives one JSON string per event, see
    /// `ProgressEvent`. Returns the bincode-serialized `ProofCollection`.
    #[wasm_bindgen]
    pub fn prove_proof_collection(
        witness: &[u8],
        network: &str,
        block_height: u64,
        cache_lde_trace: bool,
        on_progress: &js_sys::Function,
    ) -> Result<Vec<u8>, JsError> {
        console_error_panic_hook::set_once();

        let witness: PrimitiveWitness = bincode::deserialize(witness)
            .map_err(|e| JsError::new(&format!("cannot decode witness: {e}")))?;
        let network: Network = network
            .parse()
            .map_err(|_| JsError::new(&format!("unknown network: {network}")))?;
        let rule_set = ConsensusRuleSet::infer_from(network, block_height.into());

        let mut report = |event: super::ProgressEvent| {
            let json = serde_json::to_string(&event).unwrap_or_default();
            let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_str(&json));
        };

        let lde_trace = if cache_lde_trace {
            super::LdeTrace::Cache
        } else {
            super::LdeTrace::NoCache
        };
        let collection = super::prove_proof_collection(&witness, rule_set, lde_trace, &mut report)
            .map_err(|e| JsError::new(&format!("{e:#}")))?;
        bincode::serialize(&collection)
            .map_err(|e| JsError::new(&format!("cannot encode proof collection: {e}")))
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
