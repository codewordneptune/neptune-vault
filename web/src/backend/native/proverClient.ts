// The prover, when the shell hosts it.
//
// One command runs the whole proof and returns the collection; a channel
// carries the sub-proof events while it runs. Nothing here needs
// cross-origin isolation or SharedArrayBuffer, because the threads belong to
// rayon on the device rather than to the page.

import { Channel } from '@tauri-apps/api/core';

import { ProofCancelledError, totalWeight, weightOf } from '../proving';
import type { Prover, ProveOutcome, ProveProgress, ProveRequest } from '../types';
import { call, fromBase64, toBase64 } from './bridge';

/** Sub-proof events, as the shell sends them. The same shape the worker posts. */
type ProveEvent =
  | { kind: 'ready'; total: number; threads: number }
  | { kind: 'started'; name: string; index: number; total: number }
  | { kind: 'finished'; name: string; index: number; total: number; millis: number; memoryBytes: number };

interface WireOutcome {
  proofCollection: string;
  memoryBytes: number;
  threads: number;
}

export class NativeProverClient implements Prover {
  /** Rejects the running proof. Null when none is running. */
  private rejectRunning: ((e: Error) => void) | null = null;

  /**
   * Every core the device reports. There is no cross-origin isolation to
   * check: the shell's threads are not the page's. The shell may still know
   * better and clamp this.
   */
  defaultThreads(): number {
    return navigator.hardwareConcurrency ?? 4;
  }

  prove(request: ProveRequest, onProgress: (p: ProveProgress) => void): Promise<ProveOutcome> {
    if (this.rejectRunning) throw new Error('a proof is already running');
    const started = performance.now();
    let threads = 0;
    let doneWeight = 0;
    let allWeight = 0;
    let elapsedMs = 0;

    const channel = new Channel<ProveEvent>();
    channel.onmessage = (event) => {
      switch (event.kind) {
        case 'ready':
          threads = event.threads;
          allWeight = totalWeight(event.total, request.inputs ?? 1);
          onProgress({ index: 0, total: event.total, name: '', work: 0, elapsedSeconds: 0, memoryMb: 0, threads });
          break;
        case 'started':
          onProgress({ index: event.index, total: event.total, name: event.name, work: doneWeight / allWeight, elapsedSeconds: elapsedMs / 1000, memoryMb: 0, threads });
          break;
        case 'finished':
          elapsedMs += event.millis;
          doneWeight += weightOf(event.name);
          onProgress({ index: event.index + 1, total: event.total, name: event.name, work: Math.min(1, doneWeight / allWeight), elapsedSeconds: elapsedMs / 1000, memoryMb: event.memoryBytes / 1048576, threads });
          break;
      }
    };

    const running = call<WireOutcome>('prover_prove', {
      witness: toBase64(request.witness),
      network: request.network,
      blockHeight: request.blockHeight,
      threads: request.threads,
      onEvent: channel,
    }).then((wire) => ({
      proofCollection: fromBase64(wire.proofCollection),
      seconds: (performance.now() - started) / 1000,
      memoryMb: wire.memoryBytes / 1048576,
      threads: wire.threads,
    }));

    // Cancelling settles this promise even though the shell may take a
    // moment to notice, so the send flow's `finally` runs at once and the
    // deferred auto-lock is put back.
    return new Promise<ProveOutcome>((resolve, reject) => {
      this.rejectRunning = reject;
      const finish = () => {
        this.rejectRunning = null;
      };
      running.then(
        (outcome) => {
          finish();
          resolve(outcome);
        },
        (e: Error) => {
          finish();
          // The first line only. A VM error prints the machine's state after
          // it, and the state of a proof about spending holds what unlocks
          // the coins; that text would be shown, stored and pasted into bug
          // reports.
          reject(new Error((e.message.split(/\r?\n/)[0] ?? '').slice(0, 300) || 'The prover failed.'));
        },
      );
    });
  }

  cancel(): void {
    const reject = this.rejectRunning;
    this.rejectRunning = null;
    if (!reject) return;
    void call('prover_cancel').catch(() => {});
    reject(new ProofCancelledError());
  }
}
