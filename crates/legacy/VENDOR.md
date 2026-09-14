# Vendored crates for the pre-fork prover

Copies of the crates.io sources that `vault-prover-legacy` builds against,
patched the same way as `../vendor` so they compile for
`wasm32-unknown-unknown`. This directory is its own Cargo workspace (see
`Cargo.toml` here) with its own `[patch.crates-io]`, because the versions
differ from the ones the wallet core uses and one workspace cannot patch a
crate to two versions. `twenty-first` is shared with `../vendor`.

| Crate | Version | Changes |
|-------|---------|---------|
| neptune-consensus | 0.15.0 | tokio `process` and `rt-multi-thread` features only on non-wasm targets; `web-time` for `Instant` on wasm32; `prover_job.rs`: external-process prover, `process_util`, and tests compiled out on wasm32, `ProverJob::prove` panics there (proving goes through vault-prover-legacy instead). The 0.15 job queue has no multi-thread runtime builder, so nothing to gate there. |
| neptune-primitives | 0.15.0 | tokio `fs` feature only on non-wasm targets; `data_directory` module compiled out on wasm32; `web-time` for `SystemTime` in `timestamp.rs` on wasm32. |
| triton-vm | 7.0.0 | `no_profile` removed from the default features so the phase profiler is compiled in; `[lib] crate-type` reduced to `rlib` (the cdylib output of a path dependency has no hash in its name and collides between the build-script and normal builds). |

Reproduce: copy the crate from `~/.cargo/registry/src/*/<crate>-<version>`,
delete `.cargo_checksum.json` and `.cargo-ok`, then apply the changes above.

This directory exists only until the delta hardfork activates at mainnet
block 55,000; after that every proof is claim version 8 and the current
prover covers it. Delete `crates/legacy`, the `wasm:prover-legacy` script,
the workflow step and the `legacy` branch in `web/src/prover/worker.ts`.
