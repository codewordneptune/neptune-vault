# Prover benchmark

Proves a ProofCollection for a fixture witness inside the browser and reports
time and wasm memory per sub-proof. Results are in `docs/M0-BENCHMARK.md`.

## Build the prover

```
set CARGO_TARGET_DIR=C:\nvwasm
set RUSTUP_TOOLCHAIN=nightly
wasm-pack build crates/vault-prover --target web --release --out-dir ../../web/prover-bench/pkg
```

The build is threaded (atomics, SIMD, std rebuilt with `build-std`, see
`.cargo/config.toml`). It runs single-threaded automatically on a page that
is not cross-origin isolated.

## Fixtures

```
cargo run --release -p vault-fixtures -- fixtures/witness_1in_2out.bin 1 2
```

## Serve

Plain http, fine for single-threaded runs and for `http://localhost` on the PC:

```
node web/prover-bench/serve.js 4390
```

https, needed for threads on a phone (a secure context is required for
cross-origin isolation). Create a self-signed certificate once, with the PC's
LAN address in the subject alternative names:

```
mkdir web\prover-bench\certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=neptune-vault-bench" -addext "subjectAltName=IP:192.168.50.15,DNS:localhost" -keyout web/prover-bench/certs/key.pem -out web/prover-bench/certs/cert.pem
node web/prover-bench/serve.js 4443 --https
```

Then open `https://<pc-ip>:4443/web/prover-bench/` on the phone. Chrome warns
about the certificate once: tap Advanced, then Proceed. The device line at the
top of the page must say `crossOriginIsolated: true` for threads to be used.

## Run

Pick the witness, leave the LDE cache off, set the thread count (defaults to
the device's core count when isolated, else 0), press Prove. Keep the tab in
the foreground and the screen on. The first sub-proof reports nothing until it
finishes.
