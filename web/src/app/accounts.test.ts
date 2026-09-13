import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type VaultDb } from '../storage/db';
import { WrongPasswordError } from '../storage/envelope';
import type { WalletCore } from '../wallet/core';
import { AccountService } from './accounts';

/** Enough of the wallet core for the account flows. */
class FakeCore implements Partial<WalletCore> {
  unlocked: string[] | null = null;
  async generatePhrase() {
    return Array.from({ length: 18 }, (_, i) => `w${i}`);
  }
  async deriveKey(password: Uint8Array, salt: Uint8Array) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (password[i % password.length] ?? 0) ^ salt[i % salt.length] ^ i;
    return out;
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

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

async function setup(lockTimeoutMs = 5 * 60 * 1000) {
  db = await openVaultDb();
  const core = new FakeCore();
  const service = new AccountService(db, core as unknown as WalletCore, lockTimeoutMs);
  return { core, service };
}

describe('account service', () => {
  it('creates, locks, and unlocks an account with the password', async () => {
    const { core, service } = await setup();
    const phrase = await service.generatePhrase();
    const record = await service.createAccount(phrase, 'pw', 'regtest', 12);
    expect(record.birthdayHeight).toBe(12);
    expect(record.address0).toBe('nolgar1-w0-0');
    expect(record.backupConfirmed).toBe(false);
    expect(service.currentAccountId).toBe(record.id);
    expect(core.unlocked).toEqual(phrase);

    await service.lock();
    expect(service.currentAccountId).toBeNull();
    expect(core.unlocked).toBeNull();

    await expect(service.unlock(record.id, 'nope')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(core.unlocked).toBeNull();
    await service.unlock(record.id, 'pw');
    expect(core.unlocked).toEqual(phrase);
  });

  it('locks after the idle timeout and on backgrounding', async () => {
    // Real timers: fake ones stall fake-indexeddb, which schedules its work
    // with them.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { service } = await setup(120);
    const locks: boolean[] = [];
    service.onLockChange((locked) => locks.push(locked));
    await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect(locks).toEqual([false]);

    await sleep(80);
    service.touch();
    await sleep(80);
    expect(service.currentAccountId).not.toBeNull();
    await sleep(100);
    expect(service.currentAccountId).toBeNull();
    expect(locks).toEqual([false, true]);

    await service.unlock((await db.getAll('accounts'))[0].id, 'pw');
    const doc = { visibilityState: 'visible', listeners: [] as Array<() => void>, addEventListener(_: string, f: () => void) { this.listeners.push(f); }, removeEventListener() {} };
    service.installVisibilityLock(doc as unknown as Document);
    doc.visibilityState = 'hidden';
    for (const f of doc.listeners) f();
    await sleep(10);
    expect(service.currentAccountId).toBeNull();
  });

  it('defers the background lock while a send runs, then locks', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { service } = await setup(5 * 60 * 1000);
    await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    const doc = { visibilityState: 'visible', listeners: [] as Array<() => void>, addEventListener(_: string, f: () => void) { this.listeners.push(f); }, removeEventListener() {} };
    service.installVisibilityLock(doc as unknown as Document);

    service.setLockDeferred(true);
    doc.visibilityState = 'hidden';
    for (const f of doc.listeners) f();
    await sleep(10);
    expect(service.currentAccountId).not.toBeNull();

    service.setLockDeferred(false);
    await sleep(10);
    expect(service.currentAccountId).toBeNull();
  });

  it('changes the password and keeps the seed', async () => {
    const { service } = await setup();
    const phrase = await service.generatePhrase();
    const record = await service.createAccount(phrase, 'old-password', 'regtest', 1);
    await expect(service.changePassword(record.id, 'wrong', 'new-password')).rejects.toThrow(WrongPasswordError);
    await expect(service.changePassword(record.id, 'old-password', 'short')).rejects.toThrow('at least 8');
    await service.changePassword(record.id, 'old-password', 'new-password');
    await service.lock();
    await expect(service.unlock(record.id, 'old-password')).rejects.toThrow(WrongPasswordError);
    await service.unlock(record.id, 'new-password');
    expect(service.currentAccountId).toBe(record.id);
  });

  it('records the last backup on export and on import', async () => {
    const { service } = await setup();
    const created = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect((await db.get('accounts', created.id))?.lastBackupAt).toBeUndefined();
    const file = await service.exportFile(created.id);
    await service.markBackedUp(created.id, file.exportedAt);
    expect((await db.get('accounts', created.id))?.lastBackupAt).toBe(file.exportedAt);
    const imported = await service.importFile(file, 'pw');
    expect(imported.lastBackupAt).toBe(file.exportedAt);
    await service.dismissBackupNudge(created.id, 123);
    expect((await db.get('accounts', created.id))?.backupNudgeDismissedAt).toBe(123);
  });

  it('exports and imports a backup file', async () => {
    const { service } = await setup();
    const phrase = await service.generatePhrase();
    const created = await service.createAccount(phrase, 'pw', 'regtest', 7);
    const file = await service.exportFile(created.id);
    expect(file.format).toBe('neptune-vault-backup');
    expect(file.birthdayHeight).toBe(7);

    await service.lock();
    await expect(service.importFile(file, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    const imported = await service.importFile(file, 'pw');
    expect(imported.id).not.toBe(created.id);
    expect(imported.address0).toBe(created.address0);
    expect(imported.backupConfirmed).toBe(true);
  });
});
