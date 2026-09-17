// Main-thread client for the prover worker. One proof at a time; a fresh
// worker per proof so a cancelled or failed run frees its memory.

import type { ProveMessage, ProveRequest } from './worker';
import { showInt } from '../util/format';

export interface ProveProgress {
  index: number;
  total: number;
  name: string;
  /** Share of the proving work finished, 0 to 1, by the measured cost of each sub-proof; not a time. */
  work?: number;
  /** Seconds spent on finished sub-proofs so far. */
  elapsedSeconds: number;
  memoryMb: number;
  threads: number;
}

export interface ProveOutcome {
  proofCollection: Uint8Array;
  seconds: number;
  memoryMb: number;
  threads: number;
}

/**
 * Relative cost of each sub-proof, from the Galaxy S24 measurement
 * (seconds, single thread): the removal-records integrity proof is most of
 * the work, the lock scripts almost none. Used only to move the bar in
 * proportion to work done, never to promise a time.
 */
const SUB_PROOF_WEIGHT: Array<[prefix: string, weight: number]> = [
  ['removal_records_integrity', 309],
  ['collect_lock_scripts', 15],
  ['kernel_to_outputs', 35],
  ['collect_type_scripts', 31],
  ['type_script', 63],
  ['lock_script', 3],
];
function weightOf(name: string): number {
  return SUB_PROOF_WEIGHT.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 30;
}
/** Total weight of a collection with `total` proofs, of which `inputs` are lock scripts. */
function totalWeight(total: number, inputs: number): number {
  const fixed = 309 + 15 + 35 + 31;
  const locks = Math.max(0, Math.min(inputs, total - 4));
  const types = Math.max(0, total - 4 - locks);
  return fixed + locks * 3 + types * 63;
}

export class ProverClient {
  private worker: Worker | null = null;

  /** Default thread count: all reported cores (decided 2026-09-13). */
  static defaultThreads(): number {
    return self.crossOriginIsolated ? (navigator.hardwareConcurrency ?? 1) : 0;
  }

  prove(request: ProveRequest, onProgress: (p: ProveProgress) => void): Promise<ProveOutcome> {
    if (this.worker) throw new Error('a proof is already running');
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const started = performance.now();
    let threads = 0;
    let doneWeight = 0;
    let allWeight = 0;
    let elapsedMs = 0;
    // For the crash message: which sub-proof was running and the last memory reading.
    let current = { name: '', index: 0, total: 0 };
    let lastMemoryMb = 0;

    return new Promise<ProveOutcome>((resolve, reject) => {
      const finish = () => {
        worker.terminate();
        this.worker = null;
      };
      worker.onmessage = ({ data }: MessageEvent<ProveMessage>) => {
        switch (data.kind) {
          case 'ready':
            threads = data.threads;
            allWeight = totalWeight(data.total, request.inputs ?? 1);
            onProgress({ index: 0, total: data.total, name: '', work: 0, elapsedSeconds: 0, memoryMb: 0, threads });
            break;
          case 'started':
            current = { name: data.name, index: data.index, total: data.total };
            onProgress({ index: data.index, total: data.total, name: data.name, work: doneWeight / allWeight, elapsedSeconds: elapsedMs / 1000, memoryMb: 0, threads });
            break;
          case 'finished':
            elapsedMs += data.millis;
            lastMemoryMb = data.memoryBytes / 1048576;
            doneWeight += weightOf(data.name);
            onProgress({ index: data.index + 1, total: data.total, name: data.name, work: Math.min(1, doneWeight / allWeight), elapsedSeconds: elapsedMs / 1000, memoryMb: data.memoryBytes / 1048576, threads });
            break;
          case 'done':
            finish();
            resolve({ proofCollection: data.proofCollection, seconds: (performance.now() - started) / 1000, memoryMb: data.memoryBytes / 1048576, threads });
            break;
          case 'error':
            finish();
            reject(new Error(data.message));
            break;
        }
      };
      worker.onerror = (e) => {
        finish();
        const where = current.name ? ` during ${current.name} (step ${current.index + 1} of ${current.total})` : ' before the first step';
        const memory = lastMemoryMb ? `, memory was ${showInt(lastMemoryMb)} MB after the previous step` : '';
        const seconds = showInt((performance.now() - started) / 1000);
        reject(new Error(`The prover crashed${where} after ${seconds} s${memory}. This usually means the device ran out of memory; a send with fewer coins as inputs needs less.${e.message ? ` (${e.message}${e.filename ? ` at ${e.filename.split('/').pop()}:${e.lineno}` : ''})` : ''}`));
      };
      worker.postMessage(request, [request.witness.buffer]);
    });
  }

  /** Abandon the running proof (F17). */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
