# Neptune Vault: Architecture

Status: draft for review, 2026-09-12. Companion to REQUIREMENTS.md; decision
ids (R*) and open items (O*) refer to that document.

## 1. Overview

```
+--------------------------- phone browser ---------------------------+
|                                                                     |
|  React + Mantine UI  <-->  app state (Redux Toolkit)                |
|         |                        |                                  |
|         |                  IndexedDB (encrypted seed, UTXOs,        |
|         |                  membership proofs, settings, history)    |
|         v                                                           |
|  Web Worker: wallet core (wasm)   Web Worker pool: prover (wasm)    |
|   keys, addresses, scanning,       Triton VM, one sub-proof at a    |
|   witness building                 time, rayon threads inside       |
|         |                                                           |
+---------|-----------------------------------------------------------+
          | HTTPS, JSON-RPC 2.0 over POST
          v
   neptune-core node (0.17+), rpc modules: node, chain, wallet, archival
```

Three deliverables live in one repository (R25):

- `crates/vault-core`: Rust library exposing the wallet core to JavaScript via
  wasm-bindgen. Wraps neptune-wallet, neptune-consensus, neptune-mutator-set,
  neptune-primitives at 0.17.
- `crates/vault-prover`: Rust library exposing ProofCollection proving. Wraps
  triton-vm 8.0.0 and the consensus witness types. Separate from vault-core so
  the large prover binary loads only when the user sends.
- `web/`: the PWA. React, Mantine, Vite, TypeScript (R20). Service worker and
  manifest for installation (N1).

## 2. Why Rust to WebAssembly, and what it costs

The desktop wallet already does everything the PWA needs in Rust: address
derivation, announcement decryption, block scanning, membership-proof
maintenance, witness construction, and ProofCollection proving. Reusing the
crates keeps the PWA consensus-compatible without a second implementation
(R3).

The costs:

- The browser has no filesystem or database. The desktop wallet's block cache
  and wallet file become IndexedDB tables; the wasm layer works on values the
  JavaScript side loads and stores.
- The browser is single-threaded unless the page is cross-origin isolated.
  Triton VM uses rayon, so the prover needs wasm threads: nightly Rust with
  `-C target-feature=+atomics,+bulk-memory`, `build-std`, wasm-bindgen-rayon,
  and the COOP/COEP headers described in section 7.
- Memory is capped at 4 GB for 32-bit wasm, and the phone's OS may kill the
  tab earlier. See section 5.
- neptune-consensus enables tokio's `process` and `rt-multi-thread` features
  and neptune-primitives enables tokio's `fs` feature. Those do not build for
  wasm32-unknown-unknown; the compile check in section 9 confirmed it.
  vault-core needs a `[patch.crates-io]` fork of both crates that trims the
  features and gates the process- and filesystem-using modules behind a target
  cfg, or an upstream change. This is the first engineering task and is
  tracked as O6.

## 3. Node interface

The node exposes a single JSON-RPC 2.0 endpoint. Every call is an HTTPS POST
with `{"jsonrpc":"2.0","method":...,"params":...,"id":...}`. The typed
request and response models are the neptune-rpc-api crate, which is plain
serde and builds for wasm. The desktop wallet uses these nine methods and the
PWA needs the same set:

| Method | Used for |
|--------|----------|
| `tip_digest`, `tip_header` | Detect new blocks |
| `get_block_header` | Reorg checks, UTXO origin lookup |
| `is_block_canonical` | Reorg detection for stored blocks |
| `get_blocks` | Download a height range for scanning |
| `are_bloom_indices_set` | Skip blocks that cannot spend the wallet's UTXOs |
| `find_utxo_origin` | Locate the block an addition record landed in |
| `restore_membership_proof` | Fetch mutator-set membership proofs for inputs |
| `submit_transaction` | Broadcast a proven transaction |

Cross-origin finding (O2). A page served from an Azure host cannot call
`https://wallet.neptunefundamentals.org` today: a POST with an `Origin` header
gets a valid JSON-RPC reply but no `Access-Control-Allow-Origin` header, and
the CORS preflight `OPTIONS` request returns 405. The browser will block the
response. Three ways to satisfy R2, in order of preference:

1. Ask the node operator to add CORS headers in the Caddy config in front of
   the node. Zero code, keeps the direct connection. Needs the Azure host name
   (O5) for the allow-list, or a wildcard.
2. Put a reverse proxy on the Azure side that forwards POSTs to the node and
   adds the headers. Keeps the user's node URL setting meaningful only for
   nodes that already send CORS headers.
3. Ship a small gateway of our own. Rejected for now because it contradicts
   the "direct to node" decision and adds infrastructure.

The user-editable node URL (F21) will only work with nodes that send CORS
headers, and the settings screen should say so.

## 4. Wallet core (vault-core)

Exposed to JavaScript as a small API; all types cross the boundary as bytes or
JSON.

- `generate_seed()`, `seed_from_phrase(words)`, `phrase_from_seed(seed)`:
  BIP39 phrase compatible with neptune-core.
