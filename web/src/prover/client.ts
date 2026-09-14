// Main-thread client for the prover worker. One proof at a time; a fresh
// worker per proof so a cancelled or failed run frees its memory.

import type { ProveMessage, ProveRequest } from './worker';

export interface ProveProgress {
  index: number;
  total: number;
  name: string;
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
            onProgress({ index: 0, total: data.total, name: '', elapsedSeconds: 0, memoryMb: 0, threads });
            break;
          case 'started':
            current = { name: data.name, index: data.index, total: data.total };
            onProgress({ index: data.index, total: data.total, name: data.name, elapsedSeconds: elapsedMs / 1000, memoryMb: 0, threads });
            break;
          case 'finished':
            elapsedMs += data.millis;
            lastMemoryMb = data.memoryBytes / 1048576;
            onProgress({ index: data.index + 1, total: data.total, name: data.name, elapsedSeconds: elapsedMs / 1000, memoryMb: data.memoryBytes / 1048576, threads });
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
        const memory = lastMemoryMb ? `, memory was ${Math.round(lastMemoryMb)} MB after the previous step` : '';
        const seconds = Math.round((performance.now() - started) / 1000);
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
