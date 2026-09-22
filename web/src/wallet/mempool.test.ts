import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type AccountRecord, type VaultDb } from '../storage/db';
import { CHAIN_PARTS, type MempoolScan } from '../backend/types';
import { chainView, testEngine, type TestEngine } from '../backend/engineForTests';
import { incomingKey, MempoolWatcher, outgoingKey, type MempoolNode, type MempoolWatcherOptions } from './mempool';

// The watcher decides what it has seen; the real engine, compiled to wasm,
// writes it. These tests read back what the engine wrote.

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

/** Stands in for the core's scan of a kernel, which needs real keys. */
class FakeCore {
  /** kernel id -> what the scan finds. */
  scans = new Map<string, MempoolScan>();
  async scanMempoolKernel(raw: string): Promise<MempoolScan> {
    return this.scans.get(raw.replace('kernel:', '')) ?? { incoming: [], spent: [], timestamp_ms: 0 };
  }
}

const payment = (commitment: string, amount: string, ts = 5000): MempoolScan => ({
  incoming: [{ commitment, amount_nau: `${amount}000000000000000000000000000000`, amount, key_kind: 'generation', key_index: 0, own: false }],
  spent: [],
  timestamp_ms: ts,
});

let db: VaultDb;
let vault: TestEngine;
let view: ReturnType<typeof chainView>;
afterEach(() => {
  vault?.close();
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

async function setup(options: MempoolWatcherOptions = { batchSize: 2, patience: 2, now: () => 99 }) {
  db = await openVaultDb();
  await db.put('accounts', account);
  const node = new FakeNode();
  const core = new FakeCore();
  vault = await testEngine({ scanMempoolKernel: (op) => core.scanMempoolKernel(op.kernelResponse) });
  vault.unlock();
  await vault.store.storeOpen('acc');
  await vault.store.storeMigrate('acc', CHAIN_PARTS, { accounts: [account] });
  view = chainView(vault, db, 'acc');
  const watcher = new MempoolWatcher(node, vault.store, 'acc', options);
  return { node, core, watcher };
}

describe('MempoolWatcher', () => {
  it('records an incoming payment as a pending received row, once', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '2'));
    expect(await watcher.poll()).toEqual({ scanned: 1, incoming: 1, incomingNau: '2000000000000000000000000000000', lockedNau: '0' });
    const row = (await view.get('history', incomingKey('acc', 'c1')))!;
    expect(row.kind).toBe('received');
    expect(row.status).toBe('pending');
    expect(row.txid).toBe('t1');
    expect(row.amountNau.startsWith('2')).toBe(true);
    expect(row.timestampMs).toBe(5000);
    expect(row.outputs).toEqual([{ commitment: 'c1', role: 'recipient' }]);

    // Seen ids are not fetched again.
    expect(await watcher.poll()).toEqual({ scanned: 0, incoming: 0, incomingNau: '0', lockedNau: '0' });
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
    const rows = (await view.getAllFromIndex('history', 'byAccount', 'acc')).filter((h) => h.status === 'pending');
    expect(rows).toHaveLength(1);
  });

  it('drops a pending row after the transaction has been gone for a while', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '2'));
    await watcher.poll();
    node.ids = [];
    await watcher.poll();
    expect(await view.get('history', incomingKey('acc', 'c1'))).toBeDefined();
    await watcher.poll();
    expect(await view.get('history', incomingKey('acc', 'c1'))).toBeUndefined();
  });

  it('marks whether the node still holds the wallet\'s own pending send', async () => {
    const { node, watcher } = await setup();
    await view.put('history', {
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
    let row = (await view.get('history', 'acc:sent:tx9'))!;
    expect(row.mempoolCheckedAt).toBe(99);
    expect(row.mempoolSeenAt).toBeNull();

    node.held.add('out9');
    await watcher.poll();
    row = (await view.get('history', 'acc:sent:tx9'))!;
    expect(row.mempoolSeenAt).toBe(99);
  });

  it('ignores the change of a send this wallet built', async () => {
    const { node, core, watcher } = await setup();
    await view.put('history', {
      key: 'acc:sent:tx9', accountId: 'acc', kind: 'sent', status: 'pending', txid: 'tx9', amountNau: '1', feeNau: '1', timestampMs: 1, height: null,
      inputHashes: ['u1'], recipient: 'r', error: null, outputs: [{ commitment: 'pay', role: 'recipient' }, { commitment: 'chg', role: 'change' }],
    });
    node.ids = ['tx9'];
    core.scans.set('tx9', { incoming: [{ commitment: 'chg', amount_nau: '5', amount: '5', key_kind: 'generation', key_index: 0, own: false }], spent: ['u1'], timestamp_ms: 1 });
    expect((await watcher.poll()).incoming).toBe(0);
    const rows = (await view.getAllFromIndex('history', 'byAccount', 'acc')).filter((h) => h.kind === 'received');
    expect(rows).toHaveLength(0);
  });

  it('shows a spend built elsewhere as one pending sent row and holds its coins', async () => {
    const { node, core, watcher } = await setup();
    await view.put('utxos', { key: 'acc:u1', accountId: 'acc', hash: 'u1', stored: {}, amountNau: '5000', amount: '5', confirmedHeight: 1, confirmedTimestampMs: 0, releaseDateMs: null, spentHeight: null, spentTxid: null, pendingTxid: null });
    node.ids = ['tz'];
    core.scans.set('tz', { incoming: [{ commitment: 'back', amount_nau: '4300', amount: '4.3', key_kind: 'generation', key_index: 0, own: true }], spent: ['u1'], timestamp_ms: 7 });
    expect((await watcher.poll()).incoming).toBe(0);
    const row = (await view.get('history', outgoingKey('acc', 'u1')))!;
    expect(row.kind).toBe('sent');
    expect(row.status).toBe('pending');
    expect(row.amountNau).toBe('700');
    expect(row.changeNau).toBe('4300');
    expect(row.recipient).toBeNull();
    expect(await view.get('history', incomingKey('acc', 'back'))).toBeUndefined();
    expect((await view.get('utxos', 'acc:u1'))!.pendingTxid).toBe('tz');

    // Gone from the mempool without a block: row dropped, coin released.
    node.ids = [];
    await watcher.poll();
    await watcher.poll();
    expect(await view.get('history', outgoingKey('acc', 'u1'))).toBeUndefined();
    expect((await view.get('utxos', 'acc:u1'))!.pendingTxid).toBeNull();
  });

  it('never reports an output this seed built as incoming, even with no send recorded', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['own'];
    core.scans.set('own', { incoming: [{ commitment: 'c9', amount_nau: '5', amount: '5', key_kind: 'generation', key_index: 0, own: true }], spent: [], timestamp_ms: 1 });
    expect((await watcher.poll()).incoming).toBe(0);
    expect(await view.get('history', incomingKey('acc', 'c9'))).toBeUndefined();
  });

  it('switches itself off when the node has no mempool namespace', async () => {
    const { node, watcher } = await setup();
    node.mempoolTransactions = async () => {
      throw new Error('Method not found');
    };
    expect(await watcher.poll()).toEqual({ scanned: 0, incoming: 0, incomingNau: '0', lockedNau: '0' });
    expect(watcher.disabled).toBe(true);
  });
});

