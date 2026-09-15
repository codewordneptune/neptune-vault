// Main-thread proxy for the wallet worker. Implements WalletCore by posting
// one request per call and resolving on the matching reply.

import type { InputPlan, KeyKind, NextKeyIndices, ScanResult, SendPlan, SendRequest, StoredUtxo, WalletCore, MempoolScan } from './core';
import type { WorkerRequest, WorkerResponse } from './worker';

export class WalletWorkerClient implements WalletCore {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** How long the worker may take to load the wasm core and answer a ping. */
  static readonly START_TIMEOUT_MS = 20_000;

  private get w(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error ?? 'wallet worker failed'));
      };
      worker.onerror = (e) => this.fail(new Error(e.message || 'wallet worker failed'));
      this.worker = worker;
      // A worker whose script the browser blocked never answers and never
      // errors, so every call would hang silently; a ping with a deadline
      // turns that into a visible failure.
      const timer = setTimeout(
        () => this.fail(new Error('The wallet worker did not start. Reload the page; if that does not help, clear the site data in the browser and try again.')),
        WalletWorkerClient.START_TIMEOUT_MS,
      );
      this.call<boolean>('ping').then(() => clearTimeout(timer), () => clearTimeout(timer));
    }
    return this.worker;
  }

  /** Reject everything in flight and drop the worker so the next call retries. */
  private fail(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private call<T>(op: string, args: unknown[] = [], transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    const request: WorkerRequest = { id, op, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.w.postMessage(request, transfer);
    });
  }

  /** Hard lock: drops the worker and every secret it held. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(new Error('wallet locked'));
    this.pending.clear();
  }

  coreVersion() {
    return this.call<string>('coreVersion');
  }
  claimVersion(network: string, blockHeight: number) {
    return this.call<number>('claimVersion', [network, blockHeight]);
  }
  generatePhrase() {
    return this.call<string[]>('generatePhrase');
  }
  deriveKey(password: Uint8Array, salt: Uint8Array, mKib: number, tCost: number, pCost: number) {
    return this.call<Uint8Array>('deriveKey', [password, salt, mKib, tCost, pCost]);
  }
  parseAmount(text: string) {
    return this.call<string>('parseAmount', [text]);
  }
  formatAmount(nau: string) {
    return this.call<string>('formatAmount', [nau]);
  }
  isValidAddress(encoded: string, network: string) {
    return this.call<boolean>('isValidAddress', [encoded, network]);
  }
  unlock(phrase: string[], network: string) {
    return this.call<void>('unlock', [phrase, network]);
  }
  lock() {
    return this.call<void>('lock');
  }
  isUnlocked() {
    return this.call<boolean>('isUnlocked');
  }
  phrase() {
    return this.call<string[]>('phrase');
  }
  address(kind: KeyKind, index: number) {
    return this.call<string>('address', [kind, index]);
  }
  scanBlocks(blocksResponse: string, unspent: StoredUtxo[], nextKeyIndices: NextKeyIndices) {
    return this.call<ScanResult>('scanBlocks', [blocksResponse, unspent, nextKeyIndices]);
  }
  scanMempoolKernel(kernelResponse: string, unspent: StoredUtxo[], nextKeyIndices: NextKeyIndices, tipHeight: number) {
    return this.call<MempoolScan>('scanMempoolKernel', [kernelResponse, unspent, nextKeyIndices, tipHeight]);
  }
  planInputs(unspent: StoredUtxo[], request: SendRequest, nowMs: number) {
    return this.call<InputPlan>('planInputs', [unspent, request, nowMs]);
  }
  buildSend(inputs: StoredUtxo[], snapshotResponse: string, tipHeaderResponse: string, request: SendRequest, nowMs: number) {
    return this.call<SendPlan>('buildSend', [inputs, snapshotResponse, tipHeaderResponse, request, nowMs]);
  }
  mockProofCollection(witness: Uint8Array) {
    return this.call<Uint8Array>('mockProofCollection', [witness]);
  }
  assembleSubmission(kernel: Uint8Array, proofCollection: Uint8Array) {
    return this.call<unknown>('assembleSubmission', [kernel, proofCollection]);
  }
}
