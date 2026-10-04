import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeError, type NodeClient } from '../node/rpc';
import { openVaultDb, type AccountRecord, type HistoryRecord, type UtxoRecord, type VaultDb } from '../storage/db';
import { CHAIN_PARTS, type InputPlan, type SendPlan, type SendRequest, type StoredUtxo, type WalletCore } from '../backend/types';
import { chainView, testEngine, type TestEngine } from '../backend/engineForTests';
import type { Prover } from '../backend/types';
import { cleanNote, givenUpRivals, removableFrom, RequiresLustrationError, SEND_LIFETIME_MS, SEND_NOTE_MAX, SendCancelledError, SendNotApprovedError, SendService, SendUnconfirmedError, sendStamp } from './send';

function stored(hash: string, amount: string, height: number): StoredUtxo {
  return { hash, amount_nau: amount, amount, key_kind: 'generation', key_index: 0, release_date_ms: null, confirmed_height: height, confirmed_block: 'b', confirmed_timestamp_ms: 0, recovery: { aocl_index: height } };
}

function row(u: StoredUtxo, extra: Partial<UtxoRecord> = {}): UtxoRecord {
  return { key: `acc:${u.hash}`, accountId: 'acc', hash: u.hash, stored: u, amountNau: u.amount_nau, amount: u.amount, confirmedHeight: u.confirmed_height, confirmedTimestampMs: 0, releaseDateMs: u.release_date_ms, spentHeight: null, spentTxid: null, pendingTxid: null, ...extra };
}

/** The core's send building, faked; its ledger is the real engine's, set in setup. */
class FakeCore implements Partial<WalletCore> {
  ledger?: WalletCore['ledger'];
  planned: StoredUtxo[] = [];
  lustration = false;
  /** The output commitments the built kernel reports, in kernel order. */
  commitments: string[] = [];
  /** Pick as the real core does, largest first until amount and fee are covered, rather than everything offered. */
  largestFirst = false;
  async planInputs(unspent: StoredUtxo[], r: SendRequest): Promise<InputPlan> {
    this.planned = unspent;
    let inputs = unspent;
    if (this.largestFirst) {
      const target = r.payments.reduce((sum, p) => sum + BigInt(p.amount_nau ?? '0'), 0n) + BigInt(r.fee_nau ?? '0');
      inputs = [];
      let total = 0n;
      for (const u of [...unspent].sort((a, b) => (BigInt(b.amount_nau) > BigInt(a.amount_nau) ? 1 : -1))) {
        if (total >= target) break;
        total += BigInt(u.amount_nau);
        inputs.push(u);
      }
      if (total < target) throw new Error(`insufficient funds: ${total} available, ${target} needed`);
    }
    return { inputs, absolute_index_sets: inputs.map((u) => ({ set: u.hash })), total_in_nau: '0' };
  }
  async absoluteIndexSets(unspent: StoredUtxo[]): Promise<string> {
    return JSON.stringify(unspent.map((u) => ({ set: u.hash })));
  }
  async buildSend(inputs: StoredUtxo[], _s: string, _t: string, request: SendRequest): Promise<SendPlan> {
    if (this.lustration && !request.accept_lustration) throw new Error('this send requires lustration announcements; confirm to proceed');
    return {
      witness: new Uint8Array([1, 2, 3]),
      kernel: new Uint8Array([4]),
      summary: { txid: 'tx-abc', input_hashes: inputs.map((u) => u.hash), amount_nau: '5', fee_nau: '1', change_nau: null,
      output_commitments: this.commitments, timestamp_ms: 0, built_against_height: 10, built_against_hash: 'h', requires_lustration: this.lustration },
    };
  }
  async assembleSubmission(kernel: Uint8Array, proof: Uint8Array) {
    return { kernel: [...kernel], proof: [...proof] };
  }
  async mockProofCollection(_witness: Uint8Array) {
    return new Uint8Array([7, 7, 7]);
  }
  /** Heights the send flow asked about, in order. */
  askedHeights: number[] = [];
  /**
   * The first delta block. What the real core does: the rule set of the
   * block at a height, and so the claim version its proofs must carry.
   * Every network is past it; a test sets it to see the flow refuse.
   */
  forkHeight = 0;
  async claimVersion(_network: string, blockHeight: number) {
    this.askedHeights.push(blockHeight);
    return blockHeight < this.forkHeight ? 5 : 8;
  }
}

