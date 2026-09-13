# Vendored crates

Copies of the published crates.io sources, patched so they build for
`wasm32-unknown-unknown`. Applied through `[patch.crates-io]` in the root
Cargo.toml. Versions must stay equal to the published ones or the patch will
not apply.

| Crate | Version | Changes |
|-------|---------|---------|
| neptune-consensus | 0.17.0 | `triton_vm_job_queue.rs`: current-thread runtime on wasm32; tokio `process` and `rt-multi-thread` features only on non-wasm targets; `web-time` for `Instant` on wasm32; `prover_job.rs`: external-process prover, `process_util`, and tests compiled out on wasm32, `ProverJob::prove` panics there (proving goes through vault-prover instead). |
| neptune-primitives | 0.17.0 | tokio `fs` feature only on non-wasm targets; `data_directory` module compiled out on wasm32; `web-time` for `SystemTime` in `timestamp.rs` on wasm32. |
| twenty-first | 1.1.0 | `XFieldElement::inverse` computes the inverse through the field norm (`a^p * a^{p^2} / N(a)`) instead of a polynomial extended GCD. Same result, no allocations. The GCD version allocates several vectors per call, and with wasm threads every allocation serialises on one lock, which made the prover's DEEP phase slower with more threads. A test pins the new inverse to the GCD one on 20,000 random elements. Not target-gated: it is also faster natively. |

Reproduce: copy the crate from `~/.cargo/registry/src/*/<crate>-<version>`,
delete `.cargo_checksum.json` and `.cargo-ok`, then apply the changes above.
The goal is to upstream them as target cfgs in neptune-core and delete this
directory.
