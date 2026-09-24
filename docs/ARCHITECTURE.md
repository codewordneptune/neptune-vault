# Architecture

This document describes how Neptune Vault is built: the pieces and the seam
between them, the wallet engine, storage and sealing, node communication,
sending and proving, the app shell, and the facts about Neptune Cash that
shaped the design. It is for contributors and security reviewers. Features,
setup and the regtest recipe are in [README.md](../README.md); hosting in
[HOSTING.md](HOSTING.md); desktop releases in
[DESKTOP-RELEASE.md](DESKTOP-RELEASE.md); what leaves the device in
[PRIVACY.md](PRIVACY.md).

Last reviewed 2026-09-23 against the code.

## 1. Overview

```
            React 19 + Mantine 9 interface (web/src): screens, AppContext,
            services, sync, mempool watcher, send flow
                                   |
              WalletCore + Prover interfaces (web/src/backend/types.ts)
                                   |
         +-------------------------+--------------------------+
         | browser                                            | desktop (Tauri 2)
         | wallet worker: vault-core as wasm                  | shells/tauri: thin commands
         | prover worker: vault-prover as wasm                | vault-bridge: vault-core and
         |                                                    |   vault-prover, native
         | IndexedDB: app database + sealed logs              | sealed logs as files
         +-------------------------+--------------------------+
                                   |
                HTTPS JSON-RPC 2.0 from the page's own fetch
                                   |
                   neptune-core node chosen by the person
```

There is one interface on every platform. Screens and services call a
`WalletCore` and a `Prover` (`web/src/backend/types.ts`) and never know which
implementation answers. `web/src/backend/index.ts` decides once at start-up:
`isNative()` is true when Tauri has put `__TAURI_INTERNALS__` on the window,
and `createBackend()` then imports either `backend/browser/*` (wasm in
workers) or `backend/native/*` (shell commands). Each side is loaded on
demand, so neither ships in the other's bundle. React state is plain context
(`web/src/app/AppContext.tsx`); long-lived objects are wired in
`web/src/app/services.ts`.

Rust crates (root `Cargo.toml` workspace):

- `crates/vault-core`: the wallet engine (keys, scanning, chain checks, send
  building, sealed store, ledger), as wasm and natively.
- `crates/vault-prover`: ProofCollection proving with Triton VM 8, threaded
  through wasm-bindgen-rayon in the browser.
- `crates/vault-bridge`: the engine and prover for a native shell. Holds the
  unlocked account behind a mutex, opens seed envelopes (`src/envelope.rs`),
  keeps logs as files (`src/wallet_store.rs`); knows nothing about Tauri.
- `crates/vault-fixtures`: writes deterministic `PrimitiveWitness` fixtures
  for the prover benchmark (`web/prover-bench`).
- `crates/vendor`: neptune-consensus 0.17.0, neptune-primitives 0.17.0,
  twenty-first 1.1.0 and triton-vm 8.0.0, patched for wasm32 and applied
  through `[patch.crates-io]` ([crates/vendor/VENDOR.md](../crates/vendor/VENDOR.md)).

The native shell (`shells/tauri/src/lib.rs`) has no logic of its own: each
command decodes its arguments, calls `vault_bridge`, and returns the result.
Bytes travel as base64 (`web/src/backend/native/bridge.ts` says why) and
errors keep a name (`WrongPasswordError`, `WalletLockedError`,
`ProofCancelledError`) so the page rebuilds the class it already catches.
`wallet_ledger` and `prover_prove` run on blocking threads; proof progress
returns over a Tauri `Channel`. Beyond the wallet the shell does little:

- Plugins: single-instance (a second launch focuses the running window),
  dialog (the Save dialog behind `app_save_file`, so the page never names a
  path) and opener (behind `app_open_url`).
- Links: `app_open_url` opens only `https://` URLs whose host is in
  `LINK_HOSTS` (useneptune.org, t.me, talk.neptune.cash, github.com,
  neptune.cash, neptunefundamentals.org for the explorer), kept in step with
  `web/src/app/links.ts`.