- `derive_generation_address(seed, network, index)`: bech32m `nolgam...` on
  mainnet, testnet prefix on testnet. Also returns the spending-key material
  needed later for the lock script, kept inside the worker.
- `scan_block(block, keys, state)`: decrypts announcements for the account's
  generation keys, records new UTXOs, applies removal records to detect spends,
  returns the updated state and any balance change.
- `build_primitive_witness(inputs, membership_proofs, recipient, amount, fee,
  change_key, tip_header, rule_set)`: produces the witness for the prover and
  the transaction kernel for the pending record.

Sync algorithm (R17):

1. Store the account's birthday height at creation. Imported accounts default
   to a user-supplied height, or genesis when unknown.
2. Poll `tip_header` while in the foreground. For a new tip, walk from the
   last synced height in batches of `get_blocks`.
3. Before downloading a batch, ask `are_bloom_indices_set` for the wallet's
   known UTXOs so batches that cannot spend anything are skipped when the
   wallet also has no chance of receiving there. Receiving cannot be
   pre-filtered by the node without leaking keys, so blocks are still fetched
   for announcement scanning. The measurable win is on the removal-record side;
   if measurements on the S24 show block download dominates, this is where a
   later optimisation goes.
4. Every stored block header is checked with `is_block_canonical` when the
   tip changes. On a reorg, roll wallet state back to the fork point and
   rescan.
5. Membership proofs are not maintained locally. They are fetched from the
   node with `restore_membership_proof` when a send is prepared, as the
   desktop wallet does.

## 5. Prover (vault-prover)

Pipeline for one send:

1. vault-core builds the primitive witness in the wallet worker.
2. The UI starts a wake lock (R23) and posts the witness to the prover worker.
3. The prover produces the ProofCollection sub-proofs strictly in sequence:
   removal-records integrity, collect lock scripts, kernel to outputs, collect
   type scripts, one lock-script proof per input, one type-script proof per
   type script. Each finished sub-proof is reported back for the progress UI.
4. The claim version comes from the node's rule set at the tip (R29). If the
   tip is one block away from a rule-set change, the send is refused with a
   message, because the transaction would be dropped at the fork.
5. The assembled transaction goes to `submit_transaction`. The kernel and the
   reserved inputs are stored as a pending history entry (R18).

Memory plan:

- Triton VM's cached low-degree extension is off in the browser. The desktop
  investigation measured about 40 KB per trace row for the cache, so a 2^17
  row table would need 5 GB. The just-in-time path costs time instead, which
  R23 accepts.
- The wasm module is built with a maximum memory of 4 GB. Sub-proofs are
  proven one at a time and their traces dropped before the next starts.
- Input count is the main multiplier. Milestone 1 tests a one-input send; the
  UI shows the input count before proving so the user knows why a send with
  many inputs is slow.
- If allocation fails, the worker reports an out-of-memory error, the UI
  clears the reservation, and the user is told the device could not finish
  (R23). Nothing is retried automatically.

Untested until the compile check and the first device benchmark: whether the
largest sub-proof fits on the S24 at all. Milestone 0 in section 10 exists to
answer this before any UI is built.

## 6. Storage and key protection

IndexedDB database `neptune-vault`, versioned with migrations, all object
stores keyed by `accountId` (R14) and `network` (R4):

| Store | Contents |
|-------|----------|
| `accounts` | account id, network, birthday height, encrypted seed envelope(s), key index counter |
| `utxos` | received UTXOs, addition record, block height, spent flag |
| `blocks` | scanned block headers for reorg detection |
| `history` | incoming and outgoing entries, pending or confirmed, txid |
| `settings` | node URLs per network, lock timeout, last network |

Seed envelope, password path (R10):

- Argon2id runs in wasm (the `argon2` crate) with parameters tuned so unlock
  takes about one second on the S24. Salt, parameters, and version are stored
  next to the ciphertext.
- The derived key wraps a random 256-bit content key. The content key
  encrypts the seed with AES-256-GCM through WebCrypto. Changing the password
  re-wraps the content key without touching the seed ciphertext.
- The decrypted seed lives only inside the wallet worker. The UI thread never
  holds it. Locking terminates the worker (F8).

Seed envelope, passkey path (R9, optional):

- A platform passkey with the PRF extension yields a stable 32-byte secret
  bound to the credential. It wraps the same content key as a second envelope.
- Available on iOS 18+ and recent Android Chrome. The UI offers it only when
  `PublicKeyCredential` reports PRF support. The password envelope is always
  present.

Export file (R8): a JSON file containing the account id, network, birthday
height, and the password envelope. Import asks for the password. The file is
useless without it.

What survives clearing site data: the seed phrase on paper, the export file
in the phone's file storage, and the passkey. IndexedDB does not. The app
therefore refuses to show any balance before the phrase confirmation step is
complete (F3).

## 7. Hosting and headers

