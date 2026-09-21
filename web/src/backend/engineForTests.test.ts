// The harness itself: the real engine loads, seals, runs the ledger, and
// keeps one operation from overwriting another's work.

import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryRecord } from '../storage/db';
import { testEngine, type TestEngine } from './engineForTests';
import type { ScanResult, StoredUtxo } from './types';

let engine: TestEngine;
afterEach(() => engine?.close());

const W = 'wallet-1';

/**
 * A coin as the core reports it, from the core's own serialisation
 * (ledger::tests::print_the_wire_shape_of_a_coin). The recovery data is a
 * native-currency coin under a zero lock script: enough for bookkeeping.
 */
export function coin(hash: string, amount: string, height: number): StoredUtxo {
  const zero = '0'.repeat(80);
  return {
    hash,
    commitment: `cm-${hash}`,
    recovery: {
      utxo: { lock_script_hash: zero, coins: [{ type_script_hash: '35ab20eaca74e39c97b1b1c6eeb337853babec0d1b4152b6218f12ab673618df11bb3a534af30f64', state: [Number(amount), 0, 0, 0] }] },
      sender_randomness: zero,
      receiver_preimage: zero,
      aocl_index: height,
    },
    amount_nau: amount,
    amount,
    key_kind: 'generation',
    key_index: 0,
    release_date_ms: null,
    confirmed_height: height,
    confirmed_block: `h${height}`,
    confirmed_timestamp_ms: height * 10,
    own_build_height: null,
  } as unknown as StoredUtxo;
}

function found(height: number, incoming: StoredUtxo[], spent: string[] = [], seen: string[] = []): ScanResult {
  return {
    blocks: [{ height, hash: `h${height}`, prev_hash: `h${height - 1}`, timestamp_ms: height * 10, incoming, spent, seen }],
    next_key_indices: { generation: 1, ec_hybrid: 0, viewing: 0 },
  };
}

/** A wallet whose chain data has moved into the engine, from an old database with nothing in it yet. */
async function openWallet(): Promise<TestEngine> {
  engine = await testEngine();
  engine.unlock();
  await engine.store.storeOpen(W);
  const account = { id: W, network: 'regtest', createdAt: 1, envelope: {}, address0: 'nolgar1a', birthdayHeight: 100, nextKeyIndices: { generation: 1, ec_hybrid: 0, viewing: 0 }, backupConfirmed: true };
  await engine.store.storeMigrate(W, ['scan', 'sync', 'utxos', 'blocks', 'history'], { accounts: [account] });
  return engine;
}

describe('the real engine, run as the worker runs it', () => {
  it('moves an empty chain over and starts a pass from the start height', async () => {
    const e = await openWallet();
    expect((await e.store.storeOpen(W)).sort()).toEqual(['blocks', 'history', 'scan', 'sync', 'utxos']);
    expect(await e.store.ledger(W, { op: 'startPass', tipHeight: 500 })).toEqual({ syncedHeight: 99, syncedHash: null });
  });

  it('writes what a scan found and reads it back in the app\'s own shape', async () => {
    const e = await openWallet();
    await e.store.ledger(W, { op: 'persistScan', result: found(120, [coin('a', '5000', 120)]), now: 1 });
    const [utxo] = (await e.store.storeRead(W, 'utxos')) as { key: string; accountId: string; amountNau: string }[];
    expect(utxo).toMatchObject({ key: `${W}:a`, accountId: W, amountNau: '5000' });
    expect(await e.store.ledger(W, { op: 'unspentHashes' })).toEqual(['a']);
    expect(await e.store.ledger(W, { op: 'startPass', tipHeight: 500 })).toEqual({ syncedHeight: 120, syncedHash: 'h120' });
  });

  it('survives a lock: what was written is there after unlocking again, and nothing is readable before', async () => {
    const e = await openWallet();
    await e.store.ledger(W, { op: 'persistScan', result: found(120, [coin('a', '5000', 120)]), now: 1 });
    e.lock();
    await expect(e.store.storeRead(W, 'utxos')).rejects.toThrow('wallet is locked');
    e.unlock();
    await e.store.storeOpen(W);
    expect(((await e.store.storeRead(W, 'utxos')) as unknown[]).length).toBe(1);
  });

  it('two writers at once cannot undo each other: a hold arriving after a spend does not unspend the coin', async () => {
    const e = await openWallet();
    await e.store.ledger(W, { op: 'persistScan', result: found(120, [coin('a', '5000', 120)]), now: 1 });
    const outgoing = {
      key: `${W}:outgoing:a`, accountId: W, kind: 'sent', status: 'pending', txid: 'm1', amountNau: '5000', feeNau: null,
      timestampMs: 1, height: null, inputHashes: ['a'], recipient: null, error: null, changeNau: null, outputs: [],
    } as HistoryRecord;
    // Fired together, as the sync and the mempool watcher would be.
    await Promise.all([
      e.store.ledger(W, { op: 'persistScan', result: found(121, [], ['a']), now: 2 }),
      e.store.ledger(W, { op: 'recordOutgoing', row: outgoing }),
    ]);
    const [a] = (await e.store.storeRead(W, 'utxos')) as { spentHeight: number | null; pendingTxid: string | null }[];
    expect(a.spentHeight).toBe(121);
    expect(a.pendingTxid).toBeNull();
  });

  it('keyed operations are the tests\' to answer, and a locked wallet\'s to refuse', async () => {
    const e = await openWallet();
    await expect(e.store.ledger(W, { op: 'announcementFlags' })).rejects.toThrow('wallet is locked');
    const answered = await testEngine({ announcementFlags: () => '[]' });
    try {
      expect(await answered.store.ledger(W, { op: 'announcementFlags' })).toBe('[]');
    } finally {
      answered.close();
    }
  });
});