- Storage: sealed logs under `<app data dir>/logs`.

It does not talk to the node. The window has only `core:default`
(`shells/tauri/capabilities/default.json`); node requests are the page's own
`fetch`, under the CSP in `shells/tauri/tauri.conf.json`.

## 2. Wallet engine (vault-core)

The wasm surface is in `crates/vault-core/src/lib.rs`. Anything the node also
speaks crosses as JSON text; witnesses, kernels and proofs cross as bytes.

- Free functions: `core_version`, `generate_phrase` (18 words), `derive_key`
  (Argon2id), `parse_amount` / `format_amount` (nau as decimal strings),
  `claim_version(network, height)`, `is_valid_address`, `phrase_problem`,
  `mock_proof_collection`, `assemble_submission`.
- `Account`, built with `Account.from_phrase(words, network)`, holds the seed
  and a cache of derived keys. No method returns the phrase. Methods:
  `address(kind, index)`, `scan_blocks`, `scan_mempool_kernel`,
  `announcement_flags`, `absolute_index_sets`, `plan_inputs`, `build_send`
  (a `SendPlan` with `witness()`, `kernel()` and `summary()`).
- `WalletLog`: one wallet's sealed log (section 3), with `run` and
  `run_with_keys` for ledger operations.

Keys (`src/account.rs`). Derived through neptune-wallet, so phrases, keys and
bech32m addresses match neptune-core. Three kinds: `generation`
(lattice-based, long, the default), `ec_hybrid` (short) and `viewing`.
Symmetric keys decode as addresses upstream but are secrets, so
`parse_recipient` refuses them. Scans try every key of every kind up to the
next unused index plus `KEY_LOOKAHEAD` (5). A new wallet starts at
`{ generation: 1, ec_hybrid: 0, viewing: 0 }`.

Scanning (`src/scan.rs`, `src/chain.rs`). `scan_blocks(blocks_response,
unspent, next_key_indices, expectation)` first holds the answer against the
request: each block is the height asked for and links to the one before, and
the first links to the wallet's last scanned block, or the error starts with
`NOT_LINKED`. On Mainnet it checks proof of work, with a difficulty floor of
1e11 from height 10,000. It cannot check the block proof, the mutator set, or
that this is the heaviest chain. It then decrypts announcements, keeps those
whose addition record the block carries, assigns the AOCL index, and finds
spends by exact absolute-index-set match. Coins are keyed
`<utxo hash>:<aocl index>` (`coin_key`). `scan_mempool_kernel` does the same
for one unmined kernel without advancing key indices.

Sending (`src/send.rs`). A `SendRequest` pays a list of `payments` (at most
`MAX_PAYMENTS`, 10), each a recipient and an amount; a request from before
the list names one recipient and amount instead. `plan_inputs` takes
unspent, unlocked coins largest first (fewer inputs, smaller proof) until
the payments plus the fee are covered. `build_send` refuses a
membership-proof snapshot whose height is not the tip's, verifies each
membership proof against the snapshot's mutator set, makes one output per
payment in the request's order and the change to generation key 0 last (all
announced on chain, so the ordinary scan finds the change), refuses one
address paid twice (sender randomness comes from the height and the
receiver, so two equal payments would be one output twice), adds lustration announcements
when the tip requires them and the request allows it, and returns the
bincode `PrimitiveWitness` and kernel. The txid is the kernel's MAST hash.

Claim versions. Proofs for the rules since the delta fork (Mainnet block
55,000, Testnet 5,400, Regtest from the start) carry Triton VM claim version
8, the only one the app makes. `claim_version` reads it from
`ConsensusRuleSet::infer_from`; a version the app does not know stops a send
before proving.

