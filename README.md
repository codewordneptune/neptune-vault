# Neptune Vault

**Proof of concept. Not for production use.** This wallet exists to show
that a browser can hold Neptune Cash keys, sync against a node and prove
transactions on a phone. It has had no security audit, its storage and
recovery paths are weeks old, and it may lose funds through bugs. Use it
only with amounts you can afford to lose, on testnet or regtest where you
can, and keep your phrase somewhere safe.

A wallet for [Neptune Cash](https://neptune.cash) that runs entirely in the
browser, as an installable web app for phones. Keys never leave the device:
the seed is generated in a WebAssembly build of Neptune's own wallet code,
encrypted with a password (and optionally a passkey), and stored in the
browser. Transactions are proven on the phone, in WebAssembly, with all
cores. No server holds anything for you.

Try it at <https://vault.dev.useneptune.org>. Expect breaking changes in
what the app does; not in what it stores. Backup files from every version
stay readable, and the app upgrades its stored data on its own.

## Before you start

- **Devices.** Developed and tested on Android Chrome (a Galaxy S24). iOS
  Safari is the intended second platform and has not been tested yet. A
  desktop browser works for trying it out.
- **Install it.** Add the app to the home screen (Chrome: menu, "Add to
  Home screen"). An installed app is far less likely to have its storage
  cleared by the browser; the app asks for persistent storage and shows a
  warning in Settings when it is not granted.
- **Sending takes a while.** A transaction proof is produced on the device.
  It needs about 1 GB of memory free for the browser and a few minutes on a
  recent phone; the app keeps going if you switch away, and shows the step
  it is on. Devices with 4 GB of RAM or less may run out of memory.
- **The first sync can be long.** Importing a phrase from block 1 on
  Mainnet downloads about 8 to 10 GB of blocks over time. Give the date your
  first funds arrived instead, and the scan starts there.
- **Your phrase is the only backup.** The password protects the phrase on
  this device and cannot be recovered. A forgotten password costs a
  re-import, not your funds. A lost phrase costs the funds.

## What it does

- Create a wallet from a fresh 18-word phrase, confirmed by tapping words
  into place, or import a phrase, or restore a backup file. A mistyped
  phrase is named by word before you go on.
- Receive to Standard (Generation), Short (EC hybrid) or View-only
  addresses, with a QR code, and share a payment request as a NIP-002 link
  or code that can carry an amount, your name and a note for the sender.
- Sync directly against a Neptune node and show balance and history. Blocks
  are scanned in the browser, so the node never learns your addresses.
  Incoming payments show as pending while they wait in the node's mempool.
- Send with a review step, fee presets, saved contacts and camera scanning
  of the recipient's code or payment link. The proof is produced on the
  device and the send survives the app being backgrounded.
- History with one row per transaction, a detail sheet, and a link to each
  output on the explorer.
- Encrypted seed at rest (Argon2id, AES-256-GCM), auto-lock, password
  change, passkey unlock, and export and import of a backup file with
  contacts.
- Rescan from a block or a date, Diagnostics for support, and an update
  strip that offers a new build instead of applying it.

## What it does not do yet

- No security audit has been done. Treat every promise above as a design
  intent that a review may still contradict.
- One wallet per network on a device. A second phrase means importing over
  the first, after backing it up.
- No iOS testing. Safari's storage rules and memory limits are known only
  from documentation.
- Proving happens on the device only; there is no option to hand it to a
  server, by design.
- Explorer links work on Mainnet only.
- Until Mainnet block 55,000 the network requires proofs in an older
  format, so the app carries a second prover for that period; it goes away
  once the fork has activated.
- The network currently asks senders to publish which coins a transaction
  spends, in an extra announcement. The app tells you before you agree.

## How it keeps your keys

- The seed is made and used inside WebAssembly compiled from Neptune's own
  wallet crates, so addresses and signatures are byte for byte what
  neptune-core produces.
- At rest the phrase is encrypted with a key derived from your password by
  Argon2id, under AES-256-GCM, in the browser's storage for this site. A
  passkey can wrap the same key so you can unlock without typing the
  password.
- The wallet locks itself after five minutes idle, when it goes to the
  background, and when you say so. The phrase is shown only after
  unlocking, and hides itself again.
- The node sees which blocks you fetch and the transactions you submit. It
  does not see your keys, your addresses or your balance; scanning happens
  in the browser. [docs/PRIVACY.md](docs/PRIVACY.md) lists exactly what
  leaves the device, and the same text is in the app under About.
- The host serves the code. A new build is downloaded and offered, never
  applied on its own: the strip under the header names the waiting build,
  the one you are on, and links the commits between them on GitHub. About
  says which build you are running.

## Recovering

- **Phrase.** Restores the funds in any wallet that understands Neptune's
  18-word phrase, including this app on another device. Give the date your
  first funds arrived so the scan does not start from block 1.
- **Backup file.** Made under Settings; encrypted with your password. It
  restores the phrase, the network, the start block and your contacts.
  Every backup file this app has ever written stays readable by later
  versions.
- **Password.** Cannot be recovered. Import the phrase again and choose a
  new one.

## Getting help

- Something wrong: [open an issue](https://github.com/codewordneptune/neptune-vault/issues).
  Include the app version and the facts from Diagnostics in Settings
  (threads, cores, memory, installed or tab, last proof), the network, and
  what you did. Never include your phrase or a backup file.
- Community and news: <https://useneptune.org>.
- About Neptune Cash: <https://neptune.cash>.

## Status

Two milestones are done: M0 showed that a phone can produce a Neptune
transaction proof in the browser within ten minutes
([docs/M0-BENCHMARK.md](docs/M0-BENCHMARK.md)); M1 is a working wallet,
verified end to end on regtest and by real sends on Mainnet
([docs/M1-STATUS.md](docs/M1-STATUS.md)). What remains before anyone should
be pointed at it: a licence, a tagged release process with published file
hashes, iOS testing, and a security review.

Screenshots will be added here once the screens have stopped changing
week to week.

## Developing

### Layout

```
crates/vault-core      wallet core (keys, scanning, transaction building), Rust -> wasm
crates/vault-prover    ProofCollection prover, Rust -> wasm with threads
crates/vault-fixtures  deterministic witnesses for prover tests
crates/vendor          neptune-consensus, neptune-primitives, triton-vm, twenty-first
                       with the small patches the browser build needs (see VENDOR.md)
crates/legacy          pre-fork prover (claim version 5) with its own vendored 0.15 crates;
                       temporary, until mainnet block 55,000
web/                   the app: Vite, React, Mantine; wasm packages under public/wasm
docs/                  requirements, architecture, status, hosting, privacy, benchmarks
```

Requirements and decisions are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md);
the design, including the data-format policy, in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the current state, the regtest
procedure and the facts learned along the way in
[docs/M1-STATUS.md](docs/M1-STATUS.md); hosting in
[docs/HOSTING.md](docs/HOSTING.md).

### Running it locally

Prerequisites: Node 22, Rust nightly as pinned in `rust-toolchain.toml` (with
`rust-src` and the `wasm32-unknown-unknown` target), and `wasm-pack`.

```bash
cd web
npm ci
npm run wasm:core      # builds crates/vault-core   -> web/public/wasm/core
npm run wasm:prover    # builds crates/vault-prover -> web/public/wasm/prover
npm run dev            # http://localhost:4400
```

The wasm builds are slow the first time (the standard library is rebuilt
with atomics for threads) and fast after that. The dev server sets the
cross-origin isolation headers the threaded prover needs and proxies
`/regtest-node` to a local regtest node; see docs/M1-STATUS.md for the node
command line and the regtest walkthrough.

Tests:

```bash
cd web && npm test                                   # web app (vitest)
cargo test -p vault-core                             # wallet core, native
cargo test --release -p vault-prover -- --ignored    # full proof round trip, minutes
```

### Networks

The app switches between Mainnet, Testnet and Regtest; a wallet belongs to
one network. The node it talks to is set in Settings and must send CORS
headers, since the browser calls it directly. The public mainnet node does.
Regtest nodes accept only mock proofs, so the app skips the prover there.

Until mainnet block 55,000 the network requires transaction proofs of an
older format (claim version 5). A second prover package built from the 0.15
crates covers that period: `npm run wasm:prover-legacy` builds
`crates/legacy/vault-prover-legacy` into `web/public/wasm/prover-legacy`, and
the app picks the package by the claim version the chain requires at the
tip. It goes away once the fork has activated; see docs/M1-STATUS.md.

### Updates

The service worker downloads a new build and waits; the strip under the
header offers it, and it takes effect when the person taps Update, never
while a send is running. Each build ships a `version.json` (version, commit,
build time) next to its assets; the running app reads it to name the build
that is waiting and to build the "What changed" link.

### Versions

The app has one version, the `version` field in `web/package.json`, shown
under About in Settings and on Diagnostics together with the commit and the
build time. Every release bumps it and tags the commit `v<version>`, so a
quoted version maps to exact code. The wasm crates carry their own crate
versions, which only change when their interfaces do.

### Deploying

Pushes to `main` that touch the app or the crates build the wasm packages,
run the tests, and deploy to Azure Static Web Apps; the deployment token
lives in a repository secret. docs/HOSTING.md has the details and the
manual alternative.

## Licence

Not decided yet.
