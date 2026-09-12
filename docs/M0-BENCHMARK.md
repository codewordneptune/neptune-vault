# Milestone 0: in-browser proving benchmark

Goal (ARCHITECTURE.md section 10): prove one real ProofCollection for a
one-input, two-output transaction inside a browser, and measure time and
memory per sub-proof. The decision it feeds: is R1 (proving on the phone,
no server) viable on the Galaxy S24 within R23 (10 minutes)?

## Setup

- Prover: `crates/vault-prover`, triton-vm 8.0.0, built with wasm-pack in
  release mode, no wasm-opt, single-threaded (no wasm threads yet).
- Witness: `fixtures/witness_1in_2out.bin`, a deterministic valid
  `PrimitiveWitness` from the consensus crate's own generator, 1 input, 2
  outputs, 1 lock script, 1 type script. Six sub-proofs. Claims stamped for
  hardfork delta (version 8).
- Harness: `web/prover-bench/`, proving in a Web Worker, wasm memory read
  after every sub-proof (linear memory only grows, so it is a peak).
- Run: `node web/prover-bench/serve.js` and open the printed URL.

## Results

### Desktop, Chrome 152, 16 cores, 32 GB, LDE trace cached (default)

| # | Sub-proof | Time (s) | Proof (KB) | Wasm memory after (MB) |
|---|-----------|---------:|-----------:|-----------------------:|
| 1 | removal_records_integrity | 378.3 | | 3396 |
| 2 | collect_lock_scripts | 21.2 | | 3396 |
| 3 | kernel_to_outputs | 42.7 | | 3396 |
| 4 | collect_type_scripts | 36.1 | | 3396 |
| 5 | lock_script_0 | 2.3 | | 3396 |
| 6 | type_script_0 | 76.0 | | 3396 |
| | Total | 556.9 | 4236 total | 3396 peak |

First ever ProofCollection proven in a browser, 2026-09-12. Two conclusions:

- The removal-records-integrity proof dominates both time and memory. Its
  padded trace is the largest, and with Triton VM's default LDE-trace cache
  the memory climbs to 3.4 GB. That is within the 4 GB wasm32 limit on a
  desktop, but a phone will not grant a tab that much.
- Single-threaded wasm is roughly five to ten times slower than the native
  multi-threaded desktop wallet on the same class of machine.

### Correctness check, native

`cargo test --release -p vault-prover -- --ignored` proves the same witness
natively with vault-prover's code (no LDE cache, 16 cores) and hands the
result to the consensus crate's `TransactionProof::verify` under hardfork
delta, which is what a node runs on submission. It passes. Times: removal
records integrity 45.9 s, collect lock scripts 2.7 s, kernel to outputs 5.0 s,
collect type scripts 4.7 s, lock script 0.4 s, type script 9.4 s, total
68.7 s. So the browser output is the same computation the node accepts, and
the browser's slowdown is purely the single-threaded, non-SIMD wasm target.

### Desktop, Chrome 152, LDE trace not cached

| # | Sub-proof | Time (s) | Wasm memory after (MB) |
|---|-----------|---------:|-----------------------:|
| 1 | removal_records_integrity | 277.4 | 896 |
| 2 | collect_lock_scripts | 15.8 | 896 |
| 3 | kernel_to_outputs | 36.3 | 896 |
| 4 | collect_type_scripts | 30.5 | 896 |
| 5 | lock_script_0 | 4.1 | 896 |
| 6 | type_script_0 | 64.1 | 896 |
| | Total | 428.3 | 896 peak |

Not caching the LDE trace is both smaller and faster in wasm: peak memory
falls from 3396 MB to 896 MB and total time from 557 s to 428 s. Growing
linear memory by gigabytes is itself expensive in the browser, so the cache
never pays off there. No-cache is therefore the default for the PWA, and the
cache switch stays only for experiments.

896 MB is a size a modern phone's browser will grant a worker. The open
question for the S24 is time: a phone core is slower than a desktop core, so
a single-threaded run is expected to land near or above the 10 minute budget.
Threads (lever 2 below) are the planned answer if it does.

### Galaxy S24, Chrome, LDE trace not cached

Run by the user on 2026-09-13. Chrome 152 on Android, 10 cores reported,
page served over plain http from the PC (so not cross-origin isolated).

| # | Sub-proof | Time (s) | Proof (KB) | Wasm memory after (MB) |
|---|-----------|---------:|-----------:|-----------------------:|
| 1 | removal_records_integrity | 308.8 | 106 | 896 |
| 2 | collect_lock_scripts | 14.6 | 83 | 896 |
| 3 | kernel_to_outputs | 34.5 | 88 | 896 |
| 4 | collect_type_scripts | 31.4 | 89 | 896 |
| 5 | lock_script_0 | 3.0 | 70 | 896 |
| 6 | type_script_0 | 62.9 | 94 | 896 |
| | Total | 456.0 | 4252 | 896 peak |

Inside the 10 minute budget (R23) with no optimisation at all, and only
seven percent slower than the desktop run: the phone's big core is nearly as
fast as a laptop core on this single-threaded workload. M0 passes.

Note for the threaded build: wasm threads need `crossOriginIsolated`, which
requires a secure context. The bench must then be served over https (or the
origin whitelisted in `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
on the phone).

### Comparison: native Android wallet

zeokin/npt-mobile-wallet, a Tauri Android app on neptune-cash 0.11.0 and
triton-vm 3.0.0, sends in about 30 s on the same S24 according to the user.
It proves the same six ProofCollection sub-proofs on the device
(`src-tauri/src/transaction.rs`), so the gap is compilation and runtime, not
a different protocol:

- native ARM64 with rayon on all 8 cores, versus one wasm thread;
- NEON, LTO and opt-level 3, versus wasm32 without SIMD or wasm-opt;
- Triton VM's LDE cache on (memory permitting), versus off here;
- an older proof system (triton-vm 3) whose consensus programs differ from
  the 0.17 ones proven here, so the traces are not the same size.

Together that is the observed 15x. Threads and SIMD (levers 2 and 3) are the
part of it a PWA can recover; a realistic target on the S24 is 60 to 120 s.

## Levers if the phone misses the budget

1. No LDE cache (this build). Memory first, time second.
2. wasm threads via wasm-bindgen-rayon, cross-origin isolated page. Triton VM
   parallelises well; an S24 has eight cores.
3. wasm SIMD for Tip5 hashing.
4. Reduce the number of sub-proofs per send: one input per transaction is
   already the minimum; batching outputs does not change the count.
