// Prover worker for the milestone 0 benchmark.
// Loads the wasm prover, starts its thread pool, proves a ProofCollection for
// the posted witness and reports one message per progress event with the
// wasm memory size after it.

import init, { initThreadPool, prove_proof_collection, count_sub_proofs, prover_version, wasm_memory_bytes } from './pkg/vault_prover.js';

self.onmessage = async ({ data }) => {
  const { witness, network, height, cacheLde, threads, profile } = data;
  try {
    await init();
  } catch (e) {
    self.postMessage({ kind: 'error', message: `wasm init failed: ${e.message ?? e}` });
    return;
  }
  // The threaded build imports its (shared) memory, so it is not on the
  // exports object; the prover reports its own size instead.
  const memory = () => wasm_memory_bytes();
  const bytes = new Uint8Array(witness);

  // The thread pool needs SharedArrayBuffer, which needs cross-origin
  // isolation. Without it, fall back to the single thread and say so.
  let poolSize = 0;
  if (self.crossOriginIsolated && threads > 0) {
    try {
      await initThreadPool(threads);
      poolSize = threads;
    } catch (e) {
      self.postMessage({ kind: 'warn', message: `thread pool failed, single-threaded: ${e.message ?? e}` });
    }
  } else if (threads > 0) {
    self.postMessage({ kind: 'warn', message: 'not cross-origin isolated, single-threaded' });
  }

  try {
    const total = count_sub_proofs(bytes);
    self.postMessage({ kind: 'ready', version: prover_version(), total, threads: poolSize, memory: memory() });
    const result = prove_proof_collection(bytes, network, BigInt(height), Boolean(cacheLde), Boolean(profile), (json) => {
      const event = JSON.parse(json);
      self.postMessage({ ...event, memory: memory() });
    });
    self.postMessage({ kind: 'done', bytes: result.length, memory: memory() });
  } catch (e) {
    self.postMessage({ kind: 'error', message: String(e?.message ?? e), memory: memory() });
  }
};
