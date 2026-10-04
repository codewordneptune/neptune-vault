import { describe, expect, it } from 'vitest';

import type { HistoryRecord } from '../storage/db';
import { receivedCoinOf, receivedNotesFromFile } from './receivedNotes';

const received = (key: string, status: HistoryRecord['status'] = 'confirmed'): HistoryRecord =>
  ({ key, accountId: 'acc', kind: 'received', status, txid: '', amountNau: '1', feeNau: null, timestampMs: 0, height: 1, inputHashes: [], recipient: null, error: null, changeNau: null }) as HistoryRecord;

describe('notes on payments received', () => {
  it('are kept by the coin a confirmed payment brought, and not on one still on its way', () => {
    expect(receivedCoinOf(received('acc:recv:c0ffee:3'))).toBe('c0ffee:3');
    expect(receivedCoinOf(received('acc:incoming:abc', 'pending'))).toBeNull();
    expect(receivedCoinOf({ ...received('acc:sent:tx'), kind: 'sent' })).toBeNull();
  });

  it('come back from a file only with a coin key and some text, cleaned', () => {
    expect(receivedNotesFromFile({ 'c0ffee:3': '  Rent\nfor May ', 'not a key': 'x', 'beef:1': '   ', 'beef:2': 7 })).toEqual({ 'c0ffee:3': 'Rent for May' });
    expect(receivedNotesFromFile(['c0ffee:3'])).toEqual({});
    expect(receivedNotesFromFile(null)).toEqual({});
  });
});
