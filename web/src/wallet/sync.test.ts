import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeClient, RpcBlockHeader, RpcWalletBlock } from '../node/rpc';
import { openVaultDb, type AccountRecord, type VaultDb } from '../storage/db';
import { NOT_LINKED, type NextKeyIndices, type ScanExpectation, type ScanResult, type StoredUtxo, type WalletCore } from './core';
import { SyncEngine } from './sync';

// A chain the fake node serves and a fake core that "finds" what we tell it.

function utxo(hash: string, height: number, amount: string, own: number | null = null): StoredUtxo {
  return {
    hash,
    own_build_height: own,
    amount_nau: `${amount}000000000000000000000000000000`,
    amount,
    key_kind: 'generation',
    key_index: 0,
    release_date_ms: null,
    confirmed_height: height,
    confirmed_block: `hash-${height}`,
    confirmed_timestamp_ms: height * 1000,
    recovery: { aocl_index: height },
  };
}

class FakeNode {
  tip = 0;
  canonical = new Set<string>();
  getBlocksCalls: Array<[number, number]> = [];
  /** The coin index: heights flagged for this wallet, and spend heights per coin hash. */
  flagHeights: number[] = [];
  /** Answers to successive flag questions, for a wallet whose later keys only come into view round by round. */
  flagRounds: number[][] = [];
  canonicalQuestions = 0;
  spendHeights = new Map<string, number[]>();
  noIndex = false;
  networkName: string | null = 'regtest';
  /** Answer "canonical" this many times whatever is asked: a reorganisation that lands just after the check. */
  staleCanonicalAnswers = 0;
  async network() {
    return this.networkName;
  }
  async tipDigest() {
    return this.hashAt(this.tip);
  }
  async blockHeightsByFlags(_flagsJson: string): Promise<number[]> {
    if (this.noIndex) throw new Error("utxoindex_blockHeightsByFlags: Method not found");
    if (this.flagRounds.length > 0) this.flagHeights = this.flagRounds.shift() as number[];
    return [...this.flagHeights];
  }
  async blockHeightsBySpends(indexSetsJson: string): Promise<number[]> {
    const hashes = JSON.parse(indexSetsJson) as string[];
    return hashes.flatMap((h) => this.spendHeights.get(h) ?? []);
  }
  extendTo(height: number) {
    for (let h = this.tip + 1; h <= height; h++) this.canonical.add(`hash-${h}`);
    this.tip = height;
  }
  /** Replace blocks above `height` with a fork whose hashes differ. */
  forkAbove(height: number, newTip: number) {
    for (let h = height + 1; h <= this.tip; h++) this.canonical.delete(`hash-${h}`);
    for (let h = height + 1; h <= newTip; h++) this.canonical.add(`fork-${h}`);
    this.tip = newTip;
  }
  hashAt(h: number) {
    return this.canonical.has(`hash-${h}`) ? `hash-${h}` : `fork-${h}`;
  }
  async tipHeader(): Promise<RpcBlockHeader> {
    return { height: this.tip, prevBlockDigest: this.hashAt(this.tip - 1), timestamp: this.tip * 1000, difficulty: '1' };
  }
  async isBlockCanonical(digest: string) {
    this.canonicalQuestions += 1;
    if (this.staleCanonicalAnswers > 0) {
      this.staleCanonicalAnswers -= 1;
      return true;
    }
    return this.canonical.has(digest);
  }
  async getBlocksRaw(from: number, to: number): Promise<string> {
    this.getBlocksCalls.push([from, to]);
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { blocks: await this.getBlocks(from, to) } });
  }

  async getBlocks(from: number, to: number): Promise<RpcWalletBlock[]> {
    const blocks: RpcWalletBlock[] = [];
    for (let h = from; h <= Math.min(to, this.tip); h++) {
      blocks.push({ kernel: { header: { height: h, prevBlockDigest: this.hashAt(h - 1), timestamp: h * 1000, difficulty: '1' }, body: {}, appendix: [] }, proofLeaf: this.hashAt(h) });
    }
    return blocks;
  }
}