Azure (R24) on a useneptune.org sub-domain (O5). The prover's threads need the
page to be cross-origin isolated, which requires two response headers on the
document and on the worker scripts:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Azure Static Web Apps sets these through `globalHeaders` in
`staticwebapp.config.json`. If the host cannot set headers, a service-worker
shim can inject them at the cost of one reload on first load. Cross-origin
isolation also means every cross-origin fetch, including the JSON-RPC calls,
must carry CORS headers from the node, which ties back to O2.

Fonts and all other assets are self-hosted so the isolation policy has
nothing to block.

## 8. Build and repository layout

```
neptune-vault/
  Cargo.toml              workspace
  rust-toolchain.toml     nightly, pinned date, wasm32-unknown-unknown target
  crates/
    vault-core/           wasm-bindgen, wallet API
    vault-prover/         wasm-bindgen + wasm-bindgen-rayon, proving API
  web/
    package.json          React, Mantine, Vite, Redux Toolkit, vite-plugin-pwa
    src/
    public/
    staticwebapp.config.json
  docs/
    REQUIREMENTS.md
    ARCHITECTURE.md
```

wasm-pack builds each crate into `web/src/wasm/`. Both wasm packages are
lazy-loaded; the prover only when the user opens the send screen.

Testing: Rust unit tests run natively for the wallet core; wasm-bindgen-test in
headless Chrome covers the boundary; Playwright with an Android device profile
covers the UI against a mocked node; the milestone acceptance test runs by
hand on the S24.

## 9. Compile check of the 0.17 crates for wasm32

Done on 2026-09-12 with a scratch crate depending on neptune-consensus 0.17.0,
neptune-wallet 0.17.0, and triton-vm 8.0.0, using
`cargo +nightly check --target wasm32-unknown-unknown --keep-going` and the
getrandom `js` / `wasm_js` features enabled.

Passes as published, no changes needed:

- twenty-first, tasm-lib 8.0.0, triton-vm 8.0.0 (the prover itself)
- neptune-mutator-set 0.17.0
- neptune-rpc-api 0.17.0 models

Fails as published:

- mio, pulled in by neptune-consensus's tokio features `process` and
  `rt-multi-thread`, and by neptune-primitives's tokio feature `fs`. Every
  other error in the log is a consequence of that one crate. neptune-consensus
  and neptune-wallet were therefore never reached by the checker.

What the sources show a fork has to do, beyond trimming the tokio feature
lists:

- neptune-consensus `proof_abstractions/tasm/prover_job.rs` spawns an external
  prover process with `tokio::process`. It must be gated out for wasm32; the
  PWA calls Triton VM directly, as the desktop wallet's prover does.
- neptune-primitives `data_directory.rs` uses `tokio::fs`. Gate out for wasm32;
  the PWA has no filesystem.
- `Instant::now()` in neptune-consensus `lib.rs` and `SystemTime::now()` in
  neptune-primitives `timestamp.rs` compile for wasm32 but panic at runtime.
  Replace with the `web-time` crate behind a target cfg. The timestamp one is
  on the transaction path, so it matters.
- Eleven `tokio::task::spawn_blocking` call sites in neptune-consensus (witness
  linking, primitive witness, verifier). They compile with tokio's `rt`
  feature on wasm32 but cannot run there. The PWA uses the synchronous
  functions underneath; the async wrappers can stay unused or be gated.

Conclusion: the prover and mutator-set layers are wasm-ready today. The
consensus and primitives crates need a small fork with feature trims and
target-gated modules before vault-core can build. Whether anything else breaks
behind those modules is unknown until the fork is compiled; that is the first
task of milestone M0. Proposed upstream: a `wasm` feature or target cfgs in
neptune-core so the fork can be retired.

## 10. Milestones

- M0, feasibility spike: vault-prover builds for wasm32 and proves one real
  ProofCollection for a one-input transaction in Chrome on the S24, within the
  10 minute budget. Output is a measured table of time and peak memory per
  sub-proof. If M0 fails, R1 has to be revisited before anything else is
  built.
- M1, end to end on testnet (R28): account, backup, receive, balance, send.
- Later: passkey wrapping, multiple accounts, batch send, NIP-2 payment URIs,
  iOS device testing.

## 11. Risks, ranked

1. Proving memory on the phone (section 5). Mitigated by M0 before UI work.
2. neptune-consensus and neptune-primitives do not build for wasm32 without
   patching, confirmed (section 9). Mitigated by a fork with feature trims and
   target-gated modules; the unknown is what else breaks once those modules
   are gated, which M0 answers first.
3. The default node blocks browser calls (O2). Mitigated by asking the operator
   for CORS headers; fallback is an Azure-side proxy.
4. iOS cannot be tested (R22). Safari has tighter memory limits than Chrome
   and kills background PWAs aggressively. Treat iOS as best effort until a
   device exists.
5. Delta hardfork timing (R29). Building on 0.17 from the start avoids the
   desktop wallet's breakage, but a testnet node must also be on 0.17.
6. The wallet must stay in the foreground while proving. Android may still
   discard the tab under memory pressure; the user is told to keep the app
   open and the wake lock reduces the chance.
