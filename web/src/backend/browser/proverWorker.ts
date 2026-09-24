// Prover worker: loads the threaded wasm prover, starts its thread pool
// (when the page is cross-origin isolated), and proves one ProofCollection
// per request, reporting progress per sub-proof.

// The wasm package is served untransformed from /wasm/prover (public dir):
// wasm-bindgen-rayon re-fetches its own helper script into blob workers,
// and a dev-server transform would inject imports those cannot resolve.
import type { ProveRequest } from '../types';

type ProverModule = typeof import('../../../public/wasm/prover/vault_prover');
const PACKAGE = '/wasm/prover/vault_prover.js';
let prover: ProverModule | null = null;
async function loadProver(): Promise<ProverModule> {
  // An absolute URL keeps both TypeScript and Vite's dev-time import rewriting
  // (which appends a query to root-relative dynamic imports) out of the way.
  const url = new URL(PACKAGE, self.location.origin).href;
  prover ??= (await import(/* @vite-ignore */ url)) as ProverModule;
  return prover;
}

export type ProveMessage =
  | { kind: 'ready'; total: number; threads: number }
  | { kind: 'started'; name: string; index: number; total: number }
  | { kind: 'finished'; name: string; index: number; total: number; millis: number; memoryBytes: number }
  | { kind: 'done'; proofCollection: Uint8Array; memoryBytes: number }
  | { kind: 'error'; message: string };

let ready: Promise<ProverModule> | null = null;
let poolSize = 0;

async function ensureReady(threads: number): Promise<ProverModule> {
  const p = ready ?? (async () => {
    const m = await loadProver();
    await m.default();
    if (self.crossOriginIsolated && threads > 0) {
      try {
        await m.initThreadPool(threads);
        poolSize = threads;
      } catch {
        poolSize = 0;
      }
    }
    return m;
  })();
  ready = p;
  return p;
}

const post = (m: ProveMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async ({ data }: MessageEvent<ProveRequest>) => {
  try {
    const m = await ensureReady(data.threads);
    const total = m.count_sub_proofs(data.witness);
    post({ kind: 'ready', total, threads: poolSize });
    const result = m.prove_proof_collection(data.witness, data.network, BigInt(data.blockHeight), false, false, (json: string) => {
      const event = JSON.parse(json) as { kind: 'started' | 'finished'; name: string; index: number; total: number; millis?: number };
      if (event.kind === 'started') post({ kind: 'started', name: event.name, index: event.index, total: event.total });
      else post({ kind: 'finished', name: event.name, index: event.index, total: event.total, millis: event.millis ?? 0, memoryBytes: m.wasm_memory_bytes() });
    });
    post({ kind: 'done', proofCollection: result, memoryBytes: m.wasm_memory_bytes() }, [result.buffer]);
  } catch (e) {
    post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
