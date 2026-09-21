import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProofCancelledError } from '../proving';
import { ProverClient } from './proverClient';

class FailingWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage() {
    queueMicrotask(() => this.onmessage?.({ data: { kind: 'error', message: 'VM error: assertion failed at 1234\nop stack: [secret, words, here]\nram: 0xdeadbeef' } }));
  }
  terminate() {}
}

class SilentWorker {
  static made: SilentWorker[] = [];
  terminated = false;
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor() {
    SilentWorker.made.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  SilentWorker.made = [];
});

describe('prover client', () => {
  it('keeps the first line of a prover error and none of the machine state printed after it', async () => {
    vi.stubGlobal('Worker', FailingWorker);
    const failure = (await new ProverClient().prove({ witness: new Uint8Array([1]), network: 'regtest', blockHeight: 1, threads: 0 }, () => {}).catch((e) => e)) as Error;
    expect(failure.message).toBe('VM error: assertion failed at 1234');
  });

  it('cancel settles the running proof, so whatever waits on it can clean up', async () => {
    vi.stubGlobal('Worker', SilentWorker);
    const client = new ProverClient();
    const proof = client.prove({ witness: new Uint8Array([1]), network: 'regtest', blockHeight: 1, threads: 0 }, () => {});
    client.cancel();
    await expect(proof).rejects.toBeInstanceOf(ProofCancelledError);
    expect(SilentWorker.made[0].terminated).toBe(true);
    // And the client is free for the next proof.
    const next = client.prove({ witness: new Uint8Array([1]), network: 'regtest', blockHeight: 1, threads: 0 }, () => {});
    client.cancel();
    await expect(next).rejects.toBeInstanceOf(ProofCancelledError);
  });
});
