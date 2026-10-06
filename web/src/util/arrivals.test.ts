import { describe, expect, it } from 'vitest';

import type { HistoryRecord } from '../storage/db';
import { arrivals, ARRIVED_WITHIN_MS } from './arrivals';

const NOW = 1_800_000_000_000;
function row(key: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    key,
    accountId: 'a',
    kind: 'received',
    status: 'confirmed',
    txid: '',
    amountNau: '100',
    feeNau: null,
    timestampMs: NOW - 60_000,
    height: 7,
    inputHashes: [],
    recipient: null,
    error: null,
    ...over,
  };
}

describe('payments that arrive while History is in view', () => {
  it('finds none in the first listing', () => {
    expect(arrivals(null, [row('a:recv:1')], NOW).arrived).toEqual([]);
  });

  it('finds a payment new since the last listing', () => {
    const { listed } = arrivals(null, [row('a:recv:1')], NOW);
    expect(arrivals(listed, [row('a:recv:2'), row('a:recv:1')], NOW).arrived).toEqual(['a:recv:2']);
  });

  it('finds a pending payment as it arrives, and not again when it confirms', () => {
    const first = arrivals(null, [row('a:recv:1')], NOW);
    const seen = arrivals(first.listed, [row('a:incoming:c', { status: 'pending', amountNau: '250' }), row('a:recv:1')], NOW);
    expect(seen.arrived).toEqual(['a:incoming:c']);
    // The pending row goes and the confirmed one comes, together or one after the other.
    expect(arrivals(seen.listed, [row('a:recv:2', { amountNau: '250' }), row('a:recv:1')], NOW).arrived).toEqual([]);
    const gone = arrivals(seen.listed, [row('a:recv:1')], NOW);
    expect(arrivals(gone.listed, [row('a:recv:2', { amountNau: '250' }), row('a:recv:1')], NOW).arrived).toEqual([]);
  });

  it('leaves out sends, and old payments a scan finds', () => {
    const { listed } = arrivals(null, [], NOW);
    const rows = [row('a:sent:t', { kind: 'sent' }), row('a:recv:old', { timestampMs: NOW - ARRIVED_WITHIN_MS - 1 })];
    expect(arrivals(listed, rows, NOW).arrived).toEqual([]);
  });
});
