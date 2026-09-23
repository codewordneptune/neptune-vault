# Milestone 0: in-browser proving benchmark

> **Historical record.** These measurements were made in September 2026 for
> milestone M0, before the app existed, and are kept as the reference for
> proving cost. The setup below describes that first run; the shipped
> prover is threaded and optimised with wasm-opt, as the later sections
> record. To reproduce, use the bench page described in
> [web/prover-bench/README.md](../web/prover-bench/README.md).

Goal: prove one real ProofCollection for a
one-input, two-output transaction inside a browser, and measure time and
memory per sub-proof. The decision it feeds: is proving on the phone (with
no server) viable on the Galaxy S24 within 10 minutes?

## Setup

- Prover: `crates/vault-prover`, triton-vm 8.0.0, built with wasm-pack in
  release mode, no wasm-opt, single-threaded (no wasm threads yet).
- Witness: `fixtures/witness_1in_2out.bin`, a deterministic valid
  `PrimitiveWitness` from the consensus crate's own generator, 1 input, 2
  outputs, 1 lock script, 1 type script. Six sub-proofs. Claims stamped for
  hardfork delta (version 8).
- Harness: `web/prover-bench/`, proving in a Web Worker, wasm memory read
  after every sub-proof (linear memory only grows, so it is a peak).
- Run: `node web/prover-bench/serve.cjs` and open the printed URL.

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

Inside the 10 minute budget with no optimisation at all, and only
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

## Threaded build (lever 2)

Build: wasm-bindgen-rayon, std rebuilt with atomics, SIMD on, no LDE cache
unless stated. Cross-origin isolated page. Current nightlies need explicit
`--shared-memory`, `--import-memory` and the TLS exports as linker args,
see `.cargo/config.toml`.

### Thread pool sanity check, desktop Chrome, pure compute

| Threads | Time (ms) | Speed-up |
|--------:|----------:|---------:|
| 1 | 6226 | 1.0 |
| 2 | 3066 | 2.0 |
| 4 | 1477 | 4.2 |
| 8 | 755 | 8.2 |
| 16 | 513 | 12.1 |

The pool and the machine scale as expected on a parallel loop without
allocation.

### Desktop, Chrome 152, 16 threads, no LDE cache

| # | Sub-proof | Time (s) | Single-threaded (s) | Wasm memory after (MB) |
|---|-----------|---------:|--------------------:|-----------------------:|
| 1 | removal_records_integrity | 224.9 | 277.4 | 1022 |
| 2 | collect_lock_scripts | 13.6 | 15.8 | 1022 |
| 3 | kernel_to_outputs | 27.1 | 36.3 | 1022 |
| 4 | collect_type_scripts | 26.6 | 30.5 | 1022 |
| 5 | lock_script_0 | 2.4 | 4.1 | 1022 |
| 6 | type_script_0 | 52.5 | 64.1 | 1022 |
| | Total | 350.3 | 428.3 | 1022 peak |

Only 1.22x from 16 threads, while the compute-only loop gets 12x. The
bottleneck is inside the prover's workload, not the thread pool.

### Desktop, Chrome 152, 16 threads, LDE cache on

| # | Sub-proof | Time (s) | Single-threaded cached (s) | Wasm memory after (MB) |
|---|-----------|---------:|---------------------------:|-----------------------:|
| 1 | removal_records_integrity | 181.0 | 378.3 | 3474 |
| 2 | collect_lock_scripts | 6.0 | 21.2 | 3474 |
| 3 | kernel_to_outputs | 12.3 | 42.7 | 3474 |
| 4 | collect_type_scripts | 12.1 | 36.1 | 3474 |
| 5 | lock_script_0 | 0.8 | 2.3 | 3474 |
| 6 | type_script_0 | 26.9 | 76.0 | 3474 |
| | Total | 242.2 | 556.9 | 3474 peak |

With the cache on, the same threads give 2.1x on the largest proof and 3.5x
on the small ones. So the parallel structure of the cached path works in
wasm, and it is the no-cache path that does not scale. Unfortunately the
no-cache path is the only one that fits a phone.

