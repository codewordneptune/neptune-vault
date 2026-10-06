import { describe, expect, it } from 'vitest';

import type { HistoryRecord } from '../storage/db';
import { sentCoinOf, sentNoteOf, sentNotesFromFile } from './sentNotes';

const sent = (inputHashes: string[], note: string | null = null): HistoryRecord =>
  ({ key: 'acc:sent:tx', accountId: 'acc', kind: 'sent', status: 'confirmed', txid: 'tx', amountNau: '1', feeNau: '1', timestampMs: 0, height: 1, inputHashes, recipient: null, error: null, note }) as HistoryRecord;

describe('notes on sends', () => {
  it('are kept by the first coin a send spent', () => {
    expect(sentCoinOf(sent(['c0ffee:3', 'beef:9']))).toBe('beef:9');
    expect(sentCoinOf(sent(['c0ffee']))).toBe('c0ffee');
    expect(sentCoinOf(sent([]))).toBeNull();
    expect(sentCoinOf({ ...sent(['c0ffee:3']), kind: 'received' })).toBeNull();
  });

  it('show as changed in History, or else as typed on Send, and stay gone once cleared', () => {
    const record = sent(['c0ffee:3', 'beef:9'], 'Rent');
    expect(sentNoteOf(record, {})).toBe('Rent');
    expect(sentNoteOf(record, { 'c0ffee:3': 'Rent for May' })).toBe('Rent for May');
    expect(sentNoteOf(record, { 'beef:9': '' })).toBeNull();
  });

  it('tell apart two coins with one hash, and find a note kept by the hash alone', () => {
    expect(sentNoteOf(sent(['aa:2']), { 'aa:1': 'Lunch' })).toBeNull();
    expect(sentNoteOf(sent(['aa:1']), { 'aa:1': 'Lunch' })).toBe('Lunch');
    expect(sentNoteOf(sent(['aa:7']), { aa: 'From an older send' })).toBe('From an older send');
  });

  it('come back from a file only by coin key, cleaned, a cleared one kept', () => {
    expect(sentNotesFromFile({ 'c0ffee:3': '  Rent\nfor May ', beef: '', 'not a key': 'x', 'abc:1': 7 })).toEqual({ 'c0ffee:3': 'Rent for May', beef: '' });
    expect(sentNotesFromFile(['c0ffee'])).toEqual({});
    expect(sentNotesFromFile(null)).toEqual({});
  });
});
