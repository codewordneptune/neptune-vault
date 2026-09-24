# Neptune Vault

A self-custodial wallet for [Neptune Cash](https://neptune.cash). It runs in
a browser as an installable web app, and as a desktop app for Windows,
Linux and macOS. Your keys never leave your device. It proves your
transactions on the device itself and talks only to the Neptune node you
choose.

> **Early software.** It works end to end on Mainnet, but it has not been
> independently audited and it changes often. A bug could lose funds. Use
> amounts you can afford to lose, and keep your seed phrase safe.

**Try it:** <https://vault.dev.useneptune.org>

## Contents

- [Features](#features)
- [Platforms](#platforms)
- [Before you use it](#before-you-use-it)
- [Security model](#security-model)
- [Backup and recovery](#backup-and-recovery)
- [Getting help](#getting-help)
- [Development](#development)
- [Documentation](#documentation)
- [Licence](#licence)

## Features

**Wallets**

- Create a wallet from a new 18-word seed phrase. You confirm it by putting
  words back in order.
- Import a seed phrase, or restore a backup file. If you mistype a word,
  the app tells you which one.
- Keep several wallets on one device, each with its own seed phrase,
  password and backup, and switch between them from the header menu.

**Receiving**

- Standard (Generation), Short (EC hybrid) and View-only addresses, each
  with a QR code.
- Payment requests as NIP-002 links or codes. A request can carry an amount, your name and a note.
- Incoming payments show as pending while they wait in the node's mempool.

**Sending**

- A review step, fee presets and saved contacts. A typed or pasted address
  that is a saved contact shows its name.
- Pay up to 10 recipients in one transaction: one proof and one fee.
- Scan the recipient's code with the camera, or from an image you choose
  or paste.
- The app builds and proves the transaction on your device. The send keeps
  going if you switch away from the app.

**History and upkeep**

- One row per transaction, grouped by day, with a detail sheet.
- The detail sheet shows each output's commitment, which you can look up
  in a block explorer.
- Rescan the chain fast, or from a block or a date.
- Diagnostics for support requests.

**Security**

- Your seed phrase is encrypted at rest with your password.
- The wallet locks after an idle time you choose (1, 5, 15 or 30 minutes),
  when it goes to the background, or when you lock it from the menu.
- Unlock with a passkey where the browser supports it.
- Change your password, and export encrypted backup files.

## Platforms

| Platform | Status |
|---|---|
| Android, Chrome (installed web app) | Main target. Tested on a Galaxy S24, including Mainnet sends. |
| iOS, Safari (installed web app) | Intended. Not tested yet. |
| Desktop browsers | Work. Good for trying the app out. |
| Windows desktop app | Builds and runs. Not signed yet. |
| Linux and macOS desktop apps | Built by CI. Not tested yet. Not signed yet. |

The web app and the desktop apps are the same interface. The desktop apps
run the wallet engine and the prover as native code rather than
WebAssembly. They store the wallet in the app's data folder rather than in
browser storage.

## Before you use it

- **Install the web app.** On Android, use Chrome's menu, then "Add to Home
  screen". A browser is much less likely to clear an installed app's
  storage. Settings warns you when the browser has not granted persistent
  storage.
- **Sending takes a few minutes.** A transaction proof needs about 1 GB of
  free memory and a few minutes on a recent phone. Devices with 4 GB of RAM
  or less may run out of memory. A block that arrives while the proof is
  being made is usually no problem: nodes from neptune-core 0.18 take a
  proof built up to three blocks behind the tip. If the node refuses it,
  the app builds and proves again and tells you, with up to three attempts
  in all.
- **There are two ways to restore.**
  - **Fast** takes seconds. It asks the node's coin index which blocks
    hold your payments. The node learns which coins are yours, but not the
    amounts.
  - **Private** downloads and scans every block from a date you choose.
    From the start of Mainnet that is several gigabytes and hours of
    scanning. The node learns nothing about your coins.
- **Your seed phrase is the only real backup.** Your password protects the
  wallet on this device and cannot be recovered. If you forget the
  password, import your seed phrase again. If you lose the seed phrase, you
  lose the funds.

## Security model

- **Neptune's own code.** Keys, addresses, scanning and proving come from
  Neptune's own crates. The web app runs them as WebAssembly and the
  desktop app runs them natively. Addresses and signatures match what
  neptune-core produces.
- **Encryption at rest.** The seed phrase is encrypted with AES-256-GCM,
  under a key derived from your password with Argon2id. A passkey can wrap
  the same key.
- **What the node sees.** It sees which blocks you fetch and the
  transactions you submit. Scanning happens on your device, so the node
  does not learn your keys, addresses or balance. A fast restore is the
  exception: it reveals which coins are yours.
  [docs/PRIVACY.md](docs/PRIVACY.md) lists everything that leaves the
  device. The app shows the same text under Settings, About.
- **Trusting the host.** A web wallet runs whatever code its host serves.
  - The app downloads a new build but never applies it while it is open.
    The build takes effect when you tap Update, or the next time the app
    starts.
  - The update strip names the waiting build and links the changes on
    GitHub.
  - Each deploy publishes a list of file hashes, so anyone can check what
    the site serves ([docs/HOSTING.md](docs/HOSTING.md)).
  - The desktop apps carry their own files. They only ask GitHub whether a
    newer release exists.

## Backup and recovery

- **Seed phrase.** Restores your funds in any wallet that supports
  Neptune's 18-word seed phrases, including this app on another device.
- **Backup file.** Export one from Settings, with your password. It
  restores the seed phrase, the network, the start block and your
  contacts.
  - The seed phrase and the contacts are encrypted.
  - The rest of the file is sealed, so the app refuses a file that has
    been changed. A wrong password gives a different message than a
    changed file.
  - Every version of the app can read backup files from earlier versions.
- **Password.** Cannot be recovered. Import your seed phrase again and
  choose a new password.

## Getting help

- **Bugs:** [open an issue](https://github.com/codewordneptune/neptune-vault/issues).
  - Include the app version, the details from Settings, Diagnostics, the
    network, and what you did.
  - **Never share your seed phrase or a backup file.**
- **Questions:** the [Neptune Cash Telegram](https://t.me/neptune_project)
  or the [forum](https://talk.neptune.cash/).
- **News and guides:** <https://useneptune.org>

## Development

### Repository layout

```
web/                    the app: Vite, React, Mantine; wasm packages under public/wasm
crates/vault-core       wallet engine (keys, scanning, transactions, storage format), Rust to wasm
crates/vault-prover     transaction prover, Rust to wasm with threads
crates/vault-bridge     vault-core and the prover as native code, for the desktop shell
crates/vault-fixtures   deterministic witnesses for prover tests
crates/vendor           neptune-consensus, neptune-primitives, triton-vm, twenty-first,
                        patched for wasm (see crates/vendor/VENDOR.md)
shells/tauri            the desktop app (Tauri 2)
fixtures/, test-vectors/  test inputs
docs/                   design, privacy, hosting, releases
```

### Prerequisites

- Node 22
- Rust nightly, as pinned in `rust-toolchain.toml` (it pulls in `rust-src`
  and the `wasm32-unknown-unknown` target)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)

### Run the web app

```bash
cd web
npm ci
npm run wasm:core      # crates/vault-core   -> web/public/wasm/core
npm run wasm:prover    # crates/vault-prover -> web/public/wasm/prover
npm run dev            # http://localhost:4400
```

The first wasm build is slow, because the standard library is rebuilt with
atomics for threads. Later builds are quick.

The dev server sends the cross-origin isolation headers that the threaded
prover needs. It also proxies `/regtest-node` to a regtest node at
`127.0.0.1:9797`.

### Tests

```bash
cd web && npm test                                   # web app (vitest)
cd web && npm run typecheck
cargo test -p vault-core                             # wallet engine, native
cargo test --release -p vault-prover -- --ignored    # full proof round trip, takes minutes
```

### Local regtest node

Use neptune-core 0.17. Start the node with JSON-RPC, the coin index (for
fast restores) and proof upgrading. Without upgrading, transactions never
leave the mempool on regtest:

```bash
neptune-core --network regtest --data-dir <dir> --listen-rpc 127.0.0.1:9797 --rpc-modules node,chain,wallet,archival,mempool,utxoindex --utxo-index --rpc-port 9799 --peer-port 9798 --max-num-peers 0 --disable-cookie-hint --tx-proving-capability=singleproof --tx-proof-upgrading
```

Fund the node's wallet:

```bash
neptune-cli --data-dir <dir> --port 9799 mine-blocks-to-wallet 5
```

Then choose Regtest in the app, create a wallet, and send coins to it:

```bash
neptune-cli --data-dir <dir> --port 9799 send <app address> 10 0.1 vault on-chain on-chain
```

```bash
neptune-cli --data-dir <dir> --port 9799 mine-blocks-to-wallet 1
```

Things to know about regtest:

- Mine only after the node logs `single proof: Done`.
- Restarting the node empties its mempool.
- Regtest nodes accept only mock proofs, so the app skips real proving on
  regtest.

### Networks and nodes

- The app switches between Mainnet, Testnet and Regtest. Each wallet
  belongs to one network.
- You set the node in Settings.
- In a browser, the node must send CORS headers, because the page calls it
  directly. The default Mainnet node does.
- Every network is past the delta fork (Mainnet block 55,000), so every
  proof is in the post-fork format (claim version 8).

### Desktop app

```bash
cd web && npm ci
```

```bash
cd shells/tauri && npx --prefix ../../web tauri dev
```

```bash
cd shells/tauri && npx --prefix ../../web tauri build
```

- `tauri dev` runs the desktop app against the web dev server.
- `tauri build` makes the installers. On Windows, keep `CARGO_TARGET_DIR`
  short (for example `C:/nvnative`), or the linker can fail on long paths.
- Pushing a `desktop-v<version>` tag builds all platforms and attaches the
  installers to a draft release.
- Details, and the signing and updater keys still needed:
  [docs/DESKTOP-RELEASE.md](docs/DESKTOP-RELEASE.md).

### Versions and deployment

- The app has one version: the `version` field in `web/package.json`.
  - It appears under About and in Diagnostics, with the commit and the
    build time.
  - Each release is tagged `v<version>`. Desktop releases are tagged
    `desktop-v<version>`.
- Each push to `main` that touches the app or the crates does three things:
  - builds the wasm packages
  - runs the tests
  - deploys to Azure Static Web Apps

  See [docs/HOSTING.md](docs/HOSTING.md).
- An open web app checks for a new build every hour, and whenever it comes
  back to the front.
  - Each build ships a `version.json` (version, commit, build time).
  - The update strip reads it to name the waiting build and to link to what
    changed.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the design and the data-format policy
- [docs/PRIVACY.md](docs/PRIVACY.md): what leaves the device, and who sees it
- [docs/HOSTING.md](docs/HOSTING.md): hosting, headers and verifying a deploy
- [docs/DESKTOP-RELEASE.md](docs/DESKTOP-RELEASE.md): building and releasing the desktop apps
- [docs/M0-BENCHMARK.md](docs/M0-BENCHMARK.md): the measured cost of proving in a browser (historical record)

## Licence

Not decided yet.