describe('MempoolWatcher, when things go wrong', () => {
  it('passes over a kernel it cannot read, and does not stall on it at every poll', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['broken', 'good'];
    core.scans.set('good', payment('c-good', '2'));
    const scan = core.scanMempoolKernel.bind(core);
    core.scanMempoolKernel = async (raw) => {
      if (raw === 'kernel:broken') throw new Error('cannot decode mempool kernel');
      return scan(raw);
    };
    const first = await watcher.poll();
    expect(first.incoming).toBe(1);
    await watcher.poll();
    // Fetched once, not again at the head of every later poll.
    expect(node.fetched.filter((id) => id === 'broken')).toHaveLength(1);
  });

  it('ends the round when the node stops answering, and tries the same kernel again next time', async () => {
    const { node, core, watcher } = await setup();
    node.ids = ['later'];
    core.scans.set('later', payment('c-later', '1'));
    const fetch = node.mempoolKernelRaw.bind(node);
    let down = true;
    node.mempoolKernelRaw = async (id) => {
      if (down) throw Object.assign(new Error('No answer from the node'), { code: 'timeout' });
      return fetch(id);
    };
    await expect(watcher.poll()).rejects.toThrow(/No answer/);
    down = false;
    expect((await watcher.poll()).incoming).toBe(1);
  });

  it("writes nothing once another wallet's keys are the ones loaded", async () => {
    let mine = true;
    const { node, core, watcher } = await setup({ isCurrent: () => mine });
    node.ids = ['t1'];
    core.scans.set('t1', payment('c1', '3'));
    // The wallet is switched while the kernel is being scanned.
    const scan = core.scanMempoolKernel.bind(core);
    core.scanMempoolKernel = async (raw) => {
      mine = false;
      return scan(raw);
    };
    await watcher.poll();
    expect(await view.get('history', incomingKey('acc', 'c1'))).toBeUndefined();
  });

  it('does not hold a coin the sync has marked spent in the meantime', async () => {
    const { node, core, watcher } = await setup();
    const coin = { key: 'acc:u1', accountId: 'acc', hash: 'u1', stored: { hash: 'u1' }, amountNau: '5', amount: '5', confirmedHeight: 4, confirmedTimestampMs: 0, releaseDateMs: null, spentHeight: null, spentTxid: null, pendingTxid: null };
    await view.put('utxos', coin);
    node.ids = ['spend'];
    core.scans.set('spend', { incoming: [], spent: ['u1'], timestamp_ms: 1 });
    // The sync confirms the spend between the watcher reading the coins and holding them.
    const scan = core.scanMempoolKernel.bind(core);
    core.scanMempoolKernel = async (raw) => {
      await view.put('utxos', { ...coin, spentHeight: 9 });
      return scan(raw);
    };
    await watcher.poll();
    expect(await view.get('utxos', 'acc:u1')).toMatchObject({ spentHeight: 9, pendingTxid: null });
  });
});