The ledger (`src/ledger.rs`, `src/ledger/op.rs`). The sync, the mempool
watcher and a send all change coins and history. Each change is one ledger
operation (`LedgerOp` in `web/src/backend/types.ts` mirrors `ledger::op::Op`)
that reads the wallet as it is, returns a batch, and takes effect only once
the batch is written. Operations on one wallet run one at a time
(`web/src/backend/browser/engineHost.ts` queues per log; the bridge holds the
store's mutex). `announcementFlags`, `scanBlocks` and `scanMempoolKernel`
need the unlocked account.

## 3. Storage

IndexedDB `neptune-vault` (`web/src/storage/db.ts`) is at `DB_VERSION` 3:
1 initial, 2 adds `contacts`, 3 re-keys coins to `hash:aocl_index`
(`rekeyCoins`). Stores: `accounts`, `contacts`, `utxos`, `blocks`, `history`,
`syncState`, `settings`. There can be several wallets per device, on three
networks (`main`, `testnet`, `regtest`).

A second database, `neptune-vault-log` (`web/src/storage/logStore.ts`), has
one store `entries` keyed `[log, seq, kind]`. It keeps numbered byte strings
and knows nothing of their contents. Writes use `durability: 'strict'`,
`append` refuses a taken number, and `compact` writes a snapshot and drops
what it covers in one transaction.

### Sealed logs

`crates/vault-core/src/store.rs` keeps a wallet's state in memory and writes
it as an append-only log of batches, with a snapshot every `COMPACT_EVERY`
(256) batches. The order is prepare, write, confirm, so a failed write leaves
memory and storage agreeing. An entry is JSON: `format` (`FORMAT` = 1), `seq`
and `kind` in clear, the body sealed with AES-256-GCM under a key derived by
HKDF-SHA256 from the wallet's content key and id (`LogKey::derive`). Each
seal is bound to `neptune-vault log v1|<log>|<seq>|<kind>`, so entries cannot
be altered, reordered or moved between wallets. A newer format is refused
(`NEWER_FORMAT`). Sealing cannot stop someone who can write the disk from
cutting off the newest entries; the next scan rebuilds what they held.

Moving in (`src/migrate.rs`, `web/src/app/engineParts.ts`,
`web/src/app/accounts.ts`). A wallet's parts move from `neptune-vault` into
its log at its first unlock, the only time its key exists. `ENGINE_PARTS` is
`contacts, scan, sync, utxos, blocks, history`; the chain parts move as one
batch. `prepare_migration` compares the would-be state with the dump record
for record before writing. A part that fails stays in the database
(`EngineParts.stays`); a chain that fails is started afresh (`storeRebuild`)
and rebuilt from the chain. Nothing is deleted from the old database. Account
records (with their envelopes) and settings stay there; the core's device
log (`DEVICE_LOG`) exists but the app does not use it yet.

In the browser the wallet worker owns the logs (`walletWorker.ts`,
`engineHost.ts`). Natively, `FilePersist` in
`crates/vault-bridge/src/wallet_store.rs` keeps a directory per log (name
hex-encoded, as `wallet:<id>` has a colon), a `<seq:020>.batch` file per
batch and a `snapshot`, each written under a temporary name, synced, then
renamed. Account records and settings stay in the web view's IndexedDB.

### Seed envelope

`SeedEnvelope` version 1 (`db.ts`, `web/src/storage/envelope.ts`):

```
password    --Argon2id(salt, mKib, tCost, pCost)--> wrap key
wrap key    --AES-256-GCM--> 32-byte content key   (wrappedContentKey)
content key --AES-256-GCM--> seed phrase, UTF-8    (seed)
```

Argon2id runs in the core (`crates/vault-core/src/kdf.rs`): default 64 MiB,
3 passes, 1 lane, with a floor of 19 MiB and 2 passes. Before the password
touches an envelope, `assertEnvelope` checks the parameters against
`KDF_CEILING` (1 GiB, 16 passes, 4 lanes), the salt length (16 to 64 bytes)
and the exact IV and box lengths. An envelope opened with settings below the
default is wrapped again at the default. A password change re-wraps only the
content key. The AES layering exists twice (TypeScript and
`crates/vault-bridge/src/envelope.rs`), pinned to one result by
`test-vectors/seed-envelope.json`; Argon2id exists once.

At unlock the page hands the envelope and password to the wallet worker or
the shell, which opens the phrase and loads the account there. The seed
phrase reaches the page only when a new one is shown to be written down,
when one is typed in, and when the person asks to see it (password again).

Passkeys (`web/src/app/passkey.ts`). A platform passkey with the WebAuthn PRF
extension yields a 32-byte secret after user verification. It wraps the same
content key, stored on the account record as `passkey`. Device-bound, never
in a backup; the password always works.

### Backup file

`ExportFile` in `envelope.ts`, `format: 'neptune-vault-backup'`. Export
writes version 3:

```
password    --Argon2id--> wrap key --AES-GCM--> file key
file key    --AES-GCM, AAD = readable part--> content key
content key --AES-GCM--> seed (the database's own ciphertext)
content key --AES-GCM, AAD = all of the above--> contacts
```

The readable part (format, version, network, start block, export date, KDF
settings, boxes) is a fixed text (`readablePart`), so one changed byte stops
the restore with `BackupAlteredError`, while a wrong password fails earlier
and is reported as such. Relabelled as version 2, the file does not open: an
older reader takes the file key for the content key. Files are capped at
`MAX_BACKUP_BYTES` (32 MiB).

### Data-format policy

Pinned by `web/src/storage/formats.test.ts` and the fixtures in
`web/src/storage/fixtures` (`backup-v1.json`, `backup-v2.json`,
`backup-v3.json`):

- The database has one version (`DB_VERSION`). A change raises it and adds an
  upgrade step that runs on open, asks nothing and keeps data. A database
  from a newer app is refused with "update the app".
- Every backup version ever written stays readable, and the tests restore a
  fixture of each. Export writes the newest. A newer file is refused with
  "update the app".
- The seed envelope and log entries carry versions; a change is a new
  number, and old numbers still open.

Adding a version: bump the constant, add the upgrade or reader, add a
fixture, never remove an old one.

## 4. Node communication

`web/src/node/rpc.ts` speaks JSON-RPC 2.0 over POST, with methods named
`<namespace>_<camelCaseOp>` and positional parameters. Called:
`node_network`, `chain_tipHeader`, `archival_getBlockHeader`,
`archival_isBlockCanonical`, `wallet_getBlocks`,
`wallet_restoreMembershipProof`, `wallet_submitTransaction`,
`utxoindex_blockHeightsByFlags`, `utxoindex_blockHeightsByAbsoluteIndexSets`,
`mempool_transactions`, `mempool_getTransactionKernel`,
`mempool_getTransactionsByAdditionRecords`.

Answers are capped at `MAX_RESPONSE_BYTES` (96 MiB); the timeout (30 s by
default, longer for blocks, membership proofs and submission) covers the
whole body; redirects are refused; node error text is cleaned and quoted as
the node's (`nodeSaid`). `nodeUrlProblem` accepts `https://`, `http://` only
to localhost, and a bare path only on regtest.

Raw JSON. Node payloads carry u64 and u128 values, and `JSON.parse` rounds
integers above 2^53. Whatever the core reads (blocks, mempool kernels, the
membership-proof snapshot, the tip header) stays as response text
(`callRaw`), and the core parses the envelope. Parameters with 64-bit values
(announcement flags, absolute index sets) are serialised by the core and
spliced into the request as text (`paramsText`).

Sync (`web/src/wallet/sync.ts`). A pass runs every 15 s while unlocked and
visible, and on reconnect; a Web Lock (`neptune-vault-sync:<id>`) allows one
per wallet across windows. A pass:

1. Checks once per node URL that `node_network` matches the wallet.
2. Runs a pending fast restore (below).
3. Gets the position (`startPass`). If the last synced block is no longer
   canonical, `rollBackIfForked` binary-searches the stored blocks (the
   ledger keeps 1000) for the newest canonical one and rolls back to it. If
   none is canonical it stops and changes nothing; the person may rescan.
4. Fetches `wallet_getBlocks` in batches of 25, each scanned against the hash
   it must follow. A `NOT_LINKED` answer rolls back and retries, at most three
   times.

Fast restore. With `restore: 'fast'` a pass asks
`utxoindex_blockHeightsByFlags` for blocks with announcements for the
wallet's keys and `utxoindex_blockHeightsByAbsoluteIndexSets` for blocks that
spent its coins, scans those one by one, and repeats while keys or coins turn
up (at most 40 rounds). It hands over to the ordinary scan `RESTORE_HANDOVER`
(10) blocks below the tip. The node learns the wallet's receiver identifiers
and coins. Import and rescan can also start from a date: `heightForDate`
binary-searches `archival_getBlockHeader` timestamps.

Mempool watcher (`web/src/wallet/mempool.ts`). After each sync and every 30 s
while unlocked and visible, it lists `mempool_transactions`, scans at most 30
unseen kernels per poll, and keeps pending incoming rows keyed by output
commitment (`incoming:<commitment>`). A row is dropped once its commitment has
been absent for two polls; the block scan replaces it on confirmation.
Outputs this seed created are not incoming. A spend of this wallet's coins
that it did not build (another device, same phrase) becomes a pending sent
row (`outgoing:<first input>`) that holds those coins. Own pending sends are
checked with `mempool_getTransactionsByAdditionRecords`. A node without the
`mempool` namespace turns the watcher off.

CORS and CSP. The page calls the node directly, so the node must allow
cross-origin requests; the default Mainnet node
(`https://wallet.neptunefundamentals.org`) does. The web CSP's `connect-src`
is `'self' https: http://localhost:* http://127.0.0.1:*`, matching the URL
rules. In development `/regtest-node` is proxied to `127.0.0.1:9797`
(`web/vite.config.ts`).

## 5. Sending and proving

`SendService.send` in `web/src/app/send.ts`:

1. `plan_inputs` over the ledger's `spendable` coins.
2. `wallet_restoreMembershipProof`, then `chain_tipHeader`, in that order, so
   a tip that moves in between fails the height check in `build_send`.
3. `build_send`. A lustration requirement becomes `RequiresLustrationError`,
   and the Send screen asks.
4. The claim version for tip height + 1, the first block that can carry the
   transaction: 8, or the send stops with "update the app".
5. Prove, or on regtest take `mock_proof_collection`.
6. `assemble_submission`; record the pending row and hold the inputs
   (`recordPending`) before `wallet_submitTransaction`, whether or not
   blocks arrived during the proof: nodes from neptune-core 0.18 admit a
   transaction synced to one of the tip's last three blocks
   (`MAX_TX_SYNC_DEPTH`) and carry it forward, and older ones often take one
   a block behind. A timeout keeps the inputs held (`SendUnconfirmedError`),
   so nobody pays twice on a lost answer. Cancel works up to submission.
7. A refusal releases the inputs (`discardPending`). `NotConfirmable` with
   a tip that has moved means the proof was too far behind or a new block
   touched its coins: build on the new tip and prove again, up to
   `MAX_SEND_ATTEMPTS` (3). With the tip unmoved, a coin is spent, and the
   send stops and says so.

Browser prover (`web/src/backend/browser/proverClient.ts`, `proverWorker.ts`).
A fresh worker per proof, so a failed or cancelled run frees its memory. It
imports `/wasm/prover/vault_prover.js`. The thread pool starts only on a
cross-origin isolated
page, sized to all reported cores. The LDE trace is not cached, trading time
for memory. Sub-proofs run one after another (removal-records integrity,
collect lock scripts, kernel to outputs, collect type scripts, then one per
lock script and per type script), with progress weighted by measured cost
(`web/src/backend/proving.ts`). Errors are cut to their first line, because
a VM dump can hold the spending secrets. A one-input proof on a Galaxy S24
took 134 s with 10 threads, at a 985 MB peak
([M0-BENCHMARK.md](M0-BENCHMARK.md)).

Native prover (`vault_bridge::Prover`). A rayon pool of exactly the requested
size (default: all CPUs) with 32 MiB thread stacks, as the desktop node
wallet needs, and the LDE trace cached. Cancel settles the page's promise at
once; the Rust proof cannot be interrupted, runs to the end, and is
discarded.

The send job runs in `AppContext` (`startSend`), not in the Send screen, so
it survives navigation and `SendStrip` shows it on every screen, the lock
screen included. While it runs the window is marked busy (another window
cannot take the wallet), a screen wake lock is requested
(`web/src/app/wakeLock.ts`), and `setLockDeferred(true)` holds the idle and
background locks until it ends. A manual lock mid-proof still lets the proof
finish and submit; only a rebuild after a new block needs the keys, and then
the send stops and says so.

## 6. App shell

One window owns the wallet (`web/src/app/windowOwner.ts`): it holds the Web
Lock `neptune-vault-window`, and other windows say where the wallet is open
and can ask for it. A window in the middle of a send refuses.

Web updates (`web/src/components/UpdateStrip.tsx`). vite-plugin-pwa with
`registerType: 'prompt'`: a new build downloads and waits, and is never
applied while the app is open. It takes over when the person taps Update,
which the strip does not offer during a send, or when the app next starts.
The strip names the waiting build from `version.json` (version, commit, build
date; emitted by `vite.config.ts`, never precached) and links the commits
between. It checks hourly and when the app comes to the front. A page cannot
refuse its host's next version; the defences are the gated deploy and
published file hashes ([HOSTING.md](HOSTING.md)).

Desktop updates (`web/src/components/DesktopUpdateNotice.tsx`). No service
worker and no signed auto-updater yet. Every six hours the app asks the
GitHub releases API for a published `desktop-v*` release newer than itself
and offers the download page.

Auto-lock (`web/src/app/accounts.ts`). The idle time is one of
`LOCK_CHOICES_MS` (1, 5, 15 or 30 minutes; default 5), measured by the wall
clock so a device that slept does not stay unlocked. The wallet also locks
when the page is hidden (on the desktop, when the window is minimized). In
the browser a lock terminates the wallet worker, and the seed, keys, content
key and open logs go with its memory; natively `wallet_lock` drops the
account and content key. A lock never waits on a busy worker. Rust secrets
are overwritten on drop where the types allow: best effort, not a guarantee.

Security headers (`web/public/staticwebapp.config.json`, also sent by
`vite preview`): COOP `same-origin` and COEP `require-corp` (cross-origin
isolation, for the prover's shared memory); CORP `same-origin`; a CSP with
`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, workers from
`'self' blob:`, `frame-ancestors 'none'`, `form-action 'none'`;
`X-Frame-Options: DENY`; `nosniff`; `Referrer-Policy: no-referrer`; and a
`Permissions-Policy` granting only camera, clipboard write, screen wake lock,
web share and passkeys.

Desktop behaviours (`web/src/app/platform.ts`). Links leaving the app, and
`window.open`, go to the system browser through `app_open_url`. F5, Ctrl+R
and Ctrl+P are blocked; stray file drops are refused; the web view's context
menu shows only in fields and over selected text. `web/src/App.tsx` adds Ctrl
or Cmd with L (lock), N (send) and 1 to 4 (tabs). Backups go through the
native Save dialog. Passkey unlock depends on the web view and is reported as
unavailable when it is not.

## 7. Build and test

- `npm run wasm:core` and `wasm:prover` (in `web/`) run wasm-pack into
  `web/public/wasm/{core,prover}`, served untransformed and imported by
  absolute URL.
- `rust-toolchain.toml` pins `nightly-2026-07-09`. `.cargo/config.toml`
  builds wasm32 with `build-std`, `+atomics,+bulk-memory,+mutable-globals,+simd128`,
  explicit `--shared-memory` and `--import-memory`, and a 4 GiB memory
  maximum. The root `Cargo.toml` builds build scripts at `opt-level = 1`,
  because Triton VM's constraint generator overflows the 1 MB stack of a
  Windows main thread when unoptimized.
- `vite build --mode desktop` (`npm run build:desktop`, Tauri's
  `beforeBuildCommand`) drops the service worker and removes `wasm`, `bench`
  and `staticwebapp.config.json` from the output.
- Tests: vitest with fake-indexeddb. `web/src/backend/engineForTests.ts` runs
  the built wasm core through the worker's own `EngineHost`.
  `web/src/backend/native/surface.test.ts` reads `shells/tauri/src/lib.rs`
  and the native clients and checks command and argument names match.
  `web/src/storage/vector.test.ts` and vault-bridge's tests share the
  envelope vector. Rust: `cargo test -p vault-core` (chain checks against
  real Mainnet blocks included), vault-bridge's store tests, and an ignored
  native prove-and-verify round trip in `crates/vault-prover/tests/roundtrip.rs`.
- CI: `.github/workflows/deploy-web.yml` (Rust tests, wasm builds,
  `npm ci --ignore-scripts`, tests, build, a published SHA-256 list, deploy to
  Azure Static Web Apps) and `.github/workflows/release-desktop.yml`
  (`desktop-v*` tags, draft releases). See [README.md](../README.md),
  [HOSTING.md](HOSTING.md) and [DESKTOP-RELEASE.md](DESKTOP-RELEASE.md).

## 8. Facts that shape the design

- Integers above 2^53. Mainnet blocks carry `u64::MAX` in every removal
  record's chunk dictionary, and UTXO-index identifiers are 64-bit. Passing
  them through JavaScript objects produced values Rust rejected, and smaller
  ones would round silently: hence the raw-JSON rule.
- Block volume. Mainnet `wallet_getBlocks` returned 15 to 19 MB per 100
  blocks when measured; the core scans that in under a second, so on a phone
  the transfer dominates.
- The UTXO index (`--utxo-index`, namespace `utxoindex`) is queried by
  announcement flag, which carries the full 64-bit receiver identifier: the
  node learns exactly which identifiers a wallet asks about. Measured
  2026-09-16 on the public node: 0.15 s per flag lookup, and 3528 candidate
  blocks for a very busy receiver.
- On regtest the consensus verifier accepts only mock proofs, so a real proof
  is rejected there. Real proving is tested natively, in the benchmark, and
  on Mainnet.
- Nodes build blocks only from single-proof transactions, so a ProofCollection
  submission relies on some node upgrading it. A regtest node needs
  single-proof capability and proof upgrading on (README recipe).
- When the tip requires lustration announcements, a send must carry them; the
  app asks first.
- wasm-bindgen-rayon's helper re-fetches its own script into blob workers, so
  the packages are served from the public directory untransformed, and the
  CSP allows `blob:` workers.
- Wasm linear memory never shrinks, so `wasm_memory_bytes` is the peak so
  far, and a fresh prover worker per proof is the only way to return memory.
- Generation addresses are about 3,500 characters and fit a QR code only as
  upper-case alphanumeric at error-correction level L, hence the upper-cased
  `NEPTUNECASH:<ADDRESS>` QR (`web/src/util/address.ts`).
- This seed derives each output's sender randomness from the build height
  and the receiving address, so coins it created are recognised exactly on
  any device: the core tries the confirmation height and the
  `OWN_OUTPUT_WINDOW` (1000) heights below (`own_build_height`). History folds
  change and self-payments by it, and the mempool watcher skips them.
- The node rewrites mempool transactions as blocks arrive, changing their ids
  but not their output commitments. A UTXO is only a lock script and an
  amount, so its hash repeats across equal payments. Hence commitments and
  `hash:aocl_index` as keys.
- AES-GCM does not commit to one key, so every IV and wrapped key is checked
  for its exact length before decryption.
- Without COOP and COEP there is no `SharedArrayBuffer` and no prover thread
  pool, and with them every cross-origin request, the node included, must
  pass CORS.