/** How a node's JSON-RPC answer reads when it refuses a transaction that does not fit the chain. */
const NOT_CONFIRMABLE = 'wallet_submitTransaction: Server error ({"SubmitTransaction":"NotConfirmable"})';

class FakeNode {
  accept = true;
  submitted: unknown[] = [];
  /** Heights the next tip reads return, in order; the last one repeats. */
  heights: number[] = [10];
  /** Thrown by the next submission, once. */
  submitError: string | null = null;
  /** How many submissions in a row the node refuses as not confirmable. */
  refusals = 0;
  /** The next submission reaches the node, which takes it, and the answer is lost on the way back. */
  loseAnswer = false;
  /** The next submission reaches the node, and this comes back instead of its answer. */
  failWith: Error | null = null;
  /** What the wallet had written down at the moment the node was handed the transaction. */
  heldAtSubmit: (string | null | undefined)[] = [];
  beforeSubmit: (() => Promise<void>) | null = null;
  async restoreMembershipProofRaw(sets: unknown[]) {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { snapshot: { syncedHeight: 10, syncedHash: 'h', syncedMutatorSet: {}, membershipProofs: sets } } });
  }
  /** The newest block's time; 0 is a node that does not say. */
  tipTime = 0;
  async tipHeader() {
    return { height: this.heights[0], prevBlockDigest: 'p', timestamp: this.tipTime, difficulty: '1' };
  }
  async tipHeaderRaw() {
    const height = this.heights.length > 1 ? (this.heights.shift() as number) : this.heights[0];
    return { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { header: { height, prevBlockDigest: 'p', timestamp: this.tipTime, difficulty: '1' } } }), height, timestampMs: this.tipTime || null };
  }
  async submitTransaction(tx: unknown) {
    if (this.beforeSubmit) await this.beforeSubmit();
    if (this.loseAnswer) {
      this.loseAnswer = false;
      this.submitted.push(tx);
      throw new NodeError('No answer from the node within 120 s', 'timeout', 'wallet_submitTransaction');
    }
    if (this.submitError) {
      const message = this.submitError;
      this.submitError = null;
      throw new NodeError(message, -32000, 'wallet_submitTransaction');
    }
    if (this.failWith) {
      const e = this.failWith;
      this.failWith = null;
      this.submitted.push(tx);
      throw e;
    }
    if (this.refusals > 0) {
      this.refusals -= 1;
      throw new NodeError(NOT_CONFIRMABLE, -32000, 'wallet_submitTransaction');
    }
    this.submitted.push(tx);
    return this.accept;
  }
}

class FakeProver implements Prover {
  cancelled = 0;
  cancel() {
    this.cancelled += 1;
  }
  defaultThreads() {
    return 4;
  }
  fail = false;
  calls = 0;
  /** What the last proof was asked to prove, for the tests about the rules. */
  last: { blockHeight?: number } | null = null;
  /** Runs while the proof is "being made": where a test presses Cancel. */
  during: (() => void) | null = null;
  async prove(req: { witness: Uint8Array; blockHeight?: number }, onProgress: (p: never) => void) {
    this.calls += 1;
    this.last = { blockHeight: req.blockHeight };
    this.during?.();
    onProgress({ index: 1, total: 6, name: 'x', elapsedSeconds: 1, memoryMb: 900, threads: 4 } as never);
    if (this.fail) throw new Error('out of memory');
    return { proofCollection: new Uint8Array([9, 9]), seconds: 1, memoryMb: 900, threads: 4, witnessLen: req.witness.length };
  }
}

