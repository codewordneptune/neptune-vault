# Architecture

This document describes how Neptune Vault is built: the pieces and the seam
between them, the wallet engine, storage and sealing, node communication,
sending and proving, the app shell, and the facts about Neptune Cash that
shaped the design. It is for contributors and security reviewers. Features,
setup and the regtest recipe are in [README.md](../README.md); hosting in
[HOSTING.md](HOSTING.md); desktop releases in
[DESKTOP-RELEASE.md](DESKTOP-RELEASE.md); the Android app in
[ANDROID.md](ANDROID.md); what leaves the device in
[PRIVACY.md](PRIVACY.md).

The web code calls a wallet an account (`AccountRecord`, `accountId`); the
core calls it a wallet (`wallet_id`, `wallet:<id>`). They are the same
thing.

Last reviewed 2026-10-03 against the code.

## 1. Overview

```
            React 19 + Mantine 9 interface (web/src): screens, AppContext,
            services, sync, mempool watcher, send flow
                                   |
              WalletCore + Prover interfaces (web/src/backend/types.ts)
                                   |
         +-------------------------+--------------------------+
         | browser                                            | desktop and Android (Tauri 2)
         | wallet worker: vault-core as wasm                  | shells/tauri: thin commands
         | prover worker: vault-prover as wasm                | vault-bridge: vault-core and
         |                                                    |   vault-prover, native
         | IndexedDB: app database + sealed logs              | IndexedDB (web view): app database
         |                                                    | sealed logs as files
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
- `crates/vault-prover`: ProofCollection proving with Triton VM 9, threaded
  through wasm-bindgen-rayon in the browser. Every proof is checked the way a
  node checks it before it leaves the prover.
- `crates/vault-bridge`: the engine and prover for a native shell. Holds the
  unlocked account behind a mutex, opens seed envelopes (`src/envelope.rs`),
  keeps logs as files (`src/wallet_store.rs`); knows nothing about Tauri.
- `crates/vault-fixtures`: writes deterministic `PrimitiveWitness` fixtures
  for the prover benchmark (`web/prover-bench`).
- `crates/vendor`: neptune-consensus 0.19.0, neptune-primitives 0.19.0,
  twenty-first 3.0.0 and triton-vm 9.0.0, with small changes, applied
  through `[patch.crates-io]` ([crates/vendor/VENDOR.md](../crates/vendor/VENDOR.md)).

The native shell (`shells/tauri/src/lib.rs`) has no logic of its own: each
command decodes its arguments, calls `vault_bridge`, and returns the result.
Bytes travel as base64 (`web/src/backend/native/bridge.ts` says why).
Errors keep a name, and the page rebuilds `WrongPasswordError` and
`WalletLockedError` from it; a cancelled proof is settled by the page itself
(`native/proverClient.ts`). `wallet_ledger` and `prover_prove` run on
blocking threads, and proof progress returns over a Tauri `Channel`. The
shell does not talk to the node. Its plugins, links and permissions are in
section 6.

## 2. Wallet engine (vault-core)

The wasm surface is in `crates/vault-core/src/lib.rs`. Anything the node also
speaks crosses as JSON text; witnesses, kernels and proofs cross as bytes.

- Free functions: `core_version`, `generate_phrase` (18 words), `derive_key`
  (Argon2id), `parse_amount` / `format_amount` (nau as decimal strings),
  `claim_version(network, height)`, `is_valid_address`, `phrase_problem`,
  `mock_proof_collection`, `assemble_submission`.
- `Account`, made with `new Account(words, network)` (`from_phrase` in
  Rust), holds the seed and a cache of derived keys. No method returns the
  phrase. Methods: `address(kind, index)`, `scan_blocks`,
  `scan_mempool_kernel`, `announcement_flags`, `absolute_index_sets`,
  `plan_inputs`, `build_send` (a `SendPlan` with `witness()`, `kernel()` and
  `summary()`).
- `WalletLog`: one wallet's sealed log (section 3), opened with
  `new WalletLog(id, contentKey, entries)` or, for a damaged log,
  `WalletLog.set_aside`. Each change is prepared (`prepare`,
  `prepare_migration`, `prepare_rebuild`, or `run` and `run_with_keys` for
  ledger operations), written by the host, then confirmed (`confirm`, or
  `abandon` when the write failed).

Keys (`src/account.rs`). Derived through neptune-wallet, so phrases, keys and
bech32m addresses match neptune-core. Three kinds, shown in the app as
Standard, Short and View-only: `generation` (lattice-based, long, the
default), `ec_hybrid` (short) and `viewing`. Symmetric keys decode as
addresses upstream but are secrets, so `parse_recipient` refuses them. Scans
try every key of every kind up to the next unused index plus
`KEY_LOOKAHEAD` (5). A new wallet starts at
`{ generation: 1, ec_hybrid: 0, viewing: 0 }`.

Scanning (`src/scan.rs`, `src/chain.rs`). `scan_blocks(blocks_response,
unspent, next_key_indices, expectation)` first holds the answer against the
request: each block must be the height asked for and follow the one before
it. When the first does not follow the wallet's last scanned block, the
error starts with `NOT_LINKED`, which the sync treats as a reorganisation.
On Mainnet it checks proof of work, with a difficulty floor of 1e11 from
height 10,000. It cannot check the block proof, the mutator set, or that
this is the heaviest chain. It then decrypts announcements, keeps those
whose addition record the block carries, assigns the AOCL index, and finds
spends by exact absolute-index-set match. Coins are keyed
`<utxo hash>:<aocl index>` (`coin_key`). `scan_mempool_kernel` does the same
for one unmined kernel without advancing key indices.

The app reaches these through the ledger (the `scanBlocks`,
`scanMempoolKernel`, `announcementFlags` and `absoluteIndexSets`
operations, below), which take the coins, key counters and pending sends'
commitments from the sealed log. The `Account` methods of the same names are
the stateless forms, kept on the `WalletCore` interface.

Sending (`src/send.rs`). A `SendRequest` pays a list of `payments` (at most
`MAX_PAYMENTS`, 10), each a recipient and an amount; a request from before
the list names one recipient and amount instead. `plan_inputs` takes coins
whose time lock has passed, largest first (fewer inputs, so less proving
and a lower memory peak), until the payments plus the fee are covered.
`build_send`:

- refuses a membership-proof snapshot whose height is not the tip's;
- verifies each membership proof against the snapshot's mutator set;
- makes one output per payment, in the request's order, and the change to
  generation key 0 last, all announced on chain so the ordinary scan finds
  the change;
- refuses an address paid twice (sender randomness comes from the height
  and the receiver, so two equal payments would be one output twice);
- adds lustration announcements when the tip requires them and the request
  allows it;
- returns the bincode `PrimitiveWitness` and kernel. The txid is the
  kernel's MAST hash.

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

Operations are reads, scans, sync steps (`startPass`, `rollBack`,
`persistScan`, `finishFastRestore`, `resetForRescan`), sends and mempool
rows. A send's coins stay held from `recordPending` until a block confirms
it, the node refuses it (`discardPending`), the person gives up on it
(`forgetSend`), or it expires: `expireSends` frees them once the newest
block is more than three days and an hour past the send's stamp
(`SEND_LIFETIME_MS`). A send given up on that goes through anyway becomes
that send again, and a rescan keeps this device's unsettled sends. Contacts
and private notes are written as `WalletChange` batches (`storeCommit`), not
as ledger operations.

## 3. Storage

There are two databases, each with its own version.

IndexedDB `neptune-vault` (`web/src/storage/db.ts`) is at `DB_VERSION` 3:
1 initial, 2 adds `contacts`, 3 re-keys coins to `hash:aocl_index`
(`rekeyCoins`). Its live stores are `accounts` and `settings`. Five more,
`contacts`, `utxos`, `blocks`, `history` and `syncState`, are where
versions before the sealed log kept a wallet's data; they are read to move
a wallet into its log, and the same unlock deletes that wallet's rows once
the log holds them (below). Never sealed: the account record (name,
network, creation time, start block and key counters, the envelope, the
passkey's and the seed phrase's wrappings, `confirmSends`, backup dates)
and the settings (node URLs, the current wallet, the last proof's figures).
There can be several wallets per device, on three networks (`main`,
`testnet`, `regtest`).

A second database, `neptune-vault-log` (`web/src/storage/logStore.ts`, at
`LOG_DB_VERSION` 1), has one store `entries` keyed `[log, seq, kind]`. It
keeps numbered byte strings and knows nothing of their contents. Writes use
`durability: 'strict'`, `append` refuses a taken number, and `compact`
writes a snapshot and drops what it covers in one transaction.

### Sealed logs

`crates/vault-core/src/store.rs` keeps a wallet's state in memory and writes
it as an append-only log of batches, with a snapshot every `COMPACT_EVERY`
(256) batches. The order is prepare, write, confirm, so a failed write leaves
memory and storage agreeing. An entry is JSON: `format` (`FORMAT` = 1), `seq`
and `kind` in clear, the body sealed with AES-256-GCM under a key derived by
HKDF-SHA256 from the wallet's content key and id (`LogKey::derive`). Each
seal is bound to `neptune-vault log v1|<log>|<seq>|<kind>`, so entries cannot
be altered, reordered or moved between wallets. A newer format is refused
(`NEWER_FORMAT`).

Sealing cannot stop someone who can write the disk from cutting off the
newest entries, or putting back an older copy of the log. The next scan
rebuilds what came from the chain; contacts, address names, notes and the
record of a pending send in the lost entries are gone.

Moving in (`src/migrate.rs`, `web/src/app/engineParts.ts`,
`web/src/app/accounts.ts`). At each unlock, the only time a wallet's key
exists, any part the app reads from the log that is not there yet moves in
from `neptune-vault`. `ENGINE_PARTS` (`web/src/backend/types.ts`) is
`contacts, scan, sync, utxos, blocks, history, private`; the chain parts
move as one batch, and a new wallet's parts move, empty, when it is made.
`private` holds named notes that must not be readable while the wallet is
locked: the last failed send, the last send, a send in progress, address
names, the addresses given out, and a fast restore's progress.
`prepare_migration` compares the would-be state with the dump record for
record before writing. A part that fails stays in the database
(`EngineParts.stays`); a chain that fails is started afresh (`storeRebuild`)
and rebuilt from the chain. The core's device log (`DEVICE_LOG`) exists but
the app does not use it yet.

Once the log holds a part, the same unlock deletes the database's rows of
it (`dropOldCopies` in `accounts.ts`), so nothing of the wallet stays
readable outside its log: the contacts with the contacts part, and the
coins, blocks, history and sync state with the chain, a chain rebuilt from
the chain included, whose notes and recipients on old sends then go with
them. A part that stays is the live copy and is kept. The failed-send note
an older version kept in clear in the settings goes once the log holds it,
and the account record's `address0`, which nothing reads, at the next
unlock. A failed cleanup never fails the unlock; the next one tries again.

Once the chain has moved, the account record's scan fields
(`birthdayHeight`, `nextKeyIndices`, `restore`, `restoredAt`) are a stale
copy: the engine's `scan` part is the truth, and `AppContext` lays it over
the record. Read the engine's.

A log that will not open. The wallet still unlocks, since its keys do not
depend on the log, and Home offers "Rebuild from the chain"
(`setAsideStore`). Every entry is copied unchanged to a log named
`aside:<id>:<time>` (`copy` in both stores), and a fresh log, numbered past
every old entry, starts from what still opens (`Log::salvage`): the
wallet's details, contacts, private notes and this device's unsettled
sends. The chain is marked `rebuild` for the sync. A log written by a newer
version is not damage: it is never set aside, and the app asks for an
update. Removing the wallet removes its aside logs too.

In the browser the wallet worker owns the logs (`walletWorker.ts`,
`engineHost.ts`). Natively, `FilePersist` in
`crates/vault-bridge/src/wallet_store.rs` keeps a directory per log (name
hex-encoded, as `wallet:<id>` has a colon), a file per batch named by its
number, zero-padded to 20 digits (`00000000000000000001.batch`), and one
`snapshot`, each written under a temporary name, synced, then renamed.
Account records and settings stay in the web view's IndexedDB.

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
`KDF_CEILING` (1 GiB, 16 passes, 4 lanes), the salt length (16 to 64 bytes),
the IVs and the wrapped key at their exact lengths (12 and 48 bytes), and
the seed's length within bounds; the core's Argon2 enforces the floor and
the ceiling again. An envelope opened with settings below the default is
wrapped again at the default. A password change re-wraps only the content
key. The AES layering exists twice (TypeScript and
`crates/vault-bridge/src/envelope.rs`), pinned to one result by
`test-vectors/seed-envelope.json`; Argon2id exists once.

Where secrets go:

- Unlocking, password checks and showing the seed phrase open the envelope
  in the wallet worker or the shell, which loads the account there.
- The content key does reach the page. Envelopes are sealed and re-wrapped
  in TypeScript on the page, on every platform, so the content key is there
  while a wallet is made, a passkey is set up or confirms a send, the
  password is changed or strengthened or set with the seed phrase, and a
  backup file is written or restored. For these the core's `derive_key`
  returns the wrap key to the page.
- The seed phrase reaches the page when a new one is shown to be written
  down, when one is typed in, and when the person asks to see it (password
  again).
- While a new wallet is being made, its generated seed phrase is kept in
  clear in the tab's sessionStorage (`neptune-vault.onboarding-draft`), so
  a reload or an app switch does not lose it. It goes when the wallet is
  made, setup is left or the tab closes. An imported seed phrase is never
  stored (`web/src/screens/Onboarding.tsx`).

Passkeys (`web/src/app/passkey.ts`). A platform passkey with the WebAuthn PRF
extension yields a 32-byte secret after user verification. It wraps the same
content key, stored on the account record as `passkey`. The wrapping lives
only in this device's account record and never in a backup, so the passkey
opens the wallet only here, even if the platform syncs the passkey. Setting
one up takes the password, and it can also confirm sends. The password
always works.

The seed phrase (`seedUnlock` on the account record). The content key is
wrapped a third time, under HKDF-SHA256 of the phrase (lower case, one
space apart) with a random 16-byte salt and the info
`neptune-vault seed unlock key v1`. A phrase carries 192 bits, so no
password hash is needed. The wrapping is made where the phrase and the
content key are both at hand: on the page when a wallet is made, and in the
wallet worker or the shell when a wallet is restored from a file or
unlocked without one (`unlockEnvelope`'s `seedUnlock` flag). Forgot the
password? on the lock screen takes the phrase: it must open the wrapping,
and the content key must then open a seed equal to it. The content key is
then wrapped under a new password, and the wallet unlocks through the
wrapping as through a passkey's. Never in a backup. HKDF exists twice
(WebCrypto, and `seed_unlock_key` in `kdf.rs` for the shell), pinned by
the same test vector.

### Backup file

`ExportFile` in `envelope.ts`, `format: 'neptune-vault-backup'`. Export
writes version 3:

```
password    --Argon2id--> wrap key --AES-GCM--> file key
file key    --AES-GCM, AAD = readable part--> content key
content key --AES-GCM--> seed (the database's own ciphertext)
content key --AES-GCM, AAD = all of the above--> contacts, address names,
                                                  addresses given out, sends
```

The readable part (format, version, network, start block, export date, KDF
settings, boxes) is a fixed text (`readablePart`), so any changed byte stops
the restore. A change to what the password check reads (the KDF settings,
the salt, the wrapped file key) fails that check and reads as a wrong
password; any other change shows `BackupAlteredError`. The check is left
unbound on purpose, so a wrong password and a changed file are told apart.
Relabelled as version 2, the file does not open: an older reader takes the
file key for the content key. Files are capped at `MAX_BACKUP_BYTES`
(32 MiB).

Versions 1 (seed only) and 2 (contacts in clear) bound nothing and are
still read. In version 3 the file's `envelope` is its own shape (its own
`version: 2`, with `wrappedFileKey`, `boundContentKey` and `seed`), not a
`SeedEnvelope`; a restore turns it back into an ordinary version 1 envelope
under the same password.

### Data-format policy

Pinned by `web/src/storage/formats.test.ts` and the fixtures in
`web/src/storage/fixtures` (`backup-v1.json`, `backup-v2.json`,
`backup-v3.json`):

- Each database has one version: `neptune-vault` (`DB_VERSION`, 3) and
  `neptune-vault-log` (`LOG_DB_VERSION`, 1). A change raises it and adds an
  upgrade step that runs on open and keeps data (another open window is
  asked to close). A newer app database is refused with "update the app";
  the log database has no such message yet.
- Every backup version ever written stays readable, and the tests restore a
  fixture of each. Export writes the newest. A newer file is refused with
  "update the app".
- The seed envelope and log entries carry versions; a change is a new
  number, and old numbers still open.
- A log entry's seal names its format (`neptune-vault log v1|...`), and the
  reader binds with this build's `FORMAT`. A reader for an older format must
  bind with that format's number, or every older entry will look tampered
  with. No stored entry pins format 1 yet: add one, sealed under a fixed
  test key, before the first change.

Adding a version: bump the constant, add the upgrade or reader, add a
fixture, never remove an old one.

## 4. Node communication

`web/src/node/rpc.ts` speaks JSON-RPC 2.0 over POST, with methods named
`<namespace>_<camelCaseOp>` and positional parameters. The methods the app
calls:

| Who asks | Methods | When |
|---|---|---|
| Sync | `node_network`, `chain_tipHeader`, `archival_isBlockCanonical`, `wallet_getBlocks` | every pass |
| Fast restore, rebuild | `utxoindex_blockHeightsByFlags`, `utxoindex_blockHeightsByAbsoluteIndexSets` | while restoring |
| Dates | `archival_getBlockHeader` | restore or rescan from a month, a wallet made offline, Home's first block |
| Mempool watcher | `mempool_transactions`, `mempool_getTransactionKernel`, `mempool_getTransactionsByAdditionRecords` | after each sync and every 30 s |
| A send | `chain_tipHeader`, `wallet_restoreMembershipProof`, `wallet_submitTransaction` | each attempt |

Answers are capped at `MAX_RESPONSE_BYTES` (96 MiB); the timeout (30 s by
default, twice that for membership proofs and four times for blocks and
submission) covers the whole body; redirects are refused; node error text
is cleaned and quoted as the node's (`nodeSaid`). `nodeUrlProblem` accepts
`https://`, `http://` only to this machine, and a bare path only on
regtest.

Raw JSON. Node payloads carry u64 and u128 values, and `JSON.parse` rounds
integers above 2^53. Whatever the core reads (blocks, mempool kernels, the
membership-proof snapshot, the tip header) stays as response text
(`callRaw`), and the core parses the envelope. The utxoindex parameters
(announcement flags, absolute index sets) are serialised by the core and
spliced into the request as text (`paramsText`). The membership-proof
request still passes its index sets through JavaScript, which holds while
their values stay below 2^53 (about 1.3e8 at block 54,000).

Sync (`web/src/wallet/sync.ts`; the timers are in
`web/src/app/AppContext.tsx`). A pass runs at unlock, every 15 s while
unlocked and visible, and on reconnect; a Web Lock
(`neptune-vault-sync:<id>`) allows one per wallet across windows. A pass:

1. Asks `node_network`, and stops if the node runs another network; a node
   too old to answer is let through.
2. Reads `chain_tipHeader`, and runs a pending fast restore (below).
3. Gets the position (`startPass`). If the last synced block is no longer
   canonical, `rollBackIfForked` binary-searches the stored blocks (the
   ledger keeps 1000) for the newest canonical one and rolls back to it. If
   none is canonical it stops and changes nothing; the person may rescan.
4. Fetches `wallet_getBlocks` in batches of 25, each scanned against the
   hash it must follow. A batch that times out is halved, and grows back
   after four that arrive; at one block the pass stops, and timed passes
   then wait one to five minutes. A `NOT_LINKED` answer rolls back and
   retries, at most three times.
5. Releases the coins of sends no block can take any more (`expireSends`).

Fast restore. With `restore: 'fast'` a pass asks
`utxoindex_blockHeightsByFlags` for blocks with announcements for the
wallet's keys and `utxoindex_blockHeightsByAbsoluteIndexSets` for blocks that
spent its coins, scans those one by one, and repeats while keys or coins turn
up (at most 40 rounds). It hands over to the ordinary scan `RESTORE_HANDOVER`
(10) blocks below the tip. The node learns the wallet's receiver identifiers
and coins. Its progress is kept in the sealed log, so an interrupted restore
carries on. A chain being rebuilt (`restore: 'rebuild'`) uses it too when
the node has the index, and otherwise scans from the start height. Import
and rescan can also start from a date: `heightForDate` binary-searches
`archival_getBlockHeader` timestamps.

Mempool watcher (`web/src/wallet/mempool.ts`). After each sync and every 30 s
while unlocked and visible, it lists `mempool_transactions`, scans at most 30
unseen kernels per poll, and keeps pending incoming rows keyed by output
commitment (`incoming:<commitment>`). A row is dropped once its commitment has
been absent for two polls; the block scan replaces it on confirmation.
Outputs this seed created are not incoming. A spend of this wallet's coins
that it did not build (another device, same phrase) becomes a pending sent
row (`outgoing:<first input>`) that holds those coins. Own pending sends are
checked with `mempool_getTransactionsByAdditionRecords`. A node without the
`mempool` namespace turns the watcher off. Receive also looks for incoming
payments every 10 s while it is open.

Besides the node, the page asks only the web host (its files,
`version.json`), GitHub's releases API (the desktop app), and, if the price
line is on, CoinGecko, then CoinPaprika. [PRIVACY.md](PRIVACY.md) lists what
each learns.

CORS and CSP. The page calls the node directly, so the node must allow
cross-origin requests, in the desktop and Android apps too, whose pages
have an origin of their own. The default Mainnet node
(`https://wallet.neptunefundamentals.org`) does; Testnet has no default
node, and Regtest's is `/regtest-node`. The web CSP's `connect-src` is
`'self' https: http://localhost:* http://127.0.0.1:*`, matching the URL
rules except `http://[::1]`, which the URL check accepts and no CSP can
list. In development `/regtest-node` is proxied to `127.0.0.1:9797`
(`web/vite.config.ts`).

## 5. Sending and proving

`SendService.send` in `web/src/app/send.ts`. The Send screen has already
asked for the wallet's password or passkey on the review, unless that is
turned off for the wallet (`confirmSends`).

1. `chain_tipHeader`, for the time. The transaction is stamped with the
   device's clock but never later than the newest block, and a clock more
   than nine hours behind stops the send here (`sendStamp`).
2. `plan_inputs` over the ledger's `spendable` coins.
3. `wallet_restoreMembershipProof`, then `chain_tipHeader`, in that order.
   If a block arrived in between, `build_send` refuses (`TIP_MOVED`) and the
   flow asks both again, which counts as an attempt.
4. `build_send`. A lustration requirement becomes `RequiresLustrationError`,
   and the Send screen asks.
5. The claim version for tip height + 1, the first block that can carry the
   transaction: 8, or the send stops with "update the app".
6. Prove, or on regtest take `mock_proof_collection`.
7. `assemble_submission`. The pending row is written and the inputs held
   (`recordPending`) before `wallet_submitTransaction`, whether or not
   blocks arrived during the proof. Nodes from neptune-core 0.18 admit a
   transaction built up to three blocks behind the tip and carry it forward
   (`MAX_TX_SYNC_DEPTH` in neptune-core's mempool); older nodes often take
   one a block behind. Cancel works up to this point.
8. Without the node's own answer (none, an HTTP error, or one that cannot
   be read), the inputs stay held (`SendUnconfirmedError`), so nobody pays
   twice on a lost answer. A refusal releases them (`discardPending`);
   FutureDated and TooOld are said in words. `NotConfirmable` with a tip
   that has moved means the proof was too far behind or a new block touched
   its coins: build on the new tip and prove again, up to
   `MAX_SEND_ATTEMPTS` (3). With the tip unmoved, a coin is spent, and the
   send stops and says so.

A pending send keeps its coins until a block confirms it. After ten hours,
when nodes drop a waiting transaction, Home offers Give up
(`MEMPOOL_KEEPS_MS`). After three days and an hour of the chain's time, when
no block may take it, the sync releases its coins and marks it expired
(`SEND_LIFETIME_MS`). Notes in the sealed log let the next unlock say how a
send ended if the app was closed during it.

Browser prover (`web/src/backend/browser/proverClient.ts`, `proverWorker.ts`).
A fresh worker per proof, so a failed or cancelled run frees its memory. It
imports `/wasm/prover/vault_prover.js`. The page is always cross-origin
isolated (the app does not start otherwise), and the thread pool is sized
to all reported cores. The LDE trace is not cached, trading time for
memory. Sub-proofs run one after another (removal-records integrity,
collect lock scripts, kernel to outputs, collect type scripts, then one per
lock script and per type script), with progress weighted by measured cost
(`web/src/backend/proving.ts`). Errors are cut to their first line, because
a VM dump can hold the spending secrets. With Triton VM 9, the benchmark's
one-input proof took 97 s in Chrome on a Galaxy S24, at an 849 MB peak
(2026-10-01, [M0-BENCHMARK.md](M0-BENCHMARK.md)).

Native prover (`vault_bridge::Prover`). A rayon pool of exactly the requested
size (default: all CPUs) with 32 MiB thread stacks, the `RUST_MIN_STACK`
neptune-core's desktop wallet uses for the same proofs. The desktop apps keep
the LDE trace in memory (faster, several GB at the peak); the Android app
computes it again, as the browser does, and proves a Mainnet send in 16 to
23 s. Progress reports the app's peak memory, sampled every 20 ms. Cancel
settles the page's promise at once; the Rust proof cannot be interrupted,
runs to the end, and is discarded.

The send job runs in `AppContext` (`startSend`), not in the Send screen, so
it survives navigation and `SendStrip` shows it on every screen, the lock
screen included. While it runs the window is marked busy (another window
cannot take the wallet), and `setLockDeferred(true)` holds the idle and
background locks until it ends. Nothing locks the wallet during a send:
Lock wallet (header menu and Settings) is disabled, and Ctrl or Cmd+L waits
until the send ends. A lock would end the send anyway, because recording
the pending send needs the wallet's sealed log, which a lock closes; if one
lands, nothing is sent and the send says so. A screen wake lock is
requested (`web/src/app/wakeLock.ts`), and asked for again each time the
page returns; the same happens during a long scan or a fast restore. The
Android app has no native wake lock yet.

## 6. App shell

Screens (`web/src/App.tsx`): Home `/`, `/send`, `/receive`, `/settings`
with a page per row (`/settings/:section`), `/onboarding` (`?add=1` adds a
wallet), `/diagnostics` and `/privacy`. While a wallet is locked, every
screen but `/privacy` shows the lock screen. Dialogs are `Sheet`
(`web/src/components/Sheet.tsx`), never Mantine's `Modal` directly: a sheet
adds a history entry, so Back (Android's or the browser's) closes it rather
than the screen under it (`web/src/app/backCloses.ts`). Closing the tab or
the desktop window during a send asks first (`CloseGuard`).

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
refuse its host's next version; the defences are that only a push to `main`
deploys, and the published file hashes ([HOSTING.md](HOSTING.md)).

Desktop updates (`web/src/components/DesktopUpdateNotice.tsx`). No service
worker and no signed auto-updater yet. When it starts and every six hours,
the app asks the GitHub releases API for a published `desktop-v*` release
newer than itself and offers the download page. The Android app makes no
update check: a phone app is updated by installing its next build.

Auto-lock (`web/src/app/accounts.ts`). The idle time is one of
`LOCK_CHOICES_MS` (1, 5, 15 or 30 minutes; default 5), measured by the wall
clock so a device that slept does not stay unlocked; thirty seconds before
it, a sheet warns and offers Stay unlocked (`IDLE_WARNING_MS`). The wallet
also locks when the page is hidden (on the desktop, when the window is
minimized): at once by default, or after 30 seconds or 2 minutes
(`BACKGROUND_LOCK_CHOICES_MS`). A file picker or camera prompt the app
opened holds that lock for up to two minutes. The screen locks at once: in
the browser a lock terminates the wallet worker, and the seed, keys, content
key and open logs go with its memory; natively `wallet_lock` drops the
account and content key once the ledger operation in progress lets go.
Rust secrets are overwritten on drop where the types allow: best effort,
not a guarantee.

Security headers (`web/public/staticwebapp.config.json`, also sent by
`vite preview`): COOP `same-origin` and COEP `require-corp` (cross-origin
isolation, without which neither wasm package can load); CORP
`same-origin`; a CSP with `default-src 'none'`,
`script-src 'self' 'wasm-unsafe-eval'`, workers from `'self' blob:`,
`frame-ancestors 'none'`, `form-action 'none'`; `X-Frame-Options: DENY`;
`nosniff`; `Referrer-Policy: no-referrer`; and a `Permissions-Policy`
granting only camera, clipboard write, screen wake lock, web share and
passkeys.

Native shell (`shells/tauri/src/lib.rs`). Beyond the wallet it does little:

- Plugins: single-instance on the desktop (a second launch focuses the
  running window), deep-link on phones (a `neptunecash:` link opens the
  app), dialog (the Save dialog behind `app_save_file`, so the page never
  names a path) and opener (behind `app_open_url`).
- Links: `app_open_url` opens only `https://` URLs whose host is in
  `LINK_HOSTS` (useneptune.org, t.me, talk.neptune.cash, github.com,
  neptune.cash, neptunefundamentals.org for the explorer), kept in step with
  `web/src/app/links.ts`.
- Storage: sealed logs under `<app data dir>/logs`.
- Permissions: the window may use `core:default`, set its page zoom, and
  close itself once a close during a send is confirmed
  (`shells/tauri/capabilities/default.json`); on a phone it may also read
  the payment link that opened the app (`capabilities/mobile.json`). Node
  requests are the page's own `fetch`, under the CSP in
  `shells/tauri/tauri.conf.json`.

Native app behaviours (`web/src/app/platform.ts`, desktop and Android).
Links leaving the app, and `window.open`, go to the system browser through
`app_open_url`. F5, Ctrl+R and Ctrl+P are blocked; stray file drops are
refused; the web view's context menu shows only in fields and over selected
text. On the desktop, `web/src/App.tsx` adds Ctrl or Cmd with L (lock, after
a running send), N (send) and 1 to 4 (tabs), and backups go through the
native Save dialog (not yet on Android). Passkey unlock depends on the web
view and is reported as unavailable when it is not.

Android app. The same shell, built with `tauri android` (`lib.rs` has the
mobile entry point). What differs is gated by `NATIVE`, `MOBILE`, `DESKTOP`
and `ANDROID` in `web/src/app/platform.ts`. Payment links (`neptunecash:`)
open the app through Tauri's deep-link plugin, phones only, and fill in
Send (`web/src/app/paymentLinks.ts`). There is no update notice, no close
guard and no passkey unlock. Backup export and a native screen wake lock
are still missing ([ANDROID.md](ANDROID.md)).

## 7. Build and test

- `npm run wasm:core` and `wasm:prover` (in `web/`) run wasm-pack into
  `web/public/wasm/{core,prover}`, served untransformed and imported by
  absolute URL.
- `rust-toolchain.toml` pins `nightly-2026-07-09`. `.cargo/config.toml`
  builds wasm32 with `build-std`, `+atomics,+bulk-memory,+mutable-globals,+simd128`,
  explicit `--shared-memory` and `--import-memory`, and a 4 GiB memory
  maximum. The root `Cargo.toml` builds build scripts at `opt-level = 1`,
  because Triton VM's constraint generator overflows the 1 MB stack of a
  Windows main thread when unoptimized. Debug builds optimise dependencies
  (`[profile.dev.package."*"]`), so Triton VM proves at full speed in
  `tauri dev`.
- `vite build --mode desktop` (`npm run build:desktop`, Tauri's
  `beforeBuildCommand`, for the desktop and Android apps) drops the service
  worker and removes `wasm`, `bench` and `staticwebapp.config.json` from the
  output.
- The dev server (`npm run dev`, port 4400) sends only the isolation
  headers, since hot reload needs inline scripts the CSP forbids.
  `npm run build` then `npm run preview` (port 4401) serves the production
  headers, the CSP included.
- Tests: vitest with fake-indexeddb. Run `npm run wasm:core` first:
  `web/src/backend/engineForTests.ts` loads the built core from disk and
  runs it through the worker's own `EngineHost`.
  `web/src/backend/native/surface.test.ts` reads `shells/tauri/src/lib.rs`
  and the native clients and checks command and argument names match.
  `web/src/storage/vector.test.ts` and vault-bridge's tests share the
  envelope vector. Rust: `cargo test -p vault-core` (chain checks against
  real Mainnet blocks included), `cargo test -p vault-bridge` (store,
  envelope, lock), `cargo test -p vault-prover` (the proof check), and the
  full prove-and-verify round trip with
  `cargo test --release -p vault-prover -- --ignored`.
- CI runs only on a push to `main` that touches the app or the crates, or
  by hand; its Rust step is vault-core's tests only.
  `.github/workflows/deploy-web.yml` runs the Rust tests, the wasm builds,
  `npm ci --ignore-scripts`, the tests and the build, publishes a SHA-256
  list and deploys to Azure Static Web Apps.
  `.github/workflows/release-desktop.yml` builds `desktop-v*` tags into
  draft pre-releases. `.github/workflows/android-test.yml` builds an arm64
  test APK by hand from the Actions tab, signed with a key made for that
  run and then thrown away. See [README.md](../README.md),
  [HOSTING.md](HOSTING.md), [DESKTOP-RELEASE.md](DESKTOP-RELEASE.md) and
  [ANDROID.md](ANDROID.md).

## 8. Facts that shape the design

- Integers above 2^53. Some Mainnet blocks carry `u64::MAX` as a chunk
  index in removal records (block 12,000 in
  `crates/vault-core/tests/fixtures`), and UTXO-index identifiers are
  64-bit. Passing them through JavaScript objects produced values Rust
  rejected, and smaller ones would round silently: hence the raw-JSON rule
  (section 4).
- Block volume. Mainnet `wallet_getBlocks` returned 15 to 19 MB per 100
  blocks (measured 2026-09-13); the core scans that in under a second, so on
  a phone the transfer dominates.
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
- Time. A node refuses a transaction stamped a minute or more ahead of its
  clock or more than ten hours behind it, and drops a waiting one after ten
  hours; a block may not carry one stamped more than three days before it.
  Hence a stamp no later than the newest block (`sendStamp`), Give up after
  ten hours, and expiry after three days and an hour (`SEND_LIFETIME_MS`).
- Triton VM 9 changed only the prover. Proofs keep claim version 8, and
  nodes still on neptune-core 0.17 verify them.
- wasm-bindgen-rayon's helper re-fetches its own script into blob workers, so
  the packages are served from the public directory untransformed, and the
  CSP allows `blob:` workers.
- Wasm linear memory never shrinks, so `wasm_memory_bytes` is the peak so
  far, and a fresh prover worker per proof is the only way to return memory.
- Generation addresses (Standard in the app) are about 3,500 characters and
  fit a QR code only as upper-case alphanumeric at error-correction level L,
  hence the upper-cased `NEPTUNECASH:<ADDRESS>` QR
  (`web/src/util/address.ts`).
- This seed derives each output's sender randomness from the build height
  and the receiving address, so coins it created are recognised exactly on
  any device: the core tries the confirmation height and the
  `OWN_OUTPUT_WINDOW` (1000) heights below (`own_build_height`). History folds
  change and self-payments by it, and the mempool watcher skips them.
- The node rewrites mempool transactions as blocks arrive, changing their ids
  but not their output commitments. A UTXO is only a lock script and an
  amount, so its hash repeats across equal payments. Hence commitments and
  `hash:aocl_index` as keys.
- AES-GCM does not commit to one key, so a ciphertext can be crafted to open
  under several passwords, and a wrapped key of another length is where one
  would hide. Every IV and wrapped key is checked for its exact length before
  decryption (`assertEnvelope`).
- Without COOP and COEP a browser gives the page no `SharedArrayBuffer`, and
  the web app does not start: both wasm packages use shared memory
  (`.cargo/config.toml`), and `web/src/main.tsx` stops with a message. The
  native apps need neither header. The node needs CORS either way, because
  the page posts JSON to it from another origin.
