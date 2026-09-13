import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings, openVaultDb, saveSettings, type AccountRecord, type VaultDb } from './db';

let db: VaultDb | null = null;
afterEach(() => {
  db?.close();
  db = null;
  indexedDB.deleteDatabase('neptune-vault');
});

const account: AccountRecord = {
  id: 'acc-1',
  network: 'regtest',
  createdAt: 1,
  birthdayHeight: 1,
  envelope: {
    version: 1,
    kdf: { name: 'argon2id', mKib: 8, tCost: 1, pCost: 1, salt: 'AAAA' },
    wrappedContentKey: { iv: 'AAAA', ciphertext: 'AAAA' },
    seed: { iv: 'AAAA', ciphertext: 'AAAA' },
  },
  address0: 'nolgar1...',
  nextKeyIndex: 1,
  backupConfirmed: false,
};

describe('vault database', () => {
  it('creates the stores and round-trips an account', async () => {
    db = await openVaultDb();
    expect([...db.objectStoreNames].sort()).toEqual(['accounts', 'blocks', 'history', 'settings', 'syncState', 'utxos']);
    await db.put('accounts', account);
    expect(await db.get('accounts', 'acc-1')).toEqual(account);
    expect(await db.getAllFromIndex('accounts', 'byNetwork', 'regtest')).toHaveLength(1);
    expect(await db.getAllFromIndex('accounts', 'byNetwork', 'main')).toHaveLength(0);
  });

  it('falls back to default settings and persists changes', async () => {
    db = await openVaultDb();
    expect(await loadSettings(db)).toEqual(DEFAULT_SETTINGS);
    await saveSettings(db, { ...DEFAULT_SETTINGS, network: 'regtest', currentAccountId: 'acc-1' });
    const loaded = await loadSettings(db);
    expect(loaded.network).toBe('regtest');
    expect(loaded.currentAccountId).toBe('acc-1');
  });

  it('indexes blocks by account and height', async () => {
    db = await openVaultDb();
    for (const h of [3, 1, 2]) {
      await db.put('blocks', { key: `acc-1:${h}`, accountId: 'acc-1', height: h, hash: `h${h}`, prevHash: `h${h - 1}`, timestampMs: h });
    }
    await db.put('blocks', { key: 'acc-2:9', accountId: 'acc-2', height: 9, hash: 'x', prevHash: 'y', timestampMs: 9 });
    const range = IDBKeyRange.bound(['acc-1', 0], ['acc-1', Infinity]);
    const rows = await db.getAllFromIndex('blocks', 'byAccountHeight', range);
    expect(rows.map((r) => r.height)).toEqual([1, 2, 3]);
  });
});
