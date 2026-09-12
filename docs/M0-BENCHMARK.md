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

### Desktop, LDE trace not cached

Pending. Expected: far lower peak memory, longer time on the first proof.

### Galaxy S24, Chrome, LDE trace not cached

Pending. Needs the phone on the same network as the serving machine.

## Levers if the phone misses the budget

1. No LDE cache (this build). Memory first, time second.
2. wasm threads via wasm-bindgen-rayon, cross-origin isolated page. Triton VM
   parallelises well; an S24 has eight cores.
3. wasm SIMD for Tip5 hashing.
4. Reduce the number of sub-proofs per send: one input per transaction is
   already the minimum; batching outputs does not change the count.
