// Main-thread client for the prover worker. One proof at a time; a fresh
// worker per proof so a cancelled or failed run frees its memory.

import { showInt } from '../../util/format';
import type { ProveOutcome, ProveProgress, ProveRequest } from '../types';
import type { ProveMessage } from './proverWorker';
import { ProofCancelledError, totalWeight, weightOf } from '../proving';

export class ProverClient {
  private worker: Worker | null = null;
  // The running proof's reject. Terminating a worker settles nothing by
  // itself: without this, a cancelled send would wait forever, and with it
  // everything its `finally` undoes, the deferred auto-lock first of all.
  private rejectRunning: ((e: Error) => void) | null = null;

  /** Default thread count: all reported cores (decided 2026-09-13). */
  /** All reported cores (decided 2026-09-13), and none without cross-origin isolation, where threads cannot start. */
  defaultThreads(): number {
    return self.crossOriginIsolated ? (navigator.hardwareConcurrency ?? 1) : 0;
  }

  prove(request: ProveRequest, onProgress: (p: ProveProgress) => void): Promise<ProveOutcome> {
    if (this.worker) throw new Error('a proof is already running');
    const worker = new Worker(new URL('./proverWorker.ts', import.meta.url), { type: 'module' });
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
      this.rejectRunning = reject;
      const finish = () => {
        worker.terminate();
        this.worker = null;
        this.rejectRunning = null;
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
            // The first line only, and not much of it. A VM error prints the
            // machine's state after it, stack included, and the stack of a
            // proof about spending holds what unlocks the coins. That text
            // would otherwise be shown, stored with the failed send, and
            // pasted into bug reports.
            reject(new Error((data.message.split(/\r?\n/)[0] ?? '').slice(0, 300) || 'The prover failed.'));
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

  /** Abandon the running proof. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const reject = this.rejectRunning;
    this.rejectRunning = null;
    reject?.(new ProofCancelledError());
  }
}
