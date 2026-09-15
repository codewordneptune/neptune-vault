# Milestone 1: status and regtest procedure

Updated 2026-09-13. Branch `cwn/m1-wallet-core`.

## What is verified

End to end on this PC, desktop Chrome, against a local neptune-core 0.17.0
regtest node:

| Step | Result |
|------|--------|
| Create account: phrase, word confirmation, password | Works. Argon2id (64 MiB, 3 passes) plus AES-GCM envelope stored in IndexedDB. |
| Reload and unlock with the password | Works. Wrong password is rejected by the envelope, not by the worker. |
| Receive: address and QR, funds sent from the node wallet | 10 NPT found by the sync at the confirming block, balance and history updated. |
| Send: plan, membership proofs, witness, proof, submit | Accepted by the node, mined, confirmed; input reserved while pending; change returns as a confirmed receipt. |
| Real proof in the browser inside the app | Proven with 16 threads in about 2.5 minutes. Rejected by the regtest node, which by consensus rule accepts only mock proofs. |
| Mock proof on regtest | Submitted and mined. The app selects this path on regtest only. |
| Reorg rollback, error handling, auto-lock, export and import | Covered by 19 vitest tests with fakes; not yet exercised in the browser. |

Not yet done for milestone 1:

- The acceptance test on the Galaxy S24 (R28), including clearing site data
  and restoring from the export file.
- A testnet node (O1). Mainnet: the public node enabled CORS on
  2026-09-13 (`Access-Control-Allow-Origin: *`), so the hosted app reaches
  it directly; O2 is closed.
- Polish: change outputs appear as a "received" entry next to the "sent"
  one; the network label in the header does not update until reload; Enter
  in the unlock form does not submit in the automated browser.

## Running the regtest setup

Build the node once (about 25 minutes cold, see the memory notes for the
Windows recipe): worktree of neptune-core at tag `v0.17.0`, then
`cargo +stable build --release --bin neptune-core --bin neptune-cli`.

Start the node with the JSON-RPC listener, single-proof capability and
third-party proof upgrading (without the last two, transactions never leave
the mempool on regtest):

```
neptune-core --network regtest --data-dir C:/nvregtest --listen-rpc 127.0.0.1:9797 --rpc-modules node,chain,wallet,archival,mempool --rpc-port 9799 --peer-port 9798 --max-num-peers 0 --disable-cookie-hint --tx-proving-capability=singleproof --tx-proof-upgrading
```

Fund the node wallet and read its address:

```
neptune-cli --data-dir C:/nvregtest --port 9799 mine-blocks-to-wallet 5
neptune-cli --data-dir C:/nvregtest --port 9799 next-receiving-address
```

Start the app (`npm run dev` in `web/`), choose regtest on the welcome
screen, create an account, and send it coins from the node:

```
neptune-cli --data-dir C:/nvregtest --port 9799 send <app address> 10 0.1 vault on-chain on-chain
neptune-cli --data-dir C:/nvregtest --port 9799 mine-blocks-to-wallet 1
```

A transaction sits in the mempool until the node's proof upgrader has
produced a single proof for it (seconds on regtest); mine after the log says
`single proof: Done`. Restarting the node empties the mempool.

## Facts learned that shape later work

- Node JSON must never pass through JavaScript objects on its way to the
  wasm core. Mainnet blocks carry `u64::MAX` in every removal record's
  chunk dictionary (`chunk_index`), and `JSON.parse` rounds any integer
  above 2^53; re-serialising produced a value Rust rejected, and smaller
  big integers would have been rounded silently. The node client keeps the
  raw response text for blocks, membership-proof snapshots and the tip
  header, and the core parses the JSON-RPC envelope (fixed 2026-09-13).
- Mainnet `wallet_getBlocks` returns 15 to 19 MB per 100 blocks; the core
  scans such a batch in under a second, the transfer dominates on a phone.
- The consensus verifier on mock-proof networks (`Network::use_mock_proof`)
  returns `proof.is_valid_mock()` and nothing else, so real proofs are
  rejected on regtest. Real proving can only be tested end to end on testnet
  or mainnet.
- The node only composes blocks from single-proof transactions. Our
  ProofCollection submissions rely on some node upgrading them, which is
  the normal three-step mining flow on mainnet.
- Regtest requires lustration announcements at these heights; the app asks
  the user and adds them.
- wasm-bindgen-rayon's worker helper re-fetches itself into a blob worker,
  so the wasm packages must be served untransformed (public directory) and
  loaded by absolute URL; a bundler transform breaks the thread pool.
- Generation addresses are about 3500 characters; they fit a QR code only
  in upper-case alphanumeric mode at error-correction level L.
- Pre-fork proofs (2026-09-14). Until mainnet block 55,000 the consensus rules ask for Triton VM claim version 5, which the 0.17 crates and triton-vm 8 cannot produce; the node rejected the first mainnet send with "claim version 5 needs the pre-delta prover". A second wasm package, vault-prover-legacy in crates/legacy (its own workspace: vendored neptune-consensus 0.15.0, neptune-primitives 0.15.0, triton-vm 7.0.0, sharing the vendored twenty-first), has the same exports as vault-prover; the app asks the core for the claim version at the tip height (`claim_version(network, height)`: 5 before the fork, 8 after) and the prover worker loads /wasm/prover-legacy or /wasm/prover accordingly. PrimitiveWitness serialises identically in 0.15 and 0.17, so the witness built by the 0.17 core feeds the 0.15 prover unchanged. Verified: native round trip (a one-input ProofCollection with version 5 claims verifies under the pre-fork mainnet rule set, 62 s), and the package loads in the browser with a thread pool. Package size 3.2 MB, build about 40 minutes cold. Verified 2026-09-14 (later the same day): a real mainnet send from the Galaxy S24, proven in the browser with the pre-fork package and accepted by the network. An earlier attempt on the same phone had crashed the prover worker; the same build and the same kind of transaction succeeded afterwards, so that was the device's free memory at the time, not the package. Diagnostics now keeps the last proof's numbers for the next such case. The package and crates/legacy go away once the fork has activated.
- Incoming payments before they are mined (2026-09-14). The node's `mempool`
  namespace (on by default on the public mainnet node; `mempool` must be in
  `--rpc-modules` on your own) lists transaction ids and hands out kernels.
  The core's `scan_mempool_kernel` runs the announcement scan over one kernel
  and reports outputs for this wallet by commitment, plus any of the wallet's
  coins it spends. The app's MempoolWatcher (web/src/wallet/mempool.ts) polls
  after every sync and every 30 s while unlocked and visible, fetches at most
  30 unseen kernels per poll, writes a pending received row keyed by output
  commitment (kernel ids change as the node rewrites transactions; the
  commitment does not), drops the row when the transaction has been gone for
  two polls, and marks the wallet's own pending sends with whether the node
  still holds them. Outputs of the wallet's own pending sends (change, a
  payment to itself) are not incoming and are skipped; a transaction that
  spends this wallet's coins without being one of its sends (another device,
  same phrase) becomes one pending "sent" row and holds those coins, and
  the block scan turns it into the confirmed row. The block scan deletes the
  pending row when the coin arrives. Verified on regtest: a node-wallet send showed as "Incoming +0.7"
  within seconds and became "Received · block 14" after mining. A node
  without the namespace answers "Method not found" once and the watcher
  switches itself off. What would make it cheap at scale is a receiver
  identifier filter on the node (proposal sent to Thorkil).
