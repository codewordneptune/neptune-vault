# Neptune Vault: Requirements

Status: draft for review. Decisions were collected in an interview on 2026-09-12.
Nothing below is implemented yet. Items marked OPEN still need an answer before
the affected part can be built.

## 1. Purpose

Neptune Vault is a progressive web app (PWA) wallet for Neptune Cash (NPT). It
runs in the browser on Android and iOS, can be installed to the home screen,
and never hands keys to a server. It is a light wallet: it does not run a node,
it talks to a neptune-core node over its JSON-RPC API.

## 2. Goals for the first release

- G1. A user can create a new account (seed) on the phone.
- G2. The seed is stored encrypted and can be recovered after the browser's
  site data has been cleared.
- G3. A user can receive NPT to a generation address and see the balance update.
- G4. A user can send NPT with a ProofCollection-backed transaction proven on
  the phone.

## 3. Non-goals for the first release

- Multiple accounts in the UI (storage is designed for it, see R14).
- Symmetric-key or watch-only addresses (R15).
- Multiple recipients per transaction (R16).
- Re-proving a pending transaction when the chain tip moves (R18).
- Remote or delegated proving of any kind (R1).
- Desktop browser support as a tested target (R21).
- Mining, staking, or any node functionality.

## 4. Decisions

| Id  | Topic | Decision |
|-----|-------|----------|
| R1  | Proving | ProofCollection is proven entirely in the browser with WebAssembly. No proving server. |
| R2  | Node | The app talks directly to a neptune-core node's JSON-RPC endpoint. The user can change the node URL in settings. |
| R3  | Wallet core | Key derivation, address handling, block scanning, and witness construction are the Rust neptune crates compiled to WebAssembly. No TypeScript reimplementation of cryptography. |
| R4  | Network | Mainnet and testnet, switchable in settings. |
| R5  | Default mainnet node | `https://wallet.neptunefundamentals.org` (the desktop wallet's default). |
| R6  | Default testnet node | OPEN. No URL yet. |
| R7  | Seed backup | Mandatory seed phrase backup at account creation, with word confirmation before the account is usable. |
| R8  | Export file | The user can export the encrypted seed as a file to device storage and import it later. |
| R9  | Passkey backup | Optional: where the platform supports the WebAuthn PRF extension, the encrypted seed can additionally be wrapped with a passkey-derived key. Not required on iOS 17. |
| R10 | Unlock | Password or PIN. Argon2id key derivation, AES-256-GCM encryption via WebCrypto. |
| R11 | Auto-lock | The decrypted seed is held only while unlocked. Lock after 5 minutes idle and immediately when the app goes to the background (decided 2026-09-13). Exception (2026-09-13): while a send is running, both locks are deferred and applied when it finishes, so a proof survives an app switch; the seed stays in worker memory for those minutes. |
| R12 | Address type | Generation, EC hybrid and viewing addresses, each with its own key sequence (changed 2026-09-13 from generation only). Symmetric keys are not offered. |
| R13 | Send screen | One recipient, amount, and fee. |
| R14 | Accounts | One account in the UI. All storage is keyed by an account id so more can be added later. |
| R15 | Other key types | Not supported in the first release. |
| R16 | Batch send | Not supported in the first release. |
| R17 | Sync | Use the node's bloom-index and UTXO-origin endpoints to skip blocks that cannot contain anything relevant; fall back to downloading and scanning blocks. |
| R18 | Transaction status | After broadcast the transaction shows as pending in history. It becomes confirmed when it appears in a canonical block. Its inputs stay reserved until then. No re-proving. |
| R19 | Fee | Presets Low 0.1, Medium 0.3 (default), High 0.5 NPT, plus Custom with a free field (decided 2026-09-13). All clear the node's default proof-upgrader floor (60 % of the fee must reach 0.01 NPT, so about 0.017 NPT). |
| R20 | Frontend | React, Mantine, Vite. Same stack as the desktop wallet so screens and helpers can be ported. |
| R21 | Platforms | iOS 17 and later Safari, current Android Chrome, both installed as a home-screen PWA. |
| R22 | Test device | Samsung Galaxy S24, 8 GB RAM. No iOS device is available for testing. |
| R23 | Proving budget | Up to 10 minutes on the test device. Keep the screen awake while proving. Show progress per sub-proof. If the device cannot finish, fail with a clear error. No fallback. |
| R24 | Hosting | Azure Static Web Apps at `https://vault.dev.useneptune.org` (set up 2026-09-13). |
| R25 | Repository | Monorepo: `crates/` for Rust, `web/` for the PWA. |
| R26 | Licence | No licence file yet. |
| R27 | Process | Requirements and architecture documents first, review, then implementation on feature branches with pull requests. |
| R28 | Milestone 1 | Create account, receive, see balance, and send with an in-browser proof, end to end on the Galaxy S24 against a testnet node. Developed against a mock node in the repo until O1 and O2 are resolved; delivered as one pull request per component (decided 2026-09-13). |
| R29 | Consensus version | Target the 0.17 neptune crates and a 0.17 or later node from the start, because the delta hardfork activates at block 55,000 (expected around 2026-09-24). |

## 5. Functional requirements

### 5.1 Account creation

- F1. The app generates a new seed with the same derivation as neptune-core, so
  the phrase can be imported into the desktop wallet and neptune-core.
- F2. The user chooses a password or PIN before the seed is stored (R10).
- F3. The seed phrase is shown once and the user must confirm it by selecting or
  typing words in order before proceeding (R7).
- F4. The user can import an existing seed phrase.
- F5. The user can import an exported file (R8).

### 5.2 Storage and locking

- F6. The seed at rest is always encrypted. The password is never stored.
- F7. The encrypted blob, wallet state, and settings live in IndexedDB, keyed by
  account id (R14). The app requests persistent storage from the browser so
  the data is not evicted under storage pressure.
- F8. After the idle timeout or on backgrounding, the app locks and discards
  the decrypted seed from memory (R11).
- F9. Viewing balance and history after a relock requires unlocking again. No
  separate viewing key is stored in the first release.
- F10. On platforms with WebAuthn PRF, the user can opt into passkey wrapping
  (R9). The password path must always keep working.

### 5.3 Receive

- F11. The app shows the account's current address of the chosen kind
  (generation, EC hybrid or viewing) as text and a full-width QR code, and
  can produce the next unused address of that kind.
- F12. The app syncs from the account's birthday block (creation height) and
  detects incoming UTXOs addressed to any of the account's keys (R12, R17).
- F19. Contacts (added 2026-09-13, moved off the tab bar 2026-09-14): a Contacts screen, reached from the recipient picker on Send and from Settings, lists saved recipients per
  account (name, full address, kind); add by paste or scan, rename, delete,
  start a send. Send offers saved recipients and saving the recipient after
  a send. Contacts are included in the export file (format version 2).
- F13. Balance shows confirmed funds and, separately, funds reserved by pending
  outgoing transactions (R18).
- F14. Sync runs while the app is in the foreground and resumes from where it
  stopped.

### 5.4 Send

- F15. The send form takes one recipient address, an amount, and a fee (R13,
  R19). Address and amount are validated before proving starts.
- F16. The app selects inputs, requests mutator-set membership proofs from the
  node, builds the primitive witness, and proves the ProofCollection in a
  worker (R1).
- F17. Proving shows progress per sub-proof, keeps the screen awake, and can be
  cancelled (R23).
- F18. On success the transaction is submitted to the node and appears as
  pending. On failure the user sees which step failed and why, and no inputs
  stay reserved.
- F19. The proof version must match the node's consensus rule set at the tip
  (R29).

### 5.5 Settings

- F20. Network switch between mainnet and testnet (R4). Each network has its
  own account state and its own node URL.
- F21. Node URL is editable, with a connectivity check.
- F22. Backup actions: show seed phrase (after unlock), export encrypted file,
  set up passkey wrapping where available.

## 6. Non-functional requirements

- N1. Installable PWA: web app manifest, service worker, offline shell. Sending
  and syncing require network access.
- N2. Runs on iOS 17 Safari and current Android Chrome (R21). Tested on the
  Galaxy S24 (R22); iOS is untested until a device is available.
- N3. Proving completes within 10 minutes on the S24 for a one-input,
  two-output transaction, or fails with a clear message (R23).
- N4. Served over HTTPS with the cross-origin isolation headers needed for
  multi-threaded WebAssembly (see ARCHITECTURE.md section 7).
- N5. No secret ever leaves the device. The node receives only blocks requests,
  membership-proof requests, and fully proven transactions.
- N6. Amounts are displayed and parsed without floating-point rounding.

## 7. Milestone 1 acceptance test

On the Galaxy S24, installed as a PWA, against a testnet node:

1. Create an account, confirm the phrase, set a password. Relaunch: the app
   asks for the password and unlocks.
2. Clear the browser's site data. Reinstall the app. Import the exported file
   or the phrase. The same address is shown.
3. Send testnet NPT to the address from a neptune-core node. The balance updates
   after the block is mined.
4. Send part of it back. The proof completes within 10 minutes, the transaction
   shows as pending, then confirmed once mined. The balance and the receiving
   node agree.

## 8. Open items

| Id | Item | Needed by |
|----|------|-----------|
| O1 | Testnet node URL (R6) | Milestone 1 testing |
| O4 | Default fee value (R19) | Send screen |
| O6 | Resolved 2026-09-13: vendored copies in crates/vendor with the changes listed in VENDOR.md (consensus, primitives, twenty-first, triton-vm). Upstreaming remains desirable. | |
