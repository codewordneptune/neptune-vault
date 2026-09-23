import { describe, expect, it } from 'vitest';

import type { HistoryRecord, UtxoRecord } from '../storage/db';
import { changeOf, coinKeyOfReceipt, groupHistory } from './history';

const A = 'acct';
function sent(over: Partial<HistoryRecord>): HistoryRecord {
  return {
    key: `${A}:sent:tx1`,
    accountId: A,
    kind: 'sent',
    status: 'confirmed',
    txid: 'tx1',
    amountNau: '5000',
    feeNau: '300',
    timestampMs: 1000,
    height: 42,
    inputHashes: ['in1'],
    recipient: 'nolga1abc',
    error: null,
    ...over,
  };
}
function received(hash: string, amountNau: string, height: number | null = 42): HistoryRecord {
  return {
    key: `${A}:recv:${hash}`,
    accountId: A,
    kind: 'received',
    status: 'confirmed',
    txid: '',
    amountNau,
    feeNau: null,
    timestampMs: 900,
    height,
    inputHashes: [],
    recipient: null,
    error: null,
  };
}
function utxo(hash: string, amountNau: string, own?: number | null): UtxoRecord {
  return {
    key: `${A}:${hash}`,
    accountId: A,
    hash,
    stored: (own === undefined ? {} : { own_build_height: own }) as UtxoRecord['stored'],
    amountNau,
    amount: '',
    confirmedHeight: 1,
    confirmedTimestampMs: 0,
    releaseDateMs: null,
    spentHeight: null,
    spentTxid: null,
    pendingTxid: null,
  };
}

describe('changeOf', () => {
  it('uses the recorded change when the send has one', () => {
    expect(changeOf(sent({ changeNau: '4700' }), [])).toBe(4700n);
    expect(changeOf(sent({ changeNau: '0' }), [])).toBe(0n);
  });
  it('derives it from the inputs for older rows, and gives up when they are missing', () => {
    expect(changeOf(sent({}), [utxo('in1', '10000')])).toBe(4700n);
    expect(changeOf(sent({}), [])).toBeNull();
  });
});

