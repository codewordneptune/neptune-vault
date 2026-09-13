import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeClient } from '../node/rpc';
import { openVaultDb, type UtxoRecord, type VaultDb } from '../storage/db';
import type { InputPlan, SendPlan, SendRequest, StoredUtxo, WalletCore } from '../wallet/core';
import { RequiresLustrationError, SendService, type Prover } from './send';

function stored(hash: string, amount: string, height: number): StoredUtxo {
  return { hash, amount_nau: amount, amount, key_kind: 'generation', key_index: 0, release_date_ms: null, confirmed_height: height, confirmed_block: 'b', confirmed_timestamp_ms: 0, recovery: { aocl_index: height } };
}

function row(u: StoredUtxo, extra: Partial<UtxoRecord> = {}): UtxoRecord {
  return { key: `acc:${u.hash}`, accountId: 'acc', hash: u.hash, stored: u, amountNau: u.amount_nau, amount: u.amount, confirmedHeight: u.confirmed_height, confirmedTimestampMs: 0, releaseDateMs: u.release_date_ms, spentHeight: null, spentTxid: null, pendingTxid: null, ...extra };
}

class FakeCore implements Partial<WalletCore> {
  planned: StoredUtxo[] = [];
  lustration = false;
  async planInputs(unspent: StoredUtxo[], _r: SendRequest): Promise<InputPlan> {
    this.planned = unspent;
    return { inputs: unspent, absolute_index_sets: unspent.map((u) => ({ set: u.hash })), total_in_nau: '0' };
  }
  async buildSend(inputs: StoredUtxo[], _s: unknown, _t: unknown, request: SendRequest): Promise<SendPlan> {
    if (this.lustration && !request.accept_lustration) throw new Error('this send requires lustration announcements; confirm to proceed');
    return {
      witness: new Uint8Array([1, 2, 3]),
      kernel: new Uint8Array([4]),
      summary: { txid: 'tx-abc', input_hashes: inputs.map((u) => u.hash), amount_nau: '5', fee_nau: '1', change_nau: null, timestamp_ms: 0, built_against_height: 10, built_against_hash: 'h', requires_lustration: this.lustration },
    };
  }
  async assembleSubmission(kernel: Uint8Array, proof: Uint8Array) {
    return { kernel: [...kernel], proof: [...proof] };
  }
  async mockProofCollection(_witness: Uint8Array) {
    return new Uint8Array([7, 7, 7]);
  }
}

class FakeNode {
  accept = true;
  submitted: unknown[] = [];
  async restoreMembershipProof(sets: unknown[]) {
    return { syncedHeight: 10, syncedHash: 'h', syncedMutatorSet: {}, membershipProofs: sets };
  }
  async tipHeader() {
    return { height: 10, prevBlockDigest: 'p', timestamp: 0, difficulty: '1' };
  }
  async submitTransaction(tx: unknown) {
    this.submitted.push(tx);
    return this.accept;
  }
}

class FakeProver implements Prover {
  fail = false;
  async prove(req: { witness: Uint8Array }, onProgress: (p: never) => void) {
    onProgress({ index: 1, total: 6, name: 'x', elapsedSeconds: 1, memoryMb: 900, threads: 4 } as never);
    if (this.fail) throw new Error('out of memory');
    return { proofCollection: new Uint8Array([9, 9]), seconds: 1, memoryMb: 900, threads: 4, witnessLen: req.witness.length };
  }
}

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

async function setup() {
  db = await openVaultDb();
  await db.put('utxos', row(stored('a', '4', 1)));
  await db.put('utxos', row(stored('b', '3', 2)));
  await db.put('utxos', row(stored('reserved', '9', 3), { pendingTxid: 'older' }));
  await db.put('utxos', row(stored('spent', '9', 4), { spentHeight: 5 }));
  const core = new FakeCore();
  const node = new FakeNode();
  const prover = new FakeProver();
  const service = new SendService(db, node as unknown as NodeClient, core as unknown as WalletCore, prover, 'acc', 'regtest', 4);
  return { core, node, prover, service };
}

const request: SendRequest = { recipient: 'nolgar1x', amount: '5', fee: '1', accept_lustration: false };

describe('send service', () => {
  it('offers only unspent, unreserved inputs', async () => {
    const { service } = await setup();
    expect((await service.spendable()).map((u) => u.hash).sort()).toEqual(['a', 'b']);
  });

  it('runs the whole flow and records a pending send with reserved inputs', async () => {
    const { node, service } = await setup();
    const stages: string[] = [];
    const outcome = await service.send(request, (p) => stages.push(p.stage));
    expect(outcome.txid).toBe('tx-abc');
    expect(stages).toEqual(['planning', 'membership-proofs', 'building', 'proving', 'proving', 'submitting', 'done']);
    expect(node.submitted).toHaveLength(1);
    expect((await db.get('utxos', 'acc:a'))?.pendingTxid).toBe('tx-abc');
    expect((await db.get('utxos', 'acc:b'))?.pendingTxid).toBe('tx-abc');
    const entry = await db.get('history', 'acc:sent:tx-abc');
    expect(entry?.status).toBe('pending');
    expect(entry?.inputHashes).toEqual(['a', 'b']);
    expect(await service.spendable()).toEqual([]);
  });

  it('reserves nothing when proving fails or the node rejects', async () => {
    const { node, prover, service } = await setup();
    prover.fail = true;
    await expect(service.send(request, () => {})).rejects.toThrow('out of memory');
    expect((await db.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    prover.fail = false;
    node.accept = false;
    await expect(service.send(request, () => {})).rejects.toThrow('did not accept');
    expect((await db.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    expect(await db.get('history', 'acc:sent:tx-abc')).toBeUndefined();
  });

  it('surfaces the lustration requirement as its own error', async () => {
    const { core, service } = await setup();
    core.lustration = true;
    await expect(service.send(request, () => {})).rejects.toBeInstanceOf(RequiresLustrationError);
    await expect(service.send({ ...request, accept_lustration: true }, () => {})).resolves.toBeDefined();
  });

  it('uses a mock proof and skips the prover on mock-proof networks', async () => {
    const { node, prover, service: _unused } = await setup();
    prover.fail = true;
    const core = new FakeCore();
    const mockService = new SendService(db, node as unknown as NodeClient, core as unknown as WalletCore, prover, 'acc', 'regtest', 4, true);
    const outcome = await mockService.send(request, () => {});
    expect(outcome.txid).toBe('tx-abc');
    expect(node.submitted[0]).toEqual({ kernel: [4], proof: [7, 7, 7] });
  });

  it('forget releases the inputs of a pending send', async () => {
    const { service } = await setup();
    await service.send(request, () => {});
    await service.forget('tx-abc');
    expect((await db.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    expect((await db.get('history', 'acc:sent:tx-abc'))?.status).toBe('failed');
  });
});
