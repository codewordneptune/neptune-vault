import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type AccountRecord, type VaultDb } from '../storage/db';
import type { MempoolScan, NextKeyIndices, StoredUtxo } from './core';
import { incomingKey, MempoolWatcher, type MempoolNode } from './mempool';

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

class FakeNode implements MempoolNode {
  ids: string[] = [];
  held = new Set<string>();
  fetched: string[] = [];
  async mempoolTransactions() {
    return [...this.ids];
  }
  async mempoolKernelRaw(id: string) {
    this.fetched.push(id);
    return `kernel:${id}`;
  }
  async mempoolHasOutputs(commitments: string[]) {
    return new Set(commitments.filter((c) => this.held.has(c)));
  }
}

class FakeCore {
  /** kernel id -> what the scan finds. */
  scans = new Map<string, MempoolScan>();
  async scanMempoolKernel(raw: string, _unspent: StoredUtxo[], _next: NextKeyIndices): Promise<MempoolScan> {
    return this.scans.get(raw.replace('kernel:', '')) ?? { incoming: [], spent: [], timestamp_ms: 0 };
  }
}

const payment = (commitment: string, amount: string, ts = 5000): MempoolScan => ({
  incoming: [{ commitment, amount_nau: `${amount}000000000000000000000000000000`, amount, key_kind: 'generation', key_index: 0 }],
  spent: [],
  timestamp_ms: ts,
});

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
  const watcher = new MempoolWatcher(db, node, core, 'acc', { batchSize: 2, patience: 2, now: () => 99 });
  return { node, core, watcher };
}

describe('MempoolWatcher', () => {
  it('records an incoming payment as a pending received row, once', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '2'));
    expect(await watcher.poll()).toEqual({ scanned: 1, incoming: 1 });
    const row = (await db.get('history', incomingKey('acc', 'c1')))!;
    expect(row.kind).toBe('received');
    expect(row.status).toBe('pending');
    expect(row.txid).toBe('t1');
    expect(row.amountNau.startsWith('2')).toBe(true);
    expect(row.timestampMs).toBe(5000);
    expect(row.outputs).toEqual([{ commitment: 'c1', role: 'recipient' }]);

    // Seen ids are not fetched again.
    expect(await watcher.poll()).toEqual({ scanned: 0, incoming: 0 });
    expect(node.fetched).toEqual(['t1']);
  });

  it('fetches only a batch per poll and finishes the rest on later polls', async () => {
    const { node, watcher } = await setup();
    node.ids = ['a', 'b', 'c', 'd', 'e'];
    expect((await watcher.poll()).scanned).toBe(2);
    expect((await watcher.poll()).scanned).toBe(2);
    expect((await watcher.poll()).scanned).toBe(1);
    expect((await watcher.poll()).scanned).toBe(0);
  });

  it('keeps one row when a rewritten transaction returns under a new id', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '2'));
    await watcher.poll();
    node.ids = ['t2'];
    core.scans.set('t2', payment('c1', '2'));
    await watcher.poll();
    const rows = (await db.getAllFromIndex('history', 'byAccount', 'acc')).filter((h) => h.status === 'pending');
    expect(rows).toHaveLength(1);
  });

  it('drops a pending row after the transaction has been gone for a while', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '2'));
    await watcher.poll();
    node.ids = [];
    await watcher.poll();
    expect(await db.get('history', incomingKey('acc', 'c1'))).toBeDefined();
    await watcher.poll();
    expect(await db.get('history', incomingKey('acc', 'c1'))).toBeUndefined();
  });

  it('marks whether the node still holds the wallet\'s own pending send', async () => {
    const { node, watcher } = await setup();
    await db.put('history', {
      key: 'acc:sent:tx9',
      accountId: 'acc',
      kind: 'sent',
      status: 'pending',
      txid: 'tx9',
      amountNau: '1',
      feeNau: '1',
      timestampMs: 1,
      height: null,
      inputHashes: ['u1'],
      recipient: 'r',
      error: null,
      outputs: [{ commitment: 'out9', role: 'recipient' }],
    });
    await watcher.poll();
    let row = (await db.get('history', 'acc:sent:tx9'))!;
    expect(row.mempoolCheckedAt).toBe(99);
    expect(row.mempoolSeenAt).toBeNull();

    node.held.add('out9');
    await watcher.poll();
    row = (await db.get('history', 'acc:sent:tx9'))!;
    expect(row.mempoolSeenAt).toBe(99);
  });

  it('switches itself off when the node has no mempool namespace', async () => {
    const { node, watcher } = await setup();
    node.mempoolTransactions = async () => {
      throw new Error('Method not found');
    };
    expect(await watcher.poll()).toEqual({ scanned: 0, incoming: 0 });
    expect(watcher.disabled).toBe(true);
  });
});
