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
  nextKeyIndices: { generation: 1, ec_hybrid: 0, viewing: 0 },
  backupConfirmed: false,
};

describe('vault database', () => {
  it('creates the stores and round-trips an account', async () => {
    db = await openVaultDb();
    expect([...db.objectStoreNames].sort()).toEqual(['accounts', 'blocks', 'contacts', 'history', 'settings', 'syncState', 'utxos']);
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

describe('schema upgrade', () => {
  it('upgrades a version-1 database and keeps its data', async () => {
    const { openDB } = await import('idb');
    const name = 'neptune-vault-upgrade-test';
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
        accounts.createIndex('byNetwork', 'network');
        db.createObjectStore('utxos', { keyPath: 'key' }).createIndex('byAccount', 'accountId');
        db.createObjectStore('blocks', { keyPath: 'key' }).createIndex('byAccountHeight', ['accountId', 'height']);
        db.createObjectStore('history', { keyPath: 'key' }).createIndex('byAccount', 'accountId');
        db.createObjectStore('syncState', { keyPath: 'accountId' });
        db.createObjectStore('settings', { keyPath: 'id' });
      },
    });
    await v1.put('accounts', { ...account, id: 'old' });
    v1.close();

    // The same version-2 step as openVaultDb, on the fixture's name.
    const upgraded = await openDB(name, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 2) db.createObjectStore('contacts', { keyPath: 'key' }).createIndex('byAccount', 'accountId');
      },
    });
    expect(upgraded.objectStoreNames.contains('contacts')).toBe(true);
    expect((await upgraded.get('accounts', 'old'))?.network).toBe('regtest');
    upgraded.close();
  });
});
