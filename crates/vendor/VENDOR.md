# Vendored crates

Copies of the published crates.io sources, patched so they build for
`wasm32-unknown-unknown`. Applied through `[patch.crates-io]` in the root
Cargo.toml. Versions must stay equal to the published ones or the patch will
not apply.

| Crate | Version | Changes |
|-------|---------|---------|
| neptune-consensus | 0.19.0 | `triton_vm_job_queue.rs`: current-thread runtime on wasm32; tokio `process` and `rt-multi-thread` features only on non-wasm targets; `web-time` for `Instant` on wasm32; `prover_job.rs`: external-process prover, `process_util`, and tests compiled out on wasm32, `ProverJob::prove` panics there (proving goes through vault-prover instead). |
| neptune-primitives | 0.19.0 | tokio `fs` feature only on non-wasm targets; `data_directory` module compiled out on wasm32; `web-time` for `SystemTime` in `timestamp.rs` on wasm32. |
| twenty-first | 3.0.0 | `[lib] crate-type` reduced to `rlib` (the cdylib output of a path dependency has no hash in its name and collides between the build-script and normal builds). Nothing else: 3.0.0 computes `XFieldElement::inverse` without allocating, which Vault patched in for 1.1.0. |
| triton-vm | 9.0.0 | `no_profile` removed from the default features so the phase profiler is compiled in; dependents force a default feature on, so it cannot be switched from the workspace otherwise. Idle cost is one thread-local check per phase. `jemalloc` stays a default: it makes jemalloc the global allocator on Linux and macOS only (so the desktop app there, not Android, Windows or the browser), which is upstream's choice for proving speed. `[lib] crate-type` reduced to `rlib` for the same collision reason as twenty-first. |

Reproduce: copy the crate from `~/.cargo/registry/src/*/<crate>-<version>`,
delete `.cargo-ok`, then apply the changes above.
The goal is to upstream them as target cfgs in neptune-core and delete this
directory.
