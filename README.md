# Neptune Vault

**Proof of concept. Not for production use.** This wallet exists to show
that a browser can hold Neptune Cash keys, sync against a node and prove
transactions on a phone. It has had no security audit, its storage and
recovery paths are days old, and it may lose funds through bugs. Use it
only with amounts you can afford to lose, on testnet or regtest where you
can, and keep your phrase somewhere safe.

A wallet for [Neptune Cash](https://neptune.cash) that runs entirely in the
browser, as an installable web app for Android and iOS. Keys never leave the
device: the seed is generated in a WebAssembly build of Neptune's own wallet
code, encrypted with a password (and optionally a passkey), and stored in the
browser. Transactions are proven on the phone, in WebAssembly, with all cores.

Demo at <https://vault.dev.useneptune.org>. Expect breaking changes in what the
app does; not in what it stores. Backup files from every version stay
readable, and the app upgrades its stored data on its own (see Data formats
in docs/ARCHITECTURE.md).

## What it does

- Create an account from a fresh 18-word phrase, or import one, or restore a
  backup file. The phrase is confirmed by tapping words into place.
- Receive to generation, EC hybrid or viewing addresses, with a QR code and a
  NIP-002 payment link that can carry an amount.
- Sync directly against a Neptune node over JSON-RPC and show balance and
  history; incoming payments to any of the account's keys are found by
  scanning blocks in the browser.
- Send with a review step, fee presets, saved contacts, QR scanning of the
  recipient, and a proof produced in the browser (ProofCollection, a few
  minutes on a phone). Sends survive the app being backgrounded.
- Encrypted seed at rest (Argon2id, AES-256-GCM), auto-lock, password change,
  passkey unlock, export and import of a backup file with contacts.

Requirements and decisions are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md);
the design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the current state,
the regtest procedure and the facts learned along the way in
[docs/M1-STATUS.md](docs/M1-STATUS.md); hosting in [docs/HOSTING.md](docs/HOSTING.md);
what the app keeps and sends in [docs/PRIVACY.md](docs/PRIVACY.md);
prover measurements in [docs/M0-BENCHMARK.md](docs/M0-BENCHMARK.md).

## Layout

```
crates/vault-core      wallet core (keys, scanning, transaction building), Rust -> wasm
crates/vault-prover    ProofCollection prover, Rust -> wasm with threads
crates/vault-fixtures  deterministic witnesses for prover tests
crates/vendor          neptune-consensus, neptune-primitives, triton-vm, twenty-first
                       with the small patches the browser build needs (see VENDOR.md)
crates/legacy          pre-fork prover (claim version 5) with its own vendored 0.15 crates;
                       temporary, until mainnet block 55,000
web/                   the app: Vite, React, Mantine; wasm packages under public/wasm
docs/                  requirements, architecture, status, hosting, benchmarks
```

## Running it locally

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

## Networks

The app switches between Mainnet, Testnet and Regtest; an account belongs to
one network. The node it talks to is set in Settings and must send CORS
headers, since the browser calls it directly. The public mainnet node does.
Regtest nodes accept only mock proofs, so the app skips the prover there.

Until mainnet block 55,000 the network requires transaction proofs of an
older format (claim version 5). A second prover package built from the 0.15
crates covers that period: `npm run wasm:prover-legacy` builds
`crates/legacy/vault-prover-legacy` into `web/public/wasm/prover-legacy`, and
the app picks the package by the claim version the chain requires at the
tip. It goes away once the fork has activated; see docs/M1-STATUS.md.

## Updates

An installed app never replaces its own code on its own. A new build is
downloaded and offered in a strip under the header, with the version you
are on; it takes effect when you tap Update, and never while a send is
running. What runs is what you accepted, and About says which build that is.

## Versions

The app has one version, the `version` field in `web/package.json`, shown
under About in Settings and on Diagnostics together with the commit and the
build time. Every release bumps it and tags the commit `v<version>`, so a
quoted version maps to exact code. The wasm crates carry their own crate
versions, which only change when their interfaces do.

## Deploying

Pushes to `main` that touch the app or the crates build the wasm packages,
run the tests, and deploy to Azure Static Web Apps; the deployment token
lives in a repository secret. docs/HOSTING.md has the details and the
manual alternative.

## Licence

Not decided yet.
