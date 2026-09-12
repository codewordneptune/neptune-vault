// Prover worker for the milestone 0 benchmark.
// Loads the wasm prover, proves a ProofCollection for the posted witness and
// reports one message per progress event with the wasm memory size after it.

import init, { prove_proof_collection, count_sub_proofs, prover_version } from './pkg/vault_prover.js';

self.onmessage = async ({ data }) => {
  const { witness, network, height, cacheLde } = data;
  let wasm;
  try {
    wasm = await init();
  } catch (e) {
    self.postMessage({ kind: 'error', message: `wasm init failed: ${e.message ?? e}` });
    return;
  }
  const memory = () => wasm.memory.buffer.byteLength;
  const bytes = new Uint8Array(witness);

  try {
    const total = count_sub_proofs(bytes);
    self.postMessage({ kind: 'ready', version: prover_version(), total, memory: memory() });
    const result = prove_proof_collection(bytes, network, BigInt(height), Boolean(cacheLde), (json) => {
      const event = JSON.parse(json);
      self.postMessage({ ...event, memory: memory() });
    });
    self.postMessage({ kind: 'done', bytes: result.length, memory: memory() });
  } catch (e) {
    self.postMessage({ kind: 'error', message: String(e?.message ?? e), memory: memory() });
  }
};
