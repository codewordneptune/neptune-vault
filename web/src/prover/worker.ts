// Prover worker: loads the threaded wasm prover, starts its thread pool
// (when the page is cross-origin isolated), and proves one ProofCollection
// per request, reporting progress per sub-proof.

import init, { initThreadPool, prove_proof_collection, count_sub_proofs, wasm_memory_bytes } from '../wasm/prover/vault_prover.js';

export interface ProveRequest {
  witness: Uint8Array;
  network: string;
  blockHeight: number;
  threads: number;
}

export type ProveMessage =
  | { kind: 'ready'; total: number; threads: number }
  | { kind: 'started'; name: string; index: number; total: number }
  | { kind: 'finished'; name: string; index: number; total: number; millis: number; memoryBytes: number }
  | { kind: 'done'; proofCollection: Uint8Array; memoryBytes: number }
  | { kind: 'error'; message: string };

let ready: Promise<void> | null = null;
let poolSize = 0;

async function ensureReady(threads: number): Promise<void> {
  ready ??= (async () => {
    await init();
    if (self.crossOriginIsolated && threads > 0) {
      try {
        await initThreadPool(threads);
        poolSize = threads;
      } catch {
        poolSize = 0;
      }
    }
  })();
  return ready;
}

const post = (m: ProveMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async ({ data }: MessageEvent<ProveRequest>) => {
  try {
    await ensureReady(data.threads);
    const total = count_sub_proofs(data.witness);
    post({ kind: 'ready', total, threads: poolSize });
    const result = prove_proof_collection(data.witness, data.network, BigInt(data.blockHeight), false, false, (json: string) => {
      const event = JSON.parse(json) as { kind: 'started' | 'finished'; name: string; index: number; total: number; millis?: number };
      if (event.kind === 'started') post({ kind: 'started', name: event.name, index: event.index, total: event.total });
      else post({ kind: 'finished', name: event.name, index: event.index, total: event.total, millis: event.millis ?? 0, memoryBytes: wasm_memory_bytes() });
    });
    post({ kind: 'done', proofCollection: result, memoryBytes: wasm_memory_bytes() }, [result.buffer]);
  } catch (e) {
    post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