class FakeCore implements Partial<WalletCore> {
  /** height -> incoming utxos, and height -> spent hashes, scripted by tests. */
  incoming = new Map<number, StoredUtxo[]>();
  spent = new Map<number, string[]>();
  /** height -> output commitments the block carries. */
  outputs = new Map<number, string[]>();
  expectations: ScanExpectation[] = [];
  nextKeyIndexAfter = 1;
  async announcementFlags() {
    return "[]";
  }
  async absoluteIndexSets(unspent: StoredUtxo[]) {
    return JSON.stringify(unspent.map((u) => u.hash));
  }
  async scanBlocks(blocksResponse: string, _unspent: StoredUtxo[], _next: NextKeyIndices, expectation: ScanExpectation): Promise<ScanResult> {
    const blocks = (JSON.parse(blocksResponse) as { result: { blocks: unknown[] } }).result.blocks;
    this.expectations.push(expectation);
    // The real core's checks, as far as the engine depends on them.
    const first = (blocks as RpcWalletBlock[])[0];
    if (first && first.kernel.header.height !== expectation.from) throw new Error('chain check: wrong height');
    if (first && expectation.prev_hash !== null && first.kernel.header.prevBlockDigest !== expectation.prev_hash) throw new Error(`${NOT_LINKED}: block ${expectation.from}`);
    const out = (blocks as RpcWalletBlock[]).map((b) => ({
      height: b.kernel.header.height,
      hash: b.proofLeaf,
      prev_hash: b.kernel.header.prevBlockDigest,
      timestamp_ms: b.kernel.header.timestamp,
      incoming: this.incoming.get(b.kernel.header.height) ?? [],
      spent: this.spent.get(b.kernel.header.height) ?? [],
      seen: (this.outputs.get(b.kernel.header.height) ?? []).filter((c) => expectation.watch.includes(c)),
    }));
    return { blocks: out, next_key_indices: { generation: this.nextKeyIndexAfter, ec_hybrid: 0, viewing: 0 } };
  }
}

const account: AccountRecord = {
  id: 'acc',
  network: 'regtest',
  createdAt: 0,
  birthdayHeight: 3,
  envelope: { version: 1, kdf: { name: 'argon2id', mKib: 8, tCost: 1, pCost: 1, salt: 'A' }, wrappedContentKey: { iv: 'A', ciphertext: 'A' }, seed: { iv: 'A', ciphertext: 'A' } },
  address0: 'x',
  nextKeyIndices: { generation: 1, ec_hybrid: 0, viewing: 0 },
  backupConfirmed: true,
};

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

async function setup() {
  db = await openVaultDb();
  await db.put('accounts', account);
  const node = new FakeNode();
  const core = new FakeCore();
  const engine = new SyncEngine(db, node as unknown as NodeClient, core as unknown as WalletCore, 'acc', { batchSize: 4, keepBlocks: 100 });
  return { node, core, engine };
}