Allocation is not the reason: the compute loop with a small Vec allocated
and freed per item still scales 20x at 16 threads (7581 ms to 368 ms), so
the wasm allocator's lock is not the limit at this granularity.

### Native baseline, no LDE cache, 1 thread versus 16

`RAYON_NUM_THREADS=1 cargo test --release -p vault-prover -- --ignored`:

| Sub-proof | 1 thread (s) | 16 threads (s) | Speed-up | wasm 1 thread (s) |
|-----------|-------------:|---------------:|---------:|------------------:|
| removal_records_integrity | 220.9 | 45.9 | 4.8 | 277.4 |
| collect_lock_scripts | 12.8 | 2.7 | 4.7 | 15.8 |
| kernel_to_outputs | 25.0 | 5.0 | 5.0 | 36.3 |
| collect_type_scripts | 24.3 | 4.7 | 5.2 | 30.5 |
| lock_script_0 | 2.3 | 0.4 | 5.8 | 4.1 |
| type_script_0 | 59.4 | 9.4 | 6.3 | 64.1 |
| Total | 345.4 | 68.7 | 5.0 | 428.3 |

Two facts follow. The no-cache path does scale natively, about 5x on 16
cores, so the algorithm is parallel enough. And single-threaded wasm is only
1.24x slower than single-threaded native, so the wasm code itself is fine.
The loss is specific to running the no-cache path with wasm threads. If that
loss is recovered, the phone's 456 s would become roughly 100 s.

Large per-task allocations (64 tasks of 4 MB each) also scale, 7x at 16
threads, so plain allocation volume is not the limit either.

### Phase profile, wasm, no LDE cache, removal_records_integrity

Triton VM's profiler compiled in (debug assertions on for that crate, which
makes both runs slower than the production build; only the ratio matters).

| Phase | 1 thread (s) | 16 threads (s) | Speed-up |
|-------|-------------:|---------------:|---------:|
| main tables | 135.6 | 24.7 | 5.5 |
| aux tables | 93.2 | 13.2 | 7.1 |
| quotient calculation (just-in-time) | 301.9 | 38.1 | 7.9 |
| DEEP | 16.9 | 69.1 | 0.24 |
| whole proof | 590.0 | 154.0 | 3.8 |

Every phase scales except DEEP, which gets four times slower with more
threads and grows from 3 percent of the proof to 45 percent. DEEP is a
parallel map over the FRI domain doing one extension-field division per
point. `XFieldElement::inverse` in twenty-first 1.1.0 is implemented with a
polynomial extended GCD that allocates several vectors per call. With wasm
threads every allocation takes the allocator's single global lock, so a
million inversions on sixteen threads turn into a lock convoy. The earlier
allocation sweeps did not trigger it because they allocated far less often.

Fix: a vendored twenty-first whose inverse uses the field norm,
`a^{-1} = a^p * a^{p^2} / N(a)`, with no allocation. Same values, pinned by
a test against the GCD version on 20,000 random elements.

Confirmation, same profiler build, 16 threads, no cache:

| Sub-proof | Before fix (s) | After fix (s) | 1 thread, same build (s) |
|-----------|---------------:|--------------:|-------------------------:|
| removal_records_integrity | 154.0 | 84.2 | 590.0 |
| collect_lock_scripts | 7.6 | 5.0 | 34.2 |
| kernel_to_outputs | 15.3 | 9.5 | 75.3 |
| collect_type_scripts | 15.6 | 9.4 | 80.7 |
| lock_script_0 | 1.5 | 1.1 | 6.3 |
| type_script_0 | 31.2 | 19.6 | 132.0 |
| Total | 226.3 | 129.2 | 918.9 |

DEEP on the largest proof fell from 69.1 s to 6.6 s. Threads now give 7.1x
over one thread on the same build. Peak memory 1024 MB. The production build
(profiler off) is measured below.

The inverse also helps natively: the round-trip test on 16 cores went from
68.7 s to 43.1 s (removal records integrity 45.9 s to 29.0 s), and the
consensus verifier still accepts the collection.

### Desktop, Chrome 152, production build, 16 threads, no LDE cache

