// Main-thread proxy for the wallet worker. Implements WalletCore by posting
// one request per call and resolving on the matching reply.

import type { InputPlan, ScanResult, SendPlan, SendRequest, StoredUtxo, WalletCore } from './core';
import type { WorkerRequest, WorkerResponse } from './worker';

export class WalletWorkerClient implements WalletCore {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error ?? 'wallet worker failed'));
      };
      this.worker.onerror = (e) => {
        for (const entry of this.pending.values()) entry.reject(new Error(e.message));
        this.pending.clear();
      };
    }
    return this.worker;
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
  address(index: number) {
    return this.call<string>('address', [index]);
  }
  scanBlocks(blocks: unknown[], unspent: StoredUtxo[], nextKeyIndex: number) {
    return this.call<ScanResult>('scanBlocks', [blocks, unspent, nextKeyIndex]);
  }
  planInputs(unspent: StoredUtxo[], request: SendRequest, nowMs: number) {
    return this.call<InputPlan>('planInputs', [unspent, request, nowMs]);
  }
  buildSend(inputs: StoredUtxo[], snapshot: unknown, tipHeader: unknown, request: SendRequest, nowMs: number) {
    return this.call<SendPlan>('buildSend', [inputs, snapshot, tipHeader, request, nowMs]);
  }
  mockProofCollection(witness: Uint8Array) {
    return this.call<Uint8Array>('mockProofCollection', [witness]);
  }
  assembleSubmission(kernel: Uint8Array, proofCollection: Uint8Array) {
    return this.call<unknown>('assembleSubmission', [kernel, proofCollection]);
  }
}