describe('sync engine', () => {
  it('scans from the birthday in batches and records incoming funds', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(10);
    core.incoming.set(5, [utxo('u1', 5, '2')]);
    core.nextKeyIndexAfter = 2;

    const result = await engine.syncOnce();
    expect(result.phase).toBe('done');
    expect(result.syncedHeight).toBe(10);
    expect(node.getBlocksCalls).toEqual([[3, 6], [7, 10]]);
    const utxos = await db.getAllFromIndex('utxos', 'byAccount', 'acc');
    expect(utxos).toHaveLength(1);
    expect(utxos[0].amount).toBe('2');
    expect(utxos[0].spentHeight).toBeNull();
    const history = await db.getAllFromIndex('history', 'byAccount', 'acc');
    expect(history.map((h) => [h.kind, h.status, h.height])).toEqual([['received', 'confirmed', 5]]);
    expect((await db.get('accounts', 'acc'))?.nextKeyIndices).toEqual({ generation: 2, ec_hybrid: 0, viewing: 0 });
    expect((await db.get('syncState', 'acc'))?.syncedHash).toBe('hash-10');
  });

  it('marks spends and confirms the pending send that reserved the input', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(6);
    core.incoming.set(4, [utxo('u1', 4, '5')]);
    await engine.syncOnce();

    // The app reserved u1 for a pending send.
    const u = (await db.get('utxos', 'acc:u1'))!;
    await db.put('utxos', { ...u, pendingTxid: 'tx-1' });
    await db.put('history', { key: 'acc:sent:tx-1', accountId: 'acc', kind: 'sent', status: 'pending', txid: 'tx-1', amountNau: '1', feeNau: '0', timestampMs: 0, height: null, inputHashes: ['u1'], recipient: 'r', error: null });

    node.extendTo(8);
    core.spent.set(8, ['u1']);
    await engine.syncOnce();
    const spent = (await db.get('utxos', 'acc:u1'))!;
    expect(spent.spentHeight).toBe(8);
    expect(spent.spentTxid).toBe('tx-1');
    const sent = (await db.get('history', 'acc:sent:tx-1'))!;
    expect(sent.status).toBe('confirmed');
    expect(sent.height).toBe(8);
  });

  it('confirms a send by its own outputs, and fails it when its coins were spent by another transaction', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(6);
    core.incoming.set(4, [utxo('u1', 4, '5'), utxo('u2', 4, '3'), utxo('u3', 4, '2')]);
    await engine.syncOnce();
    const reserve = async (hash: string, txid: string) => db.put('utxos', { ...(await db.get('utxos', `acc:${hash}`))!, pendingTxid: txid });
    const pending = (txid: string, inputs: string[], commitment: string) =>
      db.put('history', { key: `acc:sent:${txid}`, accountId: 'acc', kind: 'sent', status: 'pending', txid, amountNau: '1', feeNau: '0', timestampMs: 0, height: null, inputHashes: inputs, recipient: 'r', error: null, outputs: [{ commitment, role: 'recipient' }] });
    await reserve('u1', 'tx-mine');
    await pending('tx-mine', ['u1'], 'out-mine');
    await reserve('u2', 'tx-lost');
    await reserve('u3', 'tx-lost');
    await pending('tx-lost', ['u2', 'u3'], 'out-lost');

    // Block 8 spends u1 and u2. It carries tx-mine's output; u2 went to a
    // transaction from another device, so tx-lost never happened.
    node.extendTo(8);
    core.spent.set(8, ['u1', 'u2']);
    core.outputs.set(8, ['out-mine', 'someone-else']);
    await engine.syncOnce();
    expect(core.expectations.at(-1)?.watch.sort()).toEqual(['out-lost', 'out-mine']);

    expect((await db.get('history', 'acc:sent:tx-mine'))?.status).toBe('confirmed');
    const lost = (await db.get('history', 'acc:sent:tx-lost'))!;
    expect(lost.status).toBe('failed');
    expect(lost.error).toMatch(/spent by another transaction/);
    // The coin it lost is spent, by nobody this device knows; the other is free again.
    expect(await db.get('utxos', 'acc:u2')).toMatchObject({ spentHeight: 8, spentTxid: null, pendingTxid: null });
    expect(await db.get('utxos', 'acc:u3')).toMatchObject({ spentHeight: null, pendingTxid: null });
    // And the spend shows as one made elsewhere.
    expect((await db.get('history', 'acc:spent:8'))?.inputHashes).toEqual(['u2']);
  });

  it('refuses a node on another network before touching anything', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(6);
    core.incoming.set(4, [utxo('u1', 4, '5')]);
    await engine.syncOnce();
    const other = new FakeNode();
    other.networkName = 'main';
    other.extendTo(2);
    const wrong = new SyncEngine(db, other as unknown as NodeClient, core as unknown as WalletCore, 'acc', { batchSize: 4, keepBlocks: 100 });
    const result = await wrong.syncOnce();
    expect(result.phase).toBe('error');
    expect(result.message).toMatch(/runs the main network/);
    expect(await db.get('utxos', 'acc:u1')).toBeDefined();
    expect((await db.get('accounts', 'acc'))?.birthdayHeight).toBe(3);
  });

  it('rolls back when the next block does not follow the last one scanned, though the node called it canonical', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(8);
    core.incoming.set(7, [utxo('orphaned', 7, '1')]);
    await engine.syncOnce();

    // The reorganisation lands between the canonical check and the fetch.
    node.forkAbove(6, 10);
    node.staleCanonicalAnswers = 1;
    core.incoming.clear();
    const result = await engine.syncOnce();
    expect(result.phase).toBe('done');
    expect(result.syncedHeight).toBe(10);
    expect(await db.get('utxos', 'acc:orphaned')).toBeUndefined();
    const blocks = await db.getAllFromIndex('blocks', 'byAccountHeight', IDBKeyRange.bound(['acc', 0], ['acc', Infinity]));
    expect(blocks.map((b) => b.hash)).toEqual(['hash-3', 'hash-4', 'hash-5', 'hash-6', 'fork-7', 'fork-8', 'fork-9', 'fork-10']);
  });

  it('records a spend made elsewhere as a send, with what came back as change', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(6);
    core.incoming.set(4, [utxo('u1', 4, '5')]);
    await engine.syncOnce();

    node.extendTo(8);
    core.spent.set(8, ['u1']);
    core.incoming.set(8, [utxo('change', 8, '4', 7), utxo('gift', 8, '9')]);
    await engine.syncOnce();
    const sent = (await db.get('history', 'acc:spent:8'))!;
    expect(sent.kind).toBe('sent');
    expect(sent.txid).toBe('');
    expect(sent.height).toBe(8);
    expect(BigInt(sent.amountNau)).toBe(BigInt(utxo('u1', 4, '5').amount_nau) - BigInt(utxo('change', 8, '4').amount_nau));
    expect(sent.changeNau).toBe(utxo('change', 8, '4').amount_nau);
    expect(sent.outputs?.map((o) => o.commitment)).toEqual([]);
    expect(sent.inputHashes).toEqual(['u1']);

    // A rewind below the block drops the row again.
    await engine.rollBack(7, null);
    expect(await db.get('history', 'acc:spent:8')).toBeUndefined();
  });

  it('rolls back to the last canonical block after a reorg and rescans', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(8);
    core.incoming.set(7, [utxo('orphaned', 7, '1')]);
    await engine.syncOnce();
    expect(await db.get('utxos', 'acc:orphaned')).toBeDefined();

    node.forkAbove(6, 9);
    core.incoming.clear();
    core.incoming.set(9, [utxo('fresh', 9, '3')]);
    const result = await engine.syncOnce();
    expect(result.syncedHeight).toBe(9);
    expect(await db.get('utxos', 'acc:orphaned')).toBeUndefined();
    expect(await db.get('history', 'acc:recv:orphaned')).toBeUndefined();
    expect(await db.get('utxos', 'acc:fresh')).toBeDefined();
    expect((await db.get('syncState', 'acc'))?.syncedHash).toBe('fork-9');
    const blocks = await db.getAllFromIndex('blocks', 'byAccountHeight', IDBKeyRange.bound(['acc', 0], ['acc', Infinity]));
    expect(blocks.map((b) => b.hash)).toEqual(['hash-3', 'hash-4', 'hash-5', 'hash-6', 'fork-7', 'fork-8', 'fork-9']);
  });

  it('sets an unknown start height to the tip at first sync', async () => {
    const { node, engine } = await setup();
    await db.put('accounts', { ...(await db.get('accounts', 'acc'))!, birthdayHeight: 0 });
    node.extendTo(9);
    await engine.syncOnce();
    expect((await db.get('accounts', 'acc'))?.birthdayHeight).toBe(9);
    expect(node.getBlocksCalls).toEqual([[9, 9]]);
  });

  it('clamps a start height above the tip to the tip', async () => {
    const { node, engine } = await setup();
    await db.put('accounts', { ...(await db.get('accounts', 'acc'))!, birthdayHeight: 500 });
    node.extendTo(9);
    const result = await engine.syncOnce();
    expect((await db.get('accounts', 'acc'))?.birthdayHeight).toBe(9);
    expect(result.syncedHeight).toBe(9);
    expect(node.getBlocksCalls).toEqual([[9, 9]]);
  });

  it('fast restore scans the flagged blocks, then the blocks that spent what it found', async () => {
    const { node, core, engine } = await setup();
    await db.put('accounts', { ...account, birthdayHeight: 0, restore: 'fast' });
    node.extendTo(20);
    core.incoming.set(5, [utxo('a', 5, '10')]);
    core.incoming.set(12, [utxo('b', 12, '3')]);
    core.spent.set(15, ['a']);
    node.flagHeights = [12, 5];
    node.spendHeights.set('a', [15]);

    const result = await engine.syncOnce();
    expect(result.phase).toBe('done');
    // Round one: the flagged blocks in order. Round two: where coin a was
    // spent. Then nothing new, and the ordinary scan walks the last ten
    // blocks, so there are block records to measure a reorganisation by.
    expect(node.getBlocksCalls).toEqual([
      [5, 5],
      [12, 12],
      [15, 15],
      [11, 14],
      [15, 18],
      [19, 20],
    ]);
    // Walking over blocks 12 and 15 a second time changed nothing.
    expect((await db.get('utxos', 'acc:a'))?.spentHeight).toBe(15);
    expect((await db.get('utxos', 'acc:b'))?.spentHeight).toBeNull();
    expect((await db.get('syncState', 'acc'))?.syncedHeight).toBe(20);
    expect((await db.get('syncState', 'acc'))?.syncedHash).toBe('hash-20');
    const after = await db.get('accounts', 'acc');
    expect(after?.restore).toBeUndefined();
    expect(after?.birthdayHeight).toBe(5);

    // The ordinary pass takes over from the tip.
    node.extendTo(22);
    await engine.syncOnce();
    expect(node.getBlocksCalls.slice(6)).toEqual([[21, 22]]);
  });

  it('fast restore looks again at a block that spent a coin it only found later', async () => {
    const { node, core, engine } = await setup();
    await db.put('accounts', { ...account, birthdayHeight: 0, restore: 'fast' });
    node.extendTo(40);
    // Coin x sits on a key the first round does not ask about. Block 15
    // spends it and pays change to the main key, so round one scans 15 for
    // the change, before x is known.
    core.incoming.set(5, [utxo('x', 5, '10')]);
    core.incoming.set(15, [utxo('change', 15, '4', 14)]);
    core.spent.set(15, ['x']);
    node.flagRounds = [[15], [15, 5], [15, 5]];
    node.spendHeights.set('x', [15]);

    const result = await engine.syncOnce();
    expect(result.phase).toBe('done');
    expect(node.getBlocksCalls.slice(0, 3)).toEqual([[15, 15], [5, 5], [15, 15]]);
    expect((await db.get('utxos', 'acc:x'))?.spentHeight).toBe(15);
    expect((await db.get('utxos', 'acc:change'))?.spentHeight).toBeNull();
  });

  it('a block written again keeps what is known about its coins, and a coin written afresh is held again by the send that spends it', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(8);
    core.incoming.set(4, [utxo('early', 4, '5')]);
    core.incoming.set(7, [utxo('late', 7, '2')]);
    core.spent.set(6, ['early']);
    await engine.syncOnce();
    expect((await db.get('utxos', 'acc:early'))?.spentHeight).toBe(6);
    await db.put('utxos', { ...(await db.get('utxos', 'acc:late'))!, pendingTxid: 'tx-p' });
    await db.put('history', { key: 'acc:sent:tx-p', accountId: 'acc', kind: 'sent', status: 'pending', txid: 'tx-p', amountNau: '1', feeNau: '0', timestampMs: 0, height: null, inputHashes: ['late'], recipient: 'r', error: null });

    // A reorganisation above block 6 removes coin "late"; the new chain has it again in block 7.
    node.forkAbove(6, 9);
    await engine.syncOnce();
    expect((await db.get('utxos', 'acc:late'))?.pendingTxid).toBe('tx-p');
    expect((await db.get('utxos', 'acc:early'))?.spentHeight).toBe(6);
  });

  it('never lowers the start height or drops the local view on a node\'s say-so', async () => {
    const { node, core, engine } = await setup();
    node.extendTo(10);
    core.incoming.set(5, [utxo('u1', 5, '2')]);
    await engine.syncOnce();

    // A node whose chain is shorter than what this wallet has scanned.
    const stale = new FakeNode();
    stale.extendTo(2);
    const low = await new SyncEngine(db, stale as unknown as NodeClient, core as unknown as WalletCore, 'acc', { batchSize: 4, keepBlocks: 100 }).syncOnce();
    expect(low.phase).toBe('error');
    expect(low.message).toMatch(/below block 10/);
    expect((await db.get('accounts', 'acc'))?.birthdayHeight).toBe(3);

    // A node that knows none of this wallet's blocks.
    const stranger = new FakeNode();
    stranger.extendTo(12);
    stranger.canonical.clear();
    const lost = await new SyncEngine(db, stranger as unknown as NodeClient, core as unknown as WalletCore, 'acc', { batchSize: 4, keepBlocks: 100 }).syncOnce();
    expect(lost.phase).toBe('error');
    expect(lost.message).toMatch(/None of the blocks/);
    expect(await db.get('utxos', 'acc:u1')).toBeDefined();
    expect((await db.get('syncState', 'acc'))?.syncedHeight).toBe(10);
  });

  it('finds the fork by halving, not by walking down', async () => {
    const { node, engine } = await setup();
    node.extendTo(90);
    await engine.syncOnce();
    node.forkAbove(10, 95);
    node.canonicalQuestions = 0;
    const result = await engine.syncOnce();
    expect(result.syncedHeight).toBe(95);
    // 87 stored blocks below the tip: the tip, then about seven halvings.
    expect(node.canonicalQuestions).toBeLessThan(12);
    const blocks = await db.getAllFromIndex('blocks', 'byAccountHeight', IDBKeyRange.bound(['acc', 0], ['acc', Infinity]));
    expect(blocks.find((b) => b.height === 10)?.hash).toBe('hash-10');
    expect(blocks.find((b) => b.height === 11)?.hash).toBe('fork-11');
  });

  it('fast restore says so on a node without the index, and stays pending', async () => {
    const { node, engine } = await setup();
    await db.put('accounts', { ...account, birthdayHeight: 0, restore: 'fast' });
    node.extendTo(5);
    node.noIndex = true;
    const result = await engine.syncOnce();
    expect(result.phase).toBe('error');
    expect(result.message).toMatch(/coin index/);
    expect((await db.get('accounts', 'acc'))?.restore).toBe('fast');
    expect(node.getBlocksCalls).toEqual([]);
  });

  it('stops after the batch in flight, leaving that batch unwritten', async () => {
    const { node, engine } = await setup();
    node.extendTo(20);
    const fetchBlocks = node.getBlocksRaw.bind(node);
    node.getBlocksRaw = async (from, to) => {
      const response = await fetchBlocks(from, to);
      // Stop while the second batch is in flight.
      if (node.getBlocksCalls.length === 2) void engine.stop();
      return response;
    };
    const result = await engine.syncOnce();
    expect(result.phase).toBe('scanning');
    expect(node.getBlocksCalls).toEqual([
      [3, 6],
      [7, 10],
    ]);
    expect((await db.get('syncState', 'acc'))?.syncedHeight).toBe(6);
    // A later pass on the same engine runs to the tip.
    node.getBlocksRaw = fetchBlocks;
    expect((await engine.syncOnce()).phase).toBe('done');
    expect((await db.get('syncState', 'acc'))?.syncedHeight).toBe(20);
  });

  it('reports node errors without corrupting state', async () => {
    const { node, engine } = await setup();
    node.extendTo(5);
    node.getBlocks = async () => {
      throw new Error('boom');
    };
    const result = await engine.syncOnce();
    expect(result.phase).toBe('error');
    expect(result.message).toContain('boom');
    expect(await db.get('syncState', 'acc')).toBeUndefined();
  });
});