| # | Sub-proof | Time (s) | Single-threaded (s) | Speed-up |
|---|-----------|---------:|--------------------:|---------:|
| 1 | removal_records_integrity | 97.0 | 277.4 | 2.9 |
| 2 | collect_lock_scripts | 4.6 | 15.8 | 3.4 |
| 3 | kernel_to_outputs | 8.6 | 36.3 | 4.2 |
| 4 | collect_type_scripts | 9.0 | 30.5 | 3.4 |
| 5 | lock_script_0 | 1.0 | 4.1 | 4.1 |
| 6 | type_script_0 | 17.1 | 64.1 | 3.7 |
| | Total | 138.0 | 428.3 | 3.1 |

Peak wasm memory 1026 MB. 3.1x from threads in the browser against 8x
natively on the same machine with the same inverse (43 s), so there is
still headroom, but the phone budget question is settled with margin.

Same build with 8 threads: 160.5 s total (removal records integrity
106.7 s), peak 969 MB. Sixteen threads are still worth it on this CPU, with
diminishing returns; memory barely moves with the thread count.

### Galaxy S24, Chrome 152, production build, 10 threads, no LDE cache

Run by the user on 2026-09-13, page cross-origin isolated (http origin
whitelisted in Chrome flags), deviceMemory 8 GB.

| # | Sub-proof | Time (s) | Single-threaded (s) | Speed-up | Wasm memory after (MB) |
|---|-----------|---------:|--------------------:|---------:|-----------------------:|
| 1 | removal_records_integrity | 85.2 | 308.8 | 3.6 | 985 |
| 2 | collect_lock_scripts | 5.6 | 14.6 | 2.6 | 985 |
| 3 | kernel_to_outputs | 10.4 | 34.5 | 3.3 | 985 |
| 4 | collect_type_scripts | 10.2 | 31.4 | 3.1 | 985 |
| 5 | lock_script_0 | 1.1 | 3.0 | 2.7 | 985 |
| 6 | type_script_0 | 20.5 | 62.9 | 3.1 | 985 |
| | Total | 134.4 | 456.0 | 3.4 | 985 peak |

A full ProofCollection in 2 minutes 14 seconds on the phone, under 1 GB,
with the same code the node verifies. That is within a factor of 4.5 of the
native Android app (about 30 s) and well inside the 10 minute budget. The
S24 with 10 threads matches this laptop with 16, so the phone is not the
weak link; the remaining gap to native is in the wasm runtime.

Threads on the phone are now the default for the PWA. Open question for
later: whether the thread count should be capped below the core count on
phones to leave headroom for the UI and to limit heat.

## Where the remaining thread scaling goes

Production-quality phase profiles (profiler compiled into the vendored
triton-vm, no debug assertions), desktop Chrome, no LDE cache,
removal_records_integrity:

| Phase | 1 thread (s) | 16 threads (s) | Speed-up |
|-------|-------------:|---------------:|---------:|
| main tables: create | 10.9 | 2.4 | 4.5 |
| main tables: Merkle leafs, LDE | 17.8 | 6.6 | 2.7 |
| main tables: Merkle leafs, hash rows | 36.6 | 7.2 | 5.1 |
| main tables: extend | 7.2 | 5.4 | 1.3 |
| aux tables: LDE | 12.6 | 4.4 | 2.9 |
| aux tables: hash rows | 25.8 | 5.1 | 5.1 |
| quotient: poly evaluate | 24.1 | 6.6 | 3.7 |
| quotient: trace randomizers | 24.0 | 6.5 | 3.7 |
| quotient: AIR evaluation | 63.4 | 15.4 | 4.1 |
| DEEP | 28.4 | 6.2 | 4.6 |
| whole proof | 286.1 | 76.7 | 3.7 |

Whole collection: 440.1 s on one thread, 121.7 s on sixteen.

No phase is pathological any more; they all scale, but only 3x to 5x. Row
hashing does not allocate at all and still stops at 5.1x, so the allocator
is not the whole explanation. Two effects remain:

- This laptop's CPU is hybrid, and the "16 cores" are hyperthreads plus
  efficiency cores. The float loop used for the thread-pool sanity check
  hides that (12x), an integer-heavy hashing kernel does not. Native on the
  same machine reaches about 7x, so that is the realistic ceiling here.
- Below that ceiling, the LDE phases (2.7x to 2.9x) are the worst, and they
  are the ones allocating multi-megabyte buffers per column.

The "extend" step (1.3x) is small and mostly sequential by construction.

### NTT-per-column micro-benchmark, desktop Chrome

96 NTTs of size 2^18 with twenty-first's `ntt`, either allocating a fresh
buffer per column (as the prover's LDE does) or reusing one preallocated
buffer per worker:

| Threads | Alloc per column (ms) | Preallocated (ms) | Speed-up |
|--------:|----------------------:|------------------:|---------:|
| 1 | 2021 | 2005 | 1.0 |
| 2 | 1089 | 1045 | 1.9 |
| 4 | 552 | 570 | 3.6 |
| 8 | 397 | 374 | 5.2 |
| 16 | 396 | 399 | 5.1 |

Allocation makes no difference, and the NTT kernel itself stops scaling at
8 threads on this machine at about 5x. So the allocator is not worth
replacing, and the LDE phases are bound by the memory system and the core
mix, not by the code. The prover's LDE at 2.7x to 2.9x is below this 5x
because its per-column work is larger (interpolation plus evaluation on a
bigger domain) and streams more data. The same limits apply natively, which
is why native also lands near 7x rather than 16x.

Conclusion: after the inverse fix there is no further large thread-scaling
win in wasm on this hardware. What remains are per-thread code-quality
levers: wasm-opt (measured below), and possibly link-time optimisation.

### wasm-opt -O3, desktop Chrome, 16 threads, no LDE cache

Binaryen with threads, bulk memory, SIMD and mutable globals enabled. The
pass takes 15 minutes on this laptop and shrinks the module from 5.6 MB to
3.3 MB.

| # | Sub-proof | Without wasm-opt (s) | With wasm-opt (s) |
|---|-----------|---------------------:|------------------:|
| 1 | removal_records_integrity | 76.7 | 73.1 |
| 2 | collect_lock_scripts | 5.4 | 3.9 |
| 3 | kernel_to_outputs | 9.9 | 7.4 |
| 4 | collect_type_scripts | 10.1 | 7.4 |
| 5 | lock_script_0 | 1.1 | 0.8 |
| 6 | type_script_0 | 18.1 | 14.9 |
| | Total | 121.7 | 107.9 |

Eleven percent faster and a smaller download, so it stays on for release
builds. Expected on the S24: about 120 s.

### Summary of the prover work

| Configuration | Desktop (s) | S24 (s) |
|---------------|------------:|--------:|
| Single thread, first build | 428 | 456 |
| 16 / 10 threads, first threaded build | 350 | |
| Threads plus allocation-free inverse | 138 | 134 |
| Threads, inverse, wasm-opt | 108 | not measured |
| Native, 16 cores, for reference | 43 | |

## Levers if the phone misses the budget

1. No LDE cache (this build). Memory first, time second.
2. wasm threads via wasm-bindgen-rayon, cross-origin isolated page. Triton VM
   parallelises well; an S24 has eight cores.
3. wasm SIMD for Tip5 hashing.
4. Reduce the number of sub-proofs per send: one input per transaction is
   already the minimum; batching outputs does not change the count.

### Pre-fork prover and a second input (2026-09-14, desktop, 16 threads, no LDE cache)

Measured with the benchmark page against the packages the app ships, while
other builds loaded the machine (times are inflated, memory is not).

| Prover | Witness | removal_records_integrity (s) | Peak wasm memory (MB) |
|--------|---------|------------------------------:|----------------------:|
| legacy (claim version 5, Triton VM 7) | 1 input, 2 outputs | 139 | 1026 |
| current (claim version 8, Triton VM 8) | 2 inputs, 2 outputs | 182 | 1055 |

The pre-fork prover needs the same memory as the current one, and a second
input adds three percent, so neither explains a phone running out of memory
on a one-input send; the memory free on the device at the time does.
