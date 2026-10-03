# Vendored crates

Copies of four crates as published on crates.io, with small changes: the
two Neptune crates so they build for `wasm32-unknown-unknown`, and
triton-vm and twenty-first so they build as path dependencies, with Triton
VM's phase profiler compiled in. Applied through `[patch.crates-io]` in the
root Cargo.toml. Versions must stay equal to the published ones or the
patch will not apply.

| Crate | Version | Changes |
|-------|---------|---------|
| neptune-consensus | 0.19.0 | `Cargo.toml`: tokio's `process` and `rt-multi-thread` features only on non-wasm targets, `web-time` on wasm32. `lib.rs`: `web-time`'s `Instant` on wasm32. `triton_vm_job_queue.rs`: a current-thread runtime on wasm32. `prover_job.rs`: the external-process prover, `process_util` and the tests compiled out on wasm32, where `ProverJob::prove` panics (proving goes through vault-prover instead). |
| neptune-primitives | 0.19.0 | tokio `fs` feature only on non-wasm targets; `data_directory` module compiled out on wasm32; `web-time` for `SystemTime` in `timestamp.rs` on wasm32. |
| twenty-first | 3.0.0 | `[lib] crate-type` reduced to `rlib` (the cdylib output of a path dependency has no hash in its name and collides between the build-script and normal builds). Nothing else: 3.0.0 computes `XFieldElement::inverse` without allocating, which Vault patched in for 1.1.0. |
| triton-vm | 9.0.0 | `no_profile` removed from the default features, so the phase profiler is compiled in. (vault-prover is the only crate that takes triton-vm's defaults, so `default-features = false, features = ["jemalloc"]` there would do the same.) Idle cost: a thread-local check where each phase starts and stops. `jemalloc` stays a default: it makes jemalloc the global allocator on Linux and macOS only (so the desktop app there, not Android, Windows or the browser), which is upstream's choice for proving speed. `[lib] crate-type` reduced to `rlib` for the same collision reason as twenty-first. |

Reproduce: copy the crate from `~/.cargo/registry/src/*/<crate>-<version>`,
delete `.cargo-ok`, then apply the changes above.

Update: raise the version in the vault-* manifests that use the crate. The
old copy then no longer matches (cargo warns that the patch is unused), so
cargo fetches the new release into `~/.cargo/registry/src/*/<crate>-<version>`.
Replace the folder with it, delete `.cargo-ok`, apply the changes above to
`Cargo.toml` (not `Cargo.toml.orig`) and the sources, and update this
table. A crate added here also needs an entry under `[patch.crates-io]` and
in `exclude` in the root Cargo.toml.

The goal is to upstream the wasm32 changes as target cfgs in neptune-core,
and the `crate-type` change in triton-vm and twenty-first, then delete this
directory.
