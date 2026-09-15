import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeClient, RpcBlockHeader, RpcWalletBlock } from '../node/rpc';
import { openVaultDb, type AccountRecord, type VaultDb } from '../storage/db';
import type { NextKeyIndices, ScanResult, StoredUtxo, WalletCore } from './core';
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
  spendHeights = new Map<string, number[]>();
  noIndex = false;
  async tipDigest() {
    return this.hashAt(this.tip);
  }
  async blockHeightsByFlags(_flagsJson: string): Promise<number[]> {
    if (this.noIndex) throw new Error("utxoindex_blockHeightsByFlags: Method not found");
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
  nextKeyIndexAfter = 1;
  async announcementFlags() {
    return "[]";
  }
  async absoluteIndexSets(unspent: StoredUtxo[]) {
    return JSON.stringify(unspent.map((u) => u.hash));
  }
  async scanBlocks(blocksResponse: string, _unspent: StoredUtxo[], _next: NextKeyIndices): Promise<ScanResult> {
    const blocks = (JSON.parse(blocksResponse) as { result: { blocks: unknown[] } }).result.blocks;
    const out = (blocks as RpcWalletBlock[]).map((b) => ({
      height: b.kernel.header.height,
      hash: b.proofLeaf,
      prev_hash: b.kernel.header.prevBlockDigest,
      timestamp_ms: b.kernel.header.timestamp,
      incoming: this.incoming.get(b.kernel.header.height) ?? [],
      spent: this.spent.get(b.kernel.header.height) ?? [],
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
    // Round one: the flagged blocks in order. Round two: where coin a was spent. Then nothing new.
    expect(node.getBlocksCalls).toEqual([
      [5, 5],
      [12, 12],
      [15, 15],
    ]);
    expect((await db.get('utxos', 'acc:a'))?.spentHeight).toBe(15);
    expect((await db.get('utxos', 'acc:b'))?.spentHeight).toBeNull();
    expect((await db.get('syncState', 'acc'))?.syncedHeight).toBe(20);
    const after = await db.get('accounts', 'acc');
    expect(after?.restore).toBeUndefined();
    expect(after?.birthdayHeight).toBe(5);

    // The ordinary pass takes over from the tip.
    node.extendTo(22);
    await engine.syncOnce();
    expect(node.getBlocksCalls.slice(3)).toEqual([[21, 22]]);
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
