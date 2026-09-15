// The data-format policy, pinned: every backup file version ever written
// stays readable; the database upgrades in place; anything newer than the
// app is refused with a message that says to update.
//
// The backup fixtures under ./fixtures were written by this file with
// WRITE_FIXTURES=1 (a throwaway phrase, the test KDF, password
// "fixture-pass"). Never delete or regenerate an existing fixture: it is a
// file a person could hold. Add one per new version instead.

import 'fake-indexeddb/auto';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { AccountService } from '../app/accounts';
import type { WalletCore } from '../wallet/core';
import { DB_VERSION, openVaultDb, type VaultDb } from './db';
import { sealSeed, type DeriveKey, type ExportFile } from './envelope';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const PASSWORD = 'fixture-pass';
const PHRASE = Array.from({ length: 18 }, (_, i) => `w${i}`);

// The same stand-in for Argon2 the other tests use; the real one lives in wasm.
const fakeDerive: DeriveKey = (password, salt) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (password[i % password.length] ?? 0) ^ salt[i % salt.length] ^ i;
  return Promise.resolve(out);
};

class FakeCore implements Partial<WalletCore> {
  unlocked: string[] | null = null;
  async deriveKey(password: Uint8Array, salt: Uint8Array) {
    return fakeDerive(password, salt, 8, 1, 1);
  }
  async isValidAddress() {
    return true;
  }
  async unlock(phrase: string[]) {
    this.unlocked = phrase;
  }
  async lock() {
    this.unlocked = null;
  }
  async address(_kind: string, index: number) {
    return `nolgar1-${this.unlocked?.[0]}-${index}`;
  }
}

async function writeFixturesIfAsked() {
  if (process.env.WRITE_FIXTURES !== '1') return;
  mkdirSync(fixtures, { recursive: true });
  const envelope = await sealSeed(PHRASE, PASSWORD, fakeDerive, { mKib: 8, tCost: 1, pCost: 1 });
  const v1: ExportFile = { format: 'neptune-vault-backup', version: 1, network: 'regtest', birthdayHeight: 3, envelope, exportedAt: 1_757_000_000_000 };
  const v2: ExportFile = { ...v1, version: 2, exportedAt: 1_757_900_000_000, contacts: [{ name: 'Alice', address: 'nolgar1alice' }] };
  for (const [name, file] of [
    ['backup-v1.json', v1],
    ['backup-v2.json', v2],
  ] as const) {
    const path = join(fixtures, name);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  }
}

function fixture(name: string): ExportFile {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as ExportFile;
}

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

describe('backup files', () => {
  it('every version ever written restores', async () => {
    await writeFixturesIfAsked();
    for (const name of ['backup-v1.json', 'backup-v2.json']) {
      db = await openVaultDb();
      const core = new FakeCore();
      const service = new AccountService(db, core as unknown as WalletCore, 300_000);
      const record = await service.importFile(fixture(name), PASSWORD);
      expect(record.address0).toBe('nolgar1-w0-0');
      expect(record.birthdayHeight).toBe(3);
      expect(core.unlocked).toEqual(PHRASE);
      const contacts = await db.getAll('contacts');
      expect(contacts.map((c) => c.name)).toEqual(name === 'backup-v2.json' ? ['Alice'] : []);
      db.close();
      indexedDB.deleteDatabase('neptune-vault');
    }
  });

  it('a file from a newer version is refused with an update message, not a decode error', async () => {
    db = await openVaultDb();
    const service = new AccountService(db, new FakeCore() as unknown as WalletCore, 300_000);
    const newer = { ...fixture('backup-v2.json'), version: 99 } as unknown as ExportFile;
    await expect(service.importFile(newer, PASSWORD)).rejects.toThrow(/newer version/);
    const other = { ...fixture('backup-v2.json'), format: 'something-else' } as unknown as ExportFile;
    await expect(service.importFile(other, PASSWORD)).rejects.toThrow(/not a Neptune Vault backup/);
  });
});

describe('the database', () => {
  it('a version-1 database upgrades in place, keeping its rows', async () => {
    // Version 1 as the first release laid it out: no contacts store.
    const v1 = await openDB('neptune-vault', 1, {
      upgrade(d) {
        d.createObjectStore('accounts', { keyPath: 'id' }).createIndex('byNetwork', 'network');
        d.createObjectStore('utxos', { keyPath: 'key' }).createIndex('byAccount', 'accountId');
        d.createObjectStore('blocks', { keyPath: 'key' }).createIndex('byAccountHeight', ['accountId', 'height']);
        d.createObjectStore('history', { keyPath: 'key' }).createIndex('byAccount', 'accountId');
        d.createObjectStore('syncState', { keyPath: 'accountId' });
        d.createObjectStore('settings', { keyPath: 'id' });
      },
    });
    await v1.put('accounts', { id: 'old', network: 'regtest', createdAt: 1, birthdayHeight: 1, envelope: {}, address0: 'x', backupConfirmed: true });
    await v1.put('utxos', { key: 'old:u1', accountId: 'old', hash: 'u1', stored: {}, amountNau: '1', amount: '1', confirmedHeight: 1, confirmedTimestampMs: 0, releaseDateMs: null, spentHeight: null, spentTxid: null, pendingTxid: null });
    v1.close();

    db = await openVaultDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toContain('contacts');
    expect((await db.get('accounts', 'old'))?.address0).toBe('x');
    expect((await db.get('utxos', 'old:u1'))?.hash).toBe('u1');
  });

  it('a database from a newer version is refused with an update message', async () => {
    const newer = await openDB('neptune-vault', DB_VERSION + 50, {
      upgrade(d) {
        d.createObjectStore('accounts', { keyPath: 'id' });
      },
    });
    newer.close();
    await expect(openVaultDb()).rejects.toThrow(/newer version/);
  });
});