const account: AccountRecord = {
  id: 'acc',
  network: 'regtest',
  createdAt: 0,
  birthdayHeight: 1,
  envelope: { version: 1, kdf: { name: 'argon2id', mKib: 8, tCost: 1, pCost: 1, salt: 'A' }, wrappedContentKey: { iv: 'A', ciphertext: 'A' }, seed: { iv: 'A', ciphertext: 'A' } },
  address0: 'x',
  nextKeyIndices: { generation: 1, ec_hybrid: 0, viewing: 0 },
  backupConfirmed: true,
};

let db: VaultDb;
let vault: TestEngine;
let view: ReturnType<typeof chainView>;
afterEach(() => {
  vault?.close();
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

async function setup() {
  db = await openVaultDb();
  await db.put('accounts', account);
  vault = await testEngine();
  vault.unlock();
  await vault.store.storeOpen('acc');
  await vault.store.storeMigrate('acc', CHAIN_PARTS, { accounts: [account] });
  view = chainView(vault, db, 'acc');
  await view.put('utxos', row(stored('a', '4', 1)));
  await view.put('utxos', row(stored('b', '3', 2)));
  await view.put('utxos', row(stored('reserved', '9', 3), { pendingTxid: 'older' }));
  await view.put('utxos', row(stored('spent', '9', 4), { spentHeight: 5 }));
  const core = new FakeCore();
  core.ledger = vault.store.ledger;
  const node = new FakeNode();
  const prover = new FakeProver();
  const service = new SendService(node as unknown as NodeClient, core as unknown as WalletCore, prover, 'acc', 'regtest', 4);
  return { core, node, prover, service };
}

const request: SendRequest = { payments: [{ recipient: 'nolgar1x', amount: '5', amount_nau: '5' }], fee: '1', accept_lustration: false };

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
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBe('tx-abc');
    expect((await view.get('utxos', 'acc:b'))?.pendingTxid).toBe('tx-abc');
    const entry = await view.get('history', 'acc:sent:tx-abc');
    expect(entry?.status).toBe('pending');
    expect(entry?.inputHashes).toEqual(['a', 'b']);
    expect(await service.spendable()).toEqual([]);
  });

  it('records every payment of a send to several, and which output is whose', async () => {
    const { core, service } = await setup();
    core.commitments = ['c-a', 'c-b', 'c-change'];
    const several: SendRequest = {
      payments: [
        { recipient: 'nolgar1a', amount: '2', amount_nau: '2' },
        { recipient: 'nolgar1b', amount: '3', amount_nau: '3' },
      ],
      fee: '1',
      accept_lustration: false,
    };
    await service.send(several, () => {});
    const entry = await view.get('history', 'acc:sent:tx-abc');
    expect(entry?.recipient).toBe('nolgar1a');
    expect(entry?.payments).toEqual([
      { recipient: 'nolgar1a', amountNau: '2' },
      { recipient: 'nolgar1b', amountNau: '3' },
    ]);
    expect(entry?.outputs).toEqual([
      { commitment: 'c-a', role: 'recipient' },
      { commitment: 'c-b', role: 'recipient' },
      { commitment: 'c-change', role: 'change' },
    ]);
  });

  it('writes the send down and holds its coins before the node hears of it', async () => {
    const { node, service } = await setup();
    node.beforeSubmit = async () => {
      node.heldAtSubmit = [(await view.get('utxos', 'acc:a'))?.pendingTxid, (await view.get('history', 'acc:sent:tx-abc'))?.status];
    };
    await service.send(request, () => {});
    expect(node.heldAtSubmit).toEqual(['tx-abc', 'pending']);
  });

  it('keeps a send whose answer was lost as pending, so nobody pays twice', async () => {
    const { node, service } = await setup();
    node.loseAnswer = true;
    await expect(service.send(request, () => {})).rejects.toBeInstanceOf(SendUnconfirmedError);
    // The node has it; the wallet still holds the coins and shows the send.
    expect(node.submitted).toHaveLength(1);
    expect((await view.get('history', 'acc:sent:tx-abc'))?.status).toBe('pending');
    expect(await service.spendable()).toEqual([]);
    // Giving up on it later frees them, as for any pending send.
    await service.forget('tx-abc');
    expect((await service.spendable()).map((u) => u.hash).sort()).toEqual(['a', 'b']);
  });

  it('treats a server error or an unreadable answer on submission as no answer: the coins stay held', async () => {
    for (const failure of [
      new NodeError('The node at x is not answering properly (HTTP 504). Try again in a moment.', 'http', 'wallet_submitTransaction', 504),
      new NodeError('x answered, but not as a Neptune node.', 'garbled', 'wallet_submitTransaction'),
      new TypeError('Failed to parse'),
    ]) {
      const { node, service } = await setup();
      node.failWith = failure;
      const error = (await service.send(request, () => {}).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(SendUnconfirmedError);
      expect(error.message).toMatch(/Before you send it again, wait until History shows it as Sent or Not sent\.$/);
      if (failure instanceof NodeError && failure.code === 'http') expect(error.message).toMatch(/^The node's server answered with an error \(HTTP 504\)/);
      expect((await view.get('history', 'acc:sent:tx-abc'))?.status).toBe('pending');
      expect(await service.spendable()).toEqual([]);
      vault.close();
      db.close();
      indexedDB.deleteDatabase('neptune-vault');
    }
  });

  it('keeps a send whose answer does not say whether the node took it', async () => {
    const { node, service } = await setup();
    node.accept = undefined as unknown as boolean;
    (node as unknown as { submitTransaction: () => Promise<boolean | null> }).submitTransaction = async () => null;
    await expect(service.send(request, () => {})).rejects.toBeInstanceOf(SendUnconfirmedError);
    expect((await view.get('history', 'acc:sent:tx-abc'))?.status).toBe('pending');
  });

  it('says in words what a refusal for the date means, and holds nothing', async () => {
    const { node, service } = await setup();
    node.submitError = 'The node answered with an error: "Server error" ({"SubmitTransaction":"FutureDated"})';
    await expect(service.send(request, () => {})).rejects.toThrow(/dated in the future/);
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
  });

  it('stops before proving when the device clock is far behind the chain', async () => {
    const { node, prover, service } = await setup();
    node.tipTime = Date.now() + 11 * 60 * 60 * 1000;
    await expect(service.send(request, () => {})).rejects.toThrow(/this device's clock is 11 hours behind the network/);
    expect(prover.calls).toBe(0);
  });

  it('waits for the person\'s confirmation before the node hears of the send, and sends nothing without it', async () => {
    const { node, service } = await setup();
    await expect(service.send(request, () => {}, { approved: Promise.resolve(false) })).rejects.toBeInstanceOf(SendNotApprovedError);
    expect(node.submitted).toHaveLength(0);
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
    expect((await service.spendable()).map((u) => u.hash).sort()).toEqual(['a', 'b']);

    const recorded: string[] = [];
    let heldWhenRecorded: string | null | undefined;
    const outcome = await service.send(request, () => {}, {
      approved: Promise.resolve(true),
      onRecorded: async (txid) => {
        recorded.push(txid);
        heldWhenRecorded = (await view.get('utxos', 'acc:a'))?.pendingTxid;
        expect(node.submitted).toHaveLength(0);
      },
    });
    expect(outcome.txid).toBe('tx-abc');
    expect(recorded).toEqual(['tx-abc']);
    expect(heldWhenRecorded).toBe('tx-abc');
  });

  it('cancel during the proof sends nothing and holds nothing', async () => {
    const { node, prover, service } = await setup();
    const abort = new AbortController();
    prover.during = () => abort.abort();
    await expect(service.send(request, () => {}, { signal: abort.signal })).rejects.toBeInstanceOf(SendCancelledError);
    expect(node.submitted).toHaveLength(0);
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
    expect((await service.spendable()).map((u) => u.hash).sort()).toEqual(['a', 'b']);
  });

  it('cancel after the transaction was handed over is not honoured: the send goes through and says so', async () => {
    const { node, service } = await setup();
    const abort = new AbortController();
    node.beforeSubmit = async () => abort.abort();
    const outcome = await service.send(request, () => {}, { signal: abort.signal });
    expect(outcome.txid).toBe('tx-abc');
    expect((await view.get('history', 'acc:sent:tx-abc'))?.status).toBe('pending');
  });

  it('reserves nothing when proving fails or the node rejects', async () => {
    const { node, prover, service } = await setup();
    prover.fail = true;
    await expect(service.send(request, () => {})).rejects.toThrow('out of memory');
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    prover.fail = false;
    node.accept = false;
    await expect(service.send(request, () => {})).rejects.toThrow('did not accept');
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
  });

  // A node takes a transaction built against one of the tip's recent
  // ancestors (neptune-core 0.18 and later), so a proof finished after a
  // new block is offered as it is.
  it('offers a proof made before a new block to the node, and proves once when the node takes it', async () => {
    const { node, prover, service } = await setup();
    // Reads: build (10); the tip is 12 by the time the proof is done.
    node.heights = [10, 12];
    const outcome = await service.send(request, () => {});
    expect(outcome.txid).toBe('tx-abc');
    expect(prover.calls).toBe(1);
    expect(node.submitted).toHaveLength(1);
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBe('tx-abc');
  });

  it('proves again when the node refuses a proof made before new blocks, then sends', async () => {
    const { node, prover, service } = await setup();
    node.refusals = 1;
    // Reads: build (10), check after the refusal (14), build again (14).
    node.heights = [10, 14, 14];
    const notes: string[] = [];
    const outcome = await service.send(request, (p) => {
      if (p.note) notes.push(p.note);
    });
    expect(outcome.txid).toBe('tx-abc');
    expect(prover.calls).toBe(2);
    expect(node.submitted).toHaveLength(1);
    expect(notes[0]).toMatch(/A new block arrived, so the proof is being made again \(attempt 2 of 3\)\. Nothing has been sent yet\./);
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBe('tx-abc');
  });

  it('gives up after three proofs the node refuses as blocks keep arriving, holding nothing', async () => {
    const { node, prover, service } = await setup();
    node.refusals = 3;
    // Each attempt: build, then a check after the refusal that finds a newer tip.
    node.heights = [10, 11, 11, 12, 12, 13];
    await expect(service.send(request, () => {})).rejects.toThrow(/Nothing was sent: new blocks kept arriving/);
    expect(prover.calls).toBe(3);
    expect(node.submitted).toHaveLength(0);
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
  });

  it('names a spent coin when the node refuses and the tip has not moved', async () => {
    const { node, prover, service } = await setup();
    node.submitError = NOT_CONFIRMABLE;
    await expect(service.send(request, () => {})).rejects.toThrow(/Nothing was sent: the node says one of the coins is already spent/);
    expect(prover.calls).toBe(1);
    expect(node.submitted).toHaveLength(0);
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
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
    core.ledger = vault.store.ledger;
    const mockService = new SendService(node as unknown as NodeClient, core as unknown as WalletCore, prover, 'acc', 'regtest', 4, true);
    const outcome = await mockService.send(request, () => {});
    expect(outcome.txid).toBe('tx-abc');
    expect(node.submitted[0]).toEqual({ kernel: [4], proof: [7, 7, 7] });
  });

  // A transaction cannot be mined into the tip. The earliest block that can
  // carry it is the next one, so it is that block's rules it has to satisfy,
  // and at the fork the two differ.
  it('proves for the block the transaction can be mined into, not for the tip', async () => {
    const { core, node, prover, service } = await setup();
    core.forkHeight = 55000;
    node.heights = [54999];
    await service.send(request, () => {});
    expect(core.askedHeights).toEqual([55000]);
    expect(prover.last).toEqual({ blockHeight: 55000 });
  });

  // Every network is past the delta fork. A chain that still asked for the
  // older proofs is one this build cannot serve, and it says so before
  // proving anything or holding any coin.
  it('refuses to prove under rules older than the delta fork', async () => {
    const { core, node, prover, service } = await setup();
    core.forkHeight = 55000;
    node.heights = [54000];
    await expect(service.send(request, () => {})).rejects.toThrow(/cannot send under the network's current rules/);
    expect(core.askedHeights).toEqual([54001]);
    expect(prover.calls).toBe(0);
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
  });

  it('proves under one rule set: the prover is given the height the version was chosen for', async () => {
    const { core, node, prover, service } = await setup();
    node.heights = [54999];
    await service.send(request, () => {});
    expect(prover.last?.blockHeight).toBe(core.askedHeights[0]);
  });

  it('spends a coin of a send given up on that may still pay the same person, alone when it is enough', async () => {
    const { core, node, service } = await setup();
    core.largestFirst = true;
    // Free coins a (4) and b (3); a send given up on spent b.
    const rival = { key: 'acc:sent:old', accountId: 'acc', kind: 'sent', status: 'failed', givenUp: true, txid: 'old', amountNau: '1', feeNau: '1', timestampMs: Date.now(), height: null, inputHashes: ['b'], recipient: 'nolgar1x', error: null, changeNau: null } as HistoryRecord;
    const small: SendRequest = { payments: [{ recipient: 'nolgar1x', amount: '2', amount_nau: '2' }], fee: '1', fee_nau: '1', accept_lustration: false };
    // On its own the core takes a (4) for 3; b (3) is enough by itself, so b goes alone.
    await service.send(small, () => {}, { rivals: [rival] });
    const [submitted] = node.submitted as { kernel: number[] }[];
    expect(submitted).toBeDefined();
    expect((await view.get('history', 'acc:sent:tx-abc'))?.inputHashes).toEqual(['b']);
  });

  it('adds the coin of a send given up on when it is not enough by itself', async () => {
    const { core, service } = await setup();
    core.largestFirst = true;
    await view.put('utxos', row(stored('c', '1', 6)));
    const rival = { key: 'acc:sent:old', accountId: 'acc', kind: 'sent', status: 'failed', givenUp: true, txid: 'old', amountNau: '0.5', feeNau: '0.5', timestampMs: Date.now(), height: null, inputHashes: ['c'], recipient: 'nolgar1x', error: null, changeNau: null } as HistoryRecord;
    const three: SendRequest = { payments: [{ recipient: 'nolgar1x', amount: '2', amount_nau: '2' }], fee: '1', fee_nau: '1', accept_lustration: false };
    await service.send(three, () => {}, { rivals: [rival] });
    expect((await view.get('history', 'acc:sent:tx-abc'))?.inputHashes).toEqual(['a', 'c']);
  });

  it('forget releases the inputs of a pending send', async () => {
    const { service } = await setup();
    await service.send(request, () => {});
    await service.forget('tx-abc');
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
    expect((await view.get('history', 'acc:sent:tx-abc'))?.status).toBe('failed');
  });

  it('removes a send given up on from History only once it can no longer go through', async () => {
    const { service } = await setup();
    await service.send(request, () => {});
    const pending = (await view.get('history', 'acc:sent:tx-abc')) as HistoryRecord;
    await expect(service.remove(pending)).rejects.toThrow(/may still go through/);
    await service.forget('tx-abc');
    const given = (await view.get('history', 'acc:sent:tx-abc')) as HistoryRecord;
    const from = removableFrom(given) as number;
    await expect(service.remove(given, from - 1)).rejects.toThrow(/may still go through/);
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeDefined();
    await service.remove(given, from);
    expect(await view.get('history', 'acc:sent:tx-abc')).toBeUndefined();
    expect((await view.get('utxos', 'acc:a'))?.pendingTxid).toBeNull();
  });
});

describe('a send that was not sent', () => {
  const base = { accountId: 'acc', key: 'k', txid: 't', kind: 'sent', status: 'failed', amountNau: '1', feeNau: '1', timestampMs: 1_000, height: null, inputHashes: ['a'], recipient: 'nolgar1bob', error: null, changeNau: null } as HistoryRecord;
  it('may leave History once no block can take it', () => {
    expect(removableFrom(base)).toBe(1_000 + SEND_LIFETIME_MS);
    expect(removableFrom({ ...base, givenUp: true, stampMs: 900 })).toBe(900 + SEND_LIFETIME_MS);
    expect(removableFrom({ ...base, expired: true })).toBe(0);
  });
  it('is the only row that may', () => {
    expect(removableFrom({ ...base, status: 'pending' })).toBeNull();
    expect(removableFrom({ ...base, status: 'confirmed' })).toBeNull();
    expect(removableFrom({ ...base, kind: 'received' })).toBeNull();
  });
});

describe('the time a send is stamped with', () => {
  it('is never later than the newest block, and a clock too far behind for any stamp is caught', () => {
    expect(sendStamp(1000, null)).toEqual({ stampMs: 1000, clockProblem: null });
    expect(sendStamp(1000, 900).stampMs).toBe(900);
    expect(sendStamp(1000, 5000).stampMs).toBe(1000);
    expect(sendStamp(0, 9 * 3600_000).clockProblem).toBeNull();
    expect(sendStamp(0, 10 * 3600_000).clockProblem).toMatch(/10 hours behind the network/);
    expect(sendStamp(0, 3 * 86400_000).clockProblem).toMatch(/3 days behind the network/);
  });
});

describe('a note to self on a send', () => {
  it('is kept as one clean line, cut to length', () => {
    expect(cleanNote('  Rent,   September  ')).toBe('Rent, September');
    // A character that could reorder the text around it, and a line break, become spaces.
    expect(cleanNote('Pay\u202eBob')).toBe('Pay Bob');
    expect(cleanNote('a\nb')).toBe('a b');
    expect(cleanNote('x'.repeat(SEND_NOTE_MAX + 20))).toHaveLength(SEND_NOTE_MAX);
    expect(cleanNote('   ')).toBe('');
  });
});

describe('sends given up on that may still pay', () => {
  const base = { accountId: 'acc', kind: 'sent', status: 'failed', givenUp: true, amountNau: '1', feeNau: '1', height: null, recipient: 'nolgar1bob', error: null, changeNau: null };
  it('are those to the same person, with coins still free, that a block can still take', () => {
    const now = Date.now();
    const rows = [
      { ...base, key: 'k1', txid: 't1', timestampMs: now - 1000, inputHashes: ['a'] },
      { ...base, key: 'k2', txid: 't2', timestampMs: now - 1000, inputHashes: ['b'], recipient: 'nolgar1carol' },
      { ...base, key: 'k3', txid: 't3', timestampMs: now - 1000, inputHashes: ['spent'] },
      { ...base, key: 'k4', txid: 't4', timestampMs: now - SEND_LIFETIME_MS - 1, inputHashes: ['a'] },
      { ...base, key: 'k5', txid: 't5', timestampMs: now - 1000, inputHashes: ['a'], expired: true },
      { ...base, key: 'k6', txid: 't6', timestampMs: now - 1000, inputHashes: ['a'], givenUp: false },
      { ...base, key: 'k7', txid: 't7', timestampMs: now - 1000, inputHashes: ['b'], recipient: null, payments: [{ recipient: 'nolgar1carol', amountNau: '1' }, { recipient: 'nolgar1bob', amountNau: '1' }] },
    ] as HistoryRecord[];
    expect(givenUpRivals(rows, new Set(['a', 'b']), [' NOLGAR1BOB '], now).map((h) => h.txid)).toEqual(['t1', 't7']);
  });
});
