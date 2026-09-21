import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { LogStore } from './logStore';

const NAME = 'log-store-test';
const bytes = (...n: number[]) => new Uint8Array(n);
const sortedRows = (rows: Uint8Array[]) => rows.map((r) => [...r]).sort((a, b) => a[0] - b[0]);

let store: LogStore;
afterEach(() => {
  store?.close();
  indexedDB.deleteDatabase(NAME);
});

describe('the log store', () => {
  it('gives back what it was given, per log', async () => {
    store = await LogStore.open(NAME);
    await store.append('device', 1, bytes(1));
    await store.append('wallet:a', 1, bytes(10));
    await store.append('wallet:a', 2, bytes(11));
    expect(sortedRows(await store.load('wallet:a'))).toEqual([[10], [11]]);
    expect(sortedRows(await store.load('device'))).toEqual([[1]]);
    expect(await store.load('wallet:nobody')).toEqual([]);
    expect((await store.logs()).sort()).toEqual(['device', 'wallet:a']);
  });

  it('keeps it across closing and opening again', async () => {
    store = await LogStore.open(NAME);
    await store.append('device', 1, bytes(1));
    store.close();
    store = await LogStore.open(NAME);
    expect(sortedRows(await store.load('device'))).toEqual([[1]]);
  });

  it('refuses a number that is already taken, so two writers cannot both believe they wrote it', async () => {
    store = await LogStore.open(NAME);
    await store.append('device', 1, bytes(1));
    await expect(store.append('device', 1, bytes(2))).rejects.toThrow();
    expect(sortedRows(await store.load('device'))).toEqual([[1]]);
  });

  it('compacts: the snapshot replaces what it covers and leaves what came after', async () => {
    store = await LogStore.open(NAME);
    for (const seq of [1, 2, 3, 4]) await store.append('wallet:a', seq, bytes(seq));
    await store.append('wallet:b', 1, bytes(50));
    await store.compact('wallet:a', 3, bytes(99));
    expect(sortedRows(await store.load('wallet:a'))).toEqual([[4], [99]]);
    // A later snapshot replaces the earlier one.
    await store.compact('wallet:a', 4, bytes(100));
    expect(sortedRows(await store.load('wallet:a'))).toEqual([[100]]);
    expect(sortedRows(await store.load('wallet:b'))).toEqual([[50]]);
  });

  it('forgets one log and keeps the others', async () => {
    store = await LogStore.open(NAME);
    await store.append('wallet:a', 1, bytes(1));
    await store.append('wallet:b', 1, bytes(2));
    await store.remove('wallet:a');
    expect(await store.load('wallet:a')).toEqual([]);
    expect(await store.logs()).toEqual(['wallet:b']);
  });
});