describe('groupHistory', () => {
  it('folds the change of a confirmed send into it', () => {
    const rows = [sent({ changeNau: '4700' }), received('chg', '4700'), received('other', '4700', 43)];
    const entries = groupHistory(rows, []);
    expect(entries.map((e) => [e.kind, e.record.key])).toEqual([
      ['sent', `${A}:sent:tx1`],
      ['received', `${A}:recv:other`],
    ]);
    // What left the wallet: the amount and the fee together.
    expect(entries[0].shownNau).toBe(5300n);
    expect(entries[0].netNau).toBe(-5300n);
    expect(entries[0].changeNau).toBe(4700n);
    expect(entries[0].folded.map((r) => r.key)).toEqual([`${A}:recv:chg`]);
  });

  it('recognises a send to one of the wallet\'s own addresses', () => {
    const rows = [sent({ changeNau: '4700' }), received('chg', '4700'), received('me', '5000')];
    const [entry] = groupHistory(rows, []);
    expect(entry.kind).toBe('self');
    expect(entry.shownNau).toBe(300n);
    expect(entry.netNau).toBe(-300n);
    expect(entry.folded).toHaveLength(2);
  });

  it('leaves unrelated payments in the same block alone', () => {
    const rows = [sent({ changeNau: '4700' }), received('chg', '4700'), received('gift', '123')];
    const entries = groupHistory(rows, []);
    expect(entries.map((e) => e.kind)).toEqual(['sent', 'received']);
  });

  it('folds everything that arrived in the block into a spend recorded from the chain', () => {
    const elsewhere = sent({ key: `${A}:spent:42`, txid: '', feeNau: null, recipient: null, amountNau: '3000', changeNau: '7000' });
    const rows = [elsewhere, received('a', '6000'), received('b', '1000'), received('later', '5', 43)];
    const entries = groupHistory(rows, []);
    expect(entries.map((e) => [e.kind, e.record.key])).toEqual([
      ['sent', `${A}:spent:42`],
      ['received', `${A}:recv:later`],
    ]);
    expect(entries[0].folded).toHaveLength(2);
    // The chain carries no fee, so the amount recorded is already what left.
    expect(entries[0].shownNau).toBe(3000n);
  });

  it('does not fold anything into a pending send', () => {
    const rows = [sent({ status: 'pending', height: null, changeNau: '4700' }), received('x', '4700', 50)];
    expect(groupHistory(rows, []).map((e) => e.kind)).toEqual(['sent', 'received']);
  });

  it('folds a coin this seed built whatever its amount, and never one someone else built', () => {
    const rows = [sent({ changeNau: '4700', outputs: [{ commitment: 'pay', role: 'recipient' }, { commitment: 'chg', role: 'change' }] }), received('mine', '999'), received('theirs', '5000')];
    const coins = [utxo('mine', '999', 40), utxo('theirs', '5000', null)];
    const entries = groupHistory(rows, coins);
    expect(entries.map((e) => [e.kind, e.record.key])).toEqual([
      ['sent', `${A}:sent:tx1`],
      ['received', `${A}:recv:theirs`],
    ]);
    expect(entries[0].folded.map((r) => r.key)).toEqual([`${A}:recv:mine`]);
  });

  it('calls a send to yourself by the recipient output this seed built', () => {
    const rows = [sent({ changeNau: '4700', outputs: [{ commitment: 'pay', role: 'recipient' }, { commitment: 'chg', role: 'change' }] }), received('a', '4700'), received('b', '5000')];
    const coins = [{ ...utxo('a', '4700', 40), stored: { own_build_height: 40, commitment: 'chg' } as UtxoRecord['stored'] }, { ...utxo('b', '5000', 40), stored: { own_build_height: 40, commitment: 'pay' } as UtxoRecord['stored'] }];
    const [entry] = groupHistory(rows, coins);
    expect(entry.kind).toBe('self');
    expect(entry.folded).toHaveLength(2);
  });

  it('counts only the payments to others as leaving, in a send to several', () => {
    const outputs = [
      { commitment: 'pay-them', role: 'recipient' as const },
      { commitment: 'pay-me', role: 'recipient' as const },
      { commitment: 'chg', role: 'change' as const },
    ];
    const rows = [sent({ amountNau: '5000', changeNau: '100', outputs }), received('mine', '2000'), received('change', '100')];
    const coins = [
      { ...utxo('mine', '2000', 40), stored: { own_build_height: 40, commitment: 'pay-me' } as UtxoRecord['stored'] },
      { ...utxo('change', '100', 40), stored: { own_build_height: 40, commitment: 'chg' } as UtxoRecord['stored'] },
    ];
    const [entry] = groupHistory(rows, coins);
    expect(entry.kind).toBe('sent');
    expect(entry.ownPayments).toEqual(['pay-me']);
    // 3000 to the other recipient and the fee of 300 left the wallet.
    expect(entry.shownNau).toBe(3300n);
    expect(entry.netNau).toBe(-3300n);
  });

  it('calls a send to several a move to yourself only when every payment came back', () => {
    const outputs = [
      { commitment: 'p1', role: 'recipient' as const },
      { commitment: 'p2', role: 'recipient' as const },
    ];
    const rows = [sent({ amountNau: '5000', changeNau: '0', outputs }), received('one', '2000'), received('two', '3000')];
    const coins = [
      { ...utxo('one', '2000', 40), stored: { own_build_height: 40, commitment: 'p1' } as UtxoRecord['stored'] },
      { ...utxo('two', '3000', 40), stored: { own_build_height: 40, commitment: 'p2' } as UtxoRecord['stored'] },
    ];
    const [entry] = groupHistory(rows, coins);
    expect(entry.kind).toBe('self');
    expect(entry.shownNau).toBe(300n);
  });

  it('keeps the input order', () => {
    const rows = [received('a', '1', 10), sent({ changeNau: '4700' }), received('b', '2', 11)];
    expect(groupHistory(rows, []).map((e) => e.record.key)).toEqual([`${A}:recv:a`, `${A}:sent:tx1`, `${A}:recv:b`]);
  });
});

describe('coinKeyOfReceipt', () => {
  it('reads the whole coin key, which holds a colon of its own', () => {
    expect(coinKeyOfReceipt({ key: 'acct:recv:abcd:41' })).toBe('abcd:41');
    expect(coinKeyOfReceipt({ key: 'acct:recv:abcd' })).toBe('abcd');
  });
});
