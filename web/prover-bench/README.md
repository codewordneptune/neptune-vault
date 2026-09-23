# Prover benchmark

Proves a ProofCollection for a fixture witness inside the browser and reports
time and wasm memory per sub-proof. Results are in `docs/M0-BENCHMARK.md`.

## Build the prover

The page offers three packages: the two the app ships and a local one.

```
cd web
npm run wasm:prover           # "current": web/public/wasm/prover
npm run wasm:prover-legacy    # "legacy", pre-fork: web/public/wasm/prover-legacy
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

The witness files are not in the repository; generate them once:

```
cargo run --release -p vault-fixtures -- fixtures/witness_1in_2out.bin 1 2
cargo run --release -p vault-fixtures -- fixtures/witness_2in_2out.bin 2 2
```

## Serve

Plain http, fine for single-threaded runs and for `http://localhost` on the PC:

```
node web/prover-bench/serve.cjs 4390
```

https, needed for threads on a phone (a secure context is required for
cross-origin isolation). Create a self-signed certificate once, with the PC's
LAN address in the subject alternative names:

```
mkdir web\prover-bench\certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=neptune-vault-bench" -addext "subjectAltName=IP:<pc-ip>,DNS:localhost" -keyout web/prover-bench/certs/key.pem -out web/prover-bench/certs/cert.pem
node web/prover-bench/serve.cjs 4443 --https
```

Then open `https://<pc-ip>:4443/web/prover-bench/` on the phone. Chrome warns
about the certificate once: tap Advanced, then Proceed. The device line at the
top of the page must say `crossOriginIsolated: true` for threads to be used.

## Run

Pick the prover package, the witness, the network and the block height (the
height decides the claim version; 55,000 and above is the post-fork format),
leave the LDE cache off, set the thread count (defaults to the device's core
count when isolated, else 0), optionally turn on the phase profile, and press
Prove. Keep the tab in
the foreground and the screen on. The first sub-proof reports nothing until it
finishes.
