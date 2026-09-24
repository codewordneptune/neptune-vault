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
import type { WalletCore } from '../backend/types';
import { DB_VERSION, openVaultDb, type VaultDb } from './db';
import { BackupAlteredError, sealBackup, sealSeed, WrongPasswordError, type DeriveKey, type ExportFile, type SealedExportFile } from './envelope';

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
  const v3 = await sealBackup({ network: 'regtest', birthdayHeight: 3, exportedAt: 1_758_200_000_000 }, envelope, { contacts: [{ name: 'Alice', address: 'nolgar1alice' }] }, PASSWORD, fakeDerive);
  for (const [name, file] of [
    ['backup-v1.json', v1],
    ['backup-v2.json', v2],
    ['backup-v3.json', v3],
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
    for (const name of ['backup-v1.json', 'backup-v2.json', 'backup-v3.json']) {
      db = await openVaultDb();
      const core = new FakeCore();
      const service = new AccountService(db, core as unknown as WalletCore, 300_000);
      const record = await service.importFile(fixture(name), PASSWORD);
      expect(record.address0).toBeUndefined();
      expect(record.birthdayHeight).toBe(3);
      expect(core.unlocked).toEqual(PHRASE);
      const contacts = await db.getAll('contacts');
      expect(contacts.map((c) => c.name)).toEqual(name === 'backup-v1.json' ? [] : ['Alice']);
      db.close();
      indexedDB.deleteDatabase('neptune-vault');
    }
  });

  it('a version 3 file shows nothing of the contacts, and any change to it stops the restore', async () => {
    const file = fixture('backup-v3.json') as SealedExportFile;
    expect(JSON.stringify(file)).not.toContain('Alice');
    expect(JSON.stringify(file)).not.toContain('nolgar1alice');

    const attempts: [string, unknown][] = [
      ['the start block raised, so a restore would come up empty', { ...file, birthdayHeight: 999_999 }],
      ['the network flipped', { ...file, network: 'main' }],
      ['the export date changed', { ...file, exportedAt: file.exportedAt + 1 }],
      ['the sealed part swapped for nothing', { ...file, sealed: undefined }],
      ['contacts added in clear, as an older file had them', { ...file, sealed: undefined, contacts: [{ name: 'Alice', address: 'nolgar1mallory' }] }],
      ['the file key swapped for another', { ...file, envelope: { ...file.envelope, boundContentKey: { ...file.envelope.boundContentKey, iv: file.sealed.iv } } }],
      ['the sealed part damaged', { ...file, sealed: { iv: file.sealed.iv, ciphertext: file.sealed.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } }],
    ];
    for (const [what, altered] of attempts) {
      db = await openVaultDb();
      const core = new FakeCore();
      const service = new AccountService(db, core as unknown as WalletCore, 300_000);
      await expect(service.importFile(altered as ExportFile, PASSWORD), what).rejects.toBeInstanceOf(BackupAlteredError);
      // Nothing was made and no key was loaded.
      expect(await db.getAll('accounts'), what).toEqual([]);
      expect(core.unlocked, what).toBeNull();
      db.close();
      indexedDB.deleteDatabase('neptune-vault');
    }

    // A wrong password is still told apart from an altered file.
    db = await openVaultDb();
    const service = new AccountService(db, new FakeCore() as unknown as WalletCore, 300_000);
    await expect(service.importFile(file, 'not-the-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('a version 3 file cannot be passed off as an older one to get its checks skipped', async () => {
    // The attacker's best move: relabel the file as version 2, whose contacts
    // and start block nothing protects, and dress its envelope as an older
    // one. The older reader then takes the file key for the content key, and
    // the seed does not open under it, whatever the password.
    const file = fixture('backup-v3.json') as SealedExportFile;
    const dressed = {
      format: file.format,
      version: 2,
      network: file.network,
      birthdayHeight: 999_999,
      exportedAt: file.exportedAt,
      envelope: { version: 1, kdf: file.envelope.kdf, wrappedContentKey: file.envelope.wrappedFileKey, seed: file.envelope.seed },
      contacts: [{ name: 'Alice', address: 'nolgar1mallory' }],
    } as unknown as ExportFile;
    db = await openVaultDb();
    const core = new FakeCore();
    const service = new AccountService(db, core as unknown as WalletCore, 300_000);
    await expect(service.importFile(dressed, PASSWORD)).rejects.toThrow(/damaged or has been changed/);
    expect(await db.getAll('accounts')).toEqual([]);
    expect(await db.getAll('contacts')).toEqual([]);
    expect(core.unlocked).toBeNull();
  });

  it('carries contacts with addresses as long as real ones', async () => {
    db = await openVaultDb();
    const service = new AccountService(db, new FakeCore() as unknown as WalletCore, 300_000);
    const made = await service.importFile(fixture('backup-v3.json'), PASSWORD);
    // A Standard (Generation) address is about 3,500 characters.
    for (let i = 0; i < 40; i++) {
      const address = 'nolgar1' + String(i).padStart(3, '0') + 'q'.repeat(3500);
      await db.put('contacts', { key: `${made.id}:long${i}`, id: `long${i}`, accountId: made.id, name: `Contact ${i}`, address, kind: 'Standard (Generation)', createdAt: 1, updatedAt: 1 });
    }
    const file = await service.exportFile(made.id, PASSWORD);
    await service.lock();
    // As the restore screen reads it: from text, through the strict reader.
    const { parseBackupFile } = await import('./envelope');
    const back = await service.importFile(parseBackupFile(JSON.stringify(file, null, 2)), PASSWORD);
    expect((await db.getAllFromIndex('contacts', 'byAccount', back.id)).length).toBe(41);
  });

  it('what a version 3 file restores unlocks with the same password afterwards', async () => {
    db = await openVaultDb();
    const core = new FakeCore();
    const service = new AccountService(db, core as unknown as WalletCore, 300_000);
    const record = await service.importFile(fixture('backup-v3.json'), PASSWORD);
    // The database holds an ordinary envelope, not the file's.
    expect(record.envelope.version).toBe(1);
    expect('wrappedContentKey' in record.envelope).toBe(true);
    await service.lock();
    await service.unlock(record.id, PASSWORD);
    expect(core.unlocked).toEqual(PHRASE);
    // And a fresh export of it restores again.
    const again = await service.exportFile(record.id, PASSWORD);
    await service.lock();
    const second = await service.importFile(again, PASSWORD);
    expect((await db.getAllFromIndex('contacts', 'byAccount', second.id)).map((c) => c.name)).toEqual(['Alice']);
  });
  it('an envelope with weaker settings than the default is wrapped again at the default once it has been opened', async () => {
    db = await openVaultDb();
    const service = new AccountService(db, new FakeCore() as unknown as WalletCore, 300_000);
    // The fixtures were made with the cheapest settings there are.
    const record = await service.importFile(fixture('backup-v2.json'), PASSWORD);
    expect(record.envelope.kdf.mKib).toBe(8);
    for (let i = 0; i < 50 && (await db.get('accounts', record.id))?.envelope.kdf.mKib === 8; i++) await new Promise((r) => setTimeout(r, 10));
    const stored = (await db.get('accounts', record.id))!.envelope;
    expect(stored.kdf.mKib).toBe(64 * 1024);
    expect(stored.kdf.tCost).toBe(3);
    // The seed's own ciphertext is untouched, and the password still opens it.
    expect(stored.seed).toEqual(record.envelope.seed);
    await service.lock();
    await service.unlock(record.id, PASSWORD);
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
