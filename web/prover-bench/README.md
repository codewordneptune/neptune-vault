# Prover benchmark

Proves a ProofCollection for a fixture witness inside the browser and reports
time and wasm memory per sub-proof. Results are in `docs/M0-BENCHMARK.md`.
Run the commands below from the repository root.

## Build the prover

The page offers two packages: the one the app ships and a local one.

```
npm --prefix web run wasm:prover    # "current": web/public/wasm/prover
```

For the "local" package, build straight into the bench folder:

```
wasm-pack build crates/vault-prover --target web --release --out-dir ../../web/prover-bench/pkg
```

The toolchain is the nightly pinned in `rust-toolchain.toml`; don't override
it, or the build may differ from what ships.

The build is threaded (atomics, SIMD, std rebuilt with `build-std`, see
`.cargo/config.toml`). It runs single-threaded automatically on a page that
is not cross-origin isolated.

## Fixtures

The witness files are in `fixtures/`. To make them again, for example after
the consensus crates change:

```
cargo run --release -p vault-fixtures -- fixtures/witness_1in_2out.bin 1 2
cargo run --release -p vault-fixtures -- fixtures/witness_2in_2out.bin 2 2
```

## Serve

Plain http, fine for single-threaded runs and for `http://localhost` on the PC:

```
node web/prover-bench/serve.cjs 4390
```

Threads on a phone need a secure context, which cross-origin isolation
requires. Either create a self-signed certificate once, with the PC's LAN
address in the subject alternative names, and serve https:

```
mkdir web/prover-bench/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=neptune-vault-bench" -addext "subjectAltName=IP:<pc-ip>,DNS:localhost" -keyout web/prover-bench/certs/key.pem -out web/prover-bench/certs/cert.pem
node web/prover-bench/serve.cjs 4443 --https
```

Then open `https://<pc-ip>:4443/web/prover-bench/` on the phone. Chrome warns
about the certificate once: tap Advanced, then Proceed.

Or, without a certificate: on the phone, add `http://<pc-ip>:4390` under
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, relaunch Chrome,
and open `http://<pc-ip>:4390/web/prover-bench/`.

Either way, the device line at the top of the page must say
`crossOriginIsolated: true` for threads to be used.

## Run

Pick the prover package, the witness, the network and the block height (the
height decides the claim version; the prover makes only the post-fork one,
so keep it at 55,000 or above on Mainnet). Leave the LDE cache off, set the
thread count (it defaults to the device's core count when the page is
isolated, else 0, which means single-threaded), optionally turn on the
phase profile, and press Prove ProofCollection. Keep the tab in the
foreground and the screen on. The first sub-proof reports nothing until it
finishes.

Each row's time includes the prover's check of that proof, which the log
also shows on its own ("check 0.25 s"). The Proof column counts units of
1024 field elements, 8 KB each; the total under it is the encoded
collection in KB.
