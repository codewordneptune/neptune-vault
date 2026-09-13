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
- Hosting on Azure with the isolation headers (component 5).
- A testnet node (O1) and CORS on it (O2). Everything above ran through the
  dev server's same-origin proxy to the local node.
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
neptune-core --network regtest --data-dir C:/nvregtest --listen-rpc 127.0.0.1:9797 --rpc-modules node,chain,wallet,archival --rpc-port 9799 --peer-port 9798 --max-num-peers 0 --disable-cookie-hint --tx-proving-capability=singleproof --tx-proof-upgrading
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
