import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type VaultDb } from '../storage/db';
import type { SeedEnvelope } from '../storage/db';
import { openSeed, WrongPasswordError } from '../storage/envelope';
import type { WalletCore } from '../backend/types';
import { CHAIN_PARTS } from '../backend/types';
import { chainView, testEngine } from '../backend/engineForTests';
import { AccountService, UnlockCancelledError } from './accounts';
import type { PasskeyProvider } from './passkey';

class FakePasskeys implements PasskeyProvider {
  secretBytes = new Uint8Array(32).fill(42);
  async supported() { return true; }
  async enrol() { return { credentialId: 'cred', prfSalt: 'salt', secret: new Uint8Array(this.secretBytes) }; }
  async secret(credentialId: string) { if (credentialId !== 'cred') throw new Error('unknown credential'); return new Uint8Array(this.secretBytes); }
}

/** Enough of the wallet core for the account flows. */
class FakeCore implements Partial<WalletCore> {
  unlocked: string[] | null = null;
  /** Set to make the next address derivation fail, as a full disk or a broken worker would. */
  failAddress = false;
  /** Resolved by a test to let a slow password hash finish. */
  gate: Promise<void> | null = null;
  async isValidAddress(address: string) {
    return address.startsWith('nolgar1');
  }
  async generatePhrase() {
    return Array.from({ length: 18 }, (_, i) => `w${i}`);
  }
  async deriveKey(password: Uint8Array, salt: Uint8Array) {
    if (this.gate) await this.gate;
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
    if (this.failAddress) throw new Error('worker failed');
    return `nolgar1-${this.unlocked?.[0]}-${index}`;
  }
}

/** A core that lives in a worker, as the real one does: it opens envelopes itself and can be ended. */
class FakeWorkerCore extends FakeCore {
  terminated = 0;
  /** Phrases handed over by the page, which an unlock must never do. */
  phrasesFromThePage = 0;
  /** Rejects of calls in flight, so ending the worker can fail them. */
  private inFlight: ((e: Error) => void)[] = [];
  async unlock(phrase: string[]) {
    this.phrasesFromThePage += 1;
    this.unlocked = phrase;
  }
  async unlockEnvelope(envelope: SeedEnvelope, password: string) {
    const phrase = await new Promise<string[]>((resolve, reject) => {
      this.inFlight.push(reject);
      openSeed(envelope, password, (pw, salt) => this.deriveKey(pw, salt)).then(resolve, reject);
    });
    this.unlocked = phrase;
  }
  async openEnvelope(envelope: SeedEnvelope, password: string, wantPhrase: boolean) {
    const phrase = await openSeed(envelope, password, (pw, salt) => this.deriveKey(pw, salt));
    return wantPhrase ? phrase : null;
  }
  terminate() {
    this.terminated += 1;
    this.unlocked = null;
    for (const reject of this.inFlight.splice(0)) reject(new Error('wallet is locked'));
  }
  async lock(): Promise<void> {
    throw new Error('a worker core is ended, never asked to forget');
  }
}

/** A core with the engine's store, as far as the account service can tell: it records what it is asked. */
class FakeStoreCore extends FakeCore {
  moved: string[] = [];
  contentKeys = 0;
  migrations: { accountId: string; parts: string[]; dump: { accounts: unknown[]; contacts: unknown[] } }[] = [];
  commits: unknown[][] = [];
  removed: string[] = [];
  failOpen: string | null = null;
  failMigrate: string | null = null;
  /** Refuse only the migration of a group that includes this part. */
  failMigrateOf: string | null = null;
  rebuilt: string[] = [];
  async unlock(phrase: string[], _network?: string, contentKey?: Uint8Array) {
    if (contentKey) this.contentKeys += 1;
    this.unlocked = phrase;
  }
  async unlockEnvelope(envelope: SeedEnvelope, password: string) {
    this.unlocked = await openSeed(envelope, password, (pw, salt) => this.deriveKey(pw, salt));
  }
  async storeOpen() {
    if (this.failOpen) throw new Error(this.failOpen);
    return [...this.moved];
  }
  async storeMigrate(accountId: string, parts: string[], dump: { accounts: unknown[]; contacts: unknown[] }) {
    if (this.failMigrate) throw new Error(this.failMigrate);
    if (this.failMigrateOf && parts.includes(this.failMigrateOf)) throw new Error(`migrate: ${this.failMigrateOf} did not come through unchanged`);
    this.migrations.push({ accountId, parts, dump });
    this.moved.push(...parts);
  }
  async storeRead() {
    return [];
  }
  async storeCommit(_accountId: string, changes: unknown[]) {
    this.commits.push(changes);
  }
  async storeRemove(accountId: string) {
    this.removed.push(accountId);
  }
  async storeRebuild(accountId: string) {
    this.rebuilt.push(accountId);
    this.moved.push(...CHAIN_PARTS);
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

describe('the engine store, as the account service drives it', () => {
  async function withStore() {
    db = await openVaultDb();
    const core = new FakeStoreCore();
    const service = new AccountService(db, core as unknown as WalletCore, 5 * 60 * 1000);
    return { core, service };
  }

  it('hands a new wallet its content key, opens its log, and moves its contacts over', async () => {
    const { core, service } = await withStore();
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect(core.contentKeys).toBe(1);
    // Contacts on their own, and the chain as one batch: the parts the sync writes together.
    expect(core.migrations.map((m) => m.parts)).toEqual([['contacts'], CHAIN_PARTS]);
    expect(service.engine.where(record.id, 'contacts')).toBe('engine');
  });

  it('moves what the database holds when an existing wallet is unlocked, once', async () => {
    const { core, service } = await withStore();
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    await service.lock();
    core.moved = [];
    core.migrations = [];
    await db.put('contacts', { key: `${record.id}:1`, id: '1', accountId: record.id, name: 'Al', address: 'nolgar1al', kind: 'k', createdAt: 1, updatedAt: 1 });
    await db.put('contacts', { key: 'someone-else:1', id: '1', accountId: 'someone-else', name: 'Not mine', address: 'nolgar1x', kind: 'k', createdAt: 1, updatedAt: 1 });

    await service.unlock(record.id, 'pw');
    expect(core.migrations).toHaveLength(2);
    const contacts = core.migrations.find((m) => m.parts.includes('contacts'))!;
    expect(contacts.dump.contacts).toHaveLength(1);
    expect(contacts.dump.accounts).toHaveLength(1);

    await service.lock();
    expect(() => service.engine.where(record.id, 'contacts')).toThrow('wallet is locked');
    await service.unlock(record.id, 'pw');
    expect(core.migrations).toHaveLength(2);
  });

  it('a chain that will not move is rebuilt from the chain, and says so', async () => {
    const { core, service } = await withStore();
    core.failMigrateOf = 'utxos';
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect(core.rebuilt).toEqual([record.id]);
    expect(service.engine.where(record.id, 'utxos')).toBe('engine');
    expect(service.engine.where(record.id, 'contacts'), 'contacts moved on their own').toBe('engine');
    expect(service.engine.problems(record.id)[0]).toMatch(/rebuilt from the chain.*utxos did not come through/);
  });

  it('a part that will not move stays in the database, and the wallet opens all the same', async () => {
    const { core, service } = await withStore();
    core.failMigrate = 'migrate: contact x:9 is not in a shape this build knows';
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect(service.currentAccountId).toBe(record.id);
    expect(service.engine.where(record.id, 'contacts')).toBe('database');
    expect(service.engine.problems(record.id)[0]).toContain('x:9');
  });

  it('a log that will not open does not lock anyone out of their wallet', async () => {
    const { core, service } = await withStore();
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    await service.lock();
    core.failOpen = 'the disk is full';
    await service.unlock(record.id, 'pw');
    expect(service.currentAccountId).toBe(record.id);
    // But its contacts are not guessed at from the rows left behind.
    expect(() => service.engine.where(record.id, 'contacts')).toThrow('the disk is full');
    expect(service.engine.describe(record.id, 'contacts')).toBe('Not readable');
  });

  it('deleting a wallet drops its log, locked or not', async () => {
    const { core, service } = await withStore();
    const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    await service.lock();
    await service.deleteAccount(record.id);
    expect(core.removed).toEqual([record.id]);
  });
});

describe('account service', () => {
  it('names wallets in order per network, renames, and removes one without touching another', async () => {
    const { service } = await setup();
    const first = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    const second = await service.createAccount(['x0', ...Array.from({ length: 17 }, (_, i) => 'x' + (i + 1))], 'pw2', 'regtest', 1);
    const elsewhere = await service.createAccount(await service.generatePhrase(), 'pw', 'testnet', 1);
    expect(first.name).toBe('Wallet 1');
    expect(second.name).toBe('Wallet 2');
    expect(elsewhere.name).toBe('Wallet 1');

    await service.rename(second.id, '  Savings  ');
    expect((await db.get('accounts', second.id))?.name).toBe('Savings');
    await expect(service.rename(second.id, '   ')).rejects.toThrow(/name/);

    for (const id of [first.id, second.id]) {
      await db.put('utxos', { key: id + ':u', accountId: id, hash: 'u', stored: {}, amountNau: '1', amount: '1', confirmedHeight: 1, confirmedTimestampMs: 0, releaseDateMs: null, spentHeight: null, spentTxid: null, pendingTxid: null });
      await db.put('history', { key: id + ':h', accountId: id, kind: 'received', status: 'confirmed', txid: '', amountNau: '1', feeNau: null, timestampMs: 0, height: 1, inputHashes: [], recipient: null, error: null, changeNau: null });
      await db.put('blocks', { key: id + ':1', accountId: id, height: 1, hash: 'b', prevHash: 'a', timestampMs: 0 });
      await db.put('contacts', { key: id + ':c', id: 'c', accountId: id, name: 'Al', address: 'nolgar1x', kind: 'Standard', createdAt: 0, updatedAt: 0 });
      await db.put('syncState', { accountId: id, syncedHeight: 1, syncedHash: 'b', updatedAt: 0 });
    }

    await service.verifyPassword(second.id, 'pw2');
    await expect(service.verifyPassword(second.id, 'pw')).rejects.toBeInstanceOf(WrongPasswordError);

    // The second wallet is the one in memory; removing it locks.
    expect(service.currentAccountId).toBe(elsewhere.id);
    await service.unlock(second.id, 'pw2');
    await service.deleteAccount(second.id);
    expect(service.currentAccountId).toBeNull();
    expect(await db.get('accounts', second.id)).toBeUndefined();
    expect(await db.get('syncState', second.id)).toBeUndefined();
    expect(await db.getAllFromIndex('utxos', 'byAccount', second.id)).toEqual([]);
    expect(await db.getAllFromIndex('history', 'byAccount', second.id)).toEqual([]);
    expect(await db.getAllFromIndex('contacts', 'byAccount', second.id)).toEqual([]);
    expect(await db.getAllFromIndex('blocks', 'byAccountHeight', IDBKeyRange.bound([second.id, 0], [second.id, Number.MAX_SAFE_INTEGER]))).toEqual([]);
    // The first wallet keeps everything.
    expect((await db.getAllFromIndex('utxos', 'byAccount', first.id)).length).toBe(1);
    expect((await db.getAllFromIndex('contacts', 'byAccount', first.id)).length).toBe(1);
    expect(await db.get('syncState', first.id)).toBeDefined();
    // The next wallet on that network is named after the ones left.
    const third = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect(third.name).toBe('Wallet 2');
  });

  it('an unlock overtaken by a lock loads nothing: picking another wallet mid-unlock cannot open it', async () => {
    const { core, service } = await setup();
    const a = await service.createAccount(await service.generatePhrase(), 'pw-a', 'regtest', 1);
    await service.lock();
    const states: boolean[] = [];
    service.onLockChange((locked) => states.push(locked));

    let open!: () => void;
    core.gate = new Promise((r) => (open = r));
    const unlocking = service.unlock(a.id, 'pw-a');
    // The person picks another wallet while the password is being hashed.
    await service.lock();
    open();
    await expect(unlocking).rejects.toBeInstanceOf(UnlockCancelledError);
    expect(core.unlocked).toBeNull();
    expect(service.currentAccountId).toBeNull();
    expect(states).not.toContain(false);
  });

  it('an unlock that finishes while the page is hidden locks at once', async () => {
    const { core, service } = await setup();
    const a = await service.createAccount(await service.generatePhrase(), 'pw-a', 'regtest', 1);
    await service.lock();
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } as unknown as Document;
    service.installVisibilityLock(doc);
    let open!: () => void;
    core.gate = new Promise((r) => (open = r));
    const unlocking = service.unlock(a.id, 'pw-a');
    (doc as { visibilityState: string }).visibilityState = 'hidden';
    open();
    await expect(unlocking).rejects.toBeInstanceOf(UnlockCancelledError);
    expect(core.unlocked).toBeNull();
  });

  it('a create that fails half way leaves no keys loaded, and a malformed backup file leaves no wallet', async () => {
    const { core, service } = await setup();
    core.failAddress = true;
    await expect(service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1)).rejects.toThrow(/worker failed/);
    expect(core.unlocked).toBeNull();
    core.failAddress = false;

    const made = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    const file = await service.exportFile(made.id, 'pw');
    await service.lock();
    const before = (await db.getAll('accounts')).length;

    // Contacts that are not contacts are skipped; the rest of the file is used.
    // An older-format file, where contacts sit in clear and anything may be in them.
    const legacy = { format: file.format, version: 2, network: file.network, birthdayHeight: file.birthdayHeight, exportedAt: file.exportedAt, envelope: (await db.get('accounts', made.id))!.envelope };
    const odd = { ...legacy, contacts: [{ name: 1, address: 1 }, null, { name: 'Al', address: 'nolgar1good' }, { name: 'Bo', address: 'elsewhere1' }] } as never;
    const imported = await service.importFile(odd, 'pw');
    expect((await db.getAllFromIndex('contacts', 'byAccount', imported.id)).map((c) => c.name)).toEqual(['Al']);
    await service.lock();

    // A network the app does not know is refused before anything is touched.
    await expect(service.importFile({ ...file, network: 'moon' } as never, 'pw')).rejects.toThrow(/network/);
    // A failure after the keys are loaded unloads them and leaves no wallet behind.
    core.failAddress = true;
    await expect(service.importFile(file, 'pw')).rejects.toThrow(/worker failed/);
    expect(core.unlocked).toBeNull();
    expect((await db.getAll('accounts')).length).toBe(before + 1);
  });

  it('shows the seed phrase only to the password, unlocked or not', async () => {
    const { service } = await setup();
    const words = await service.generatePhrase();
    const made = await service.createAccount(words, 'right-pw', 'regtest', 1);
    expect(service.currentAccountId).toBe(made.id);
    await expect(service.revealPhrase(made.id, 'wrong-pw')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await service.revealPhrase(made.id, 'right-pw')).toEqual(words);
  });

  it('lock ends the worker, and an unlock opens the envelope inside it', async () => {
    db = await openVaultDb();
    const core = new FakeWorkerCore();
    const service = new AccountService(db, core as unknown as WalletCore, 5 * 60 * 1000);
    const words = await service.generatePhrase();
    const made = await service.createAccount(words, 'pw', 'regtest', 1);
    // Creating hands the new words over once: they were on the page to be written down.
    expect(core.phrasesFromThePage).toBe(1);

    await service.lock();
    expect(core.terminated).toBe(1);
    expect(core.unlocked).toBeNull();

    await service.unlock(made.id, 'pw');
    expect(core.unlocked).toEqual(words);
    expect(core.phrasesFromThePage).toBe(1);
    await expect(service.unlock(made.id, 'nope')).rejects.toBeInstanceOf(WrongPasswordError);
    await service.verifyPassword(made.id, 'pw');
    expect(await service.revealPhrase(made.id, 'pw')).toEqual(words);
  });

  it('a lock that ends the worker mid-unlock reads as cancelled, not as a failure', async () => {
    db = await openVaultDb();
    const core = new FakeWorkerCore();
    const service = new AccountService(db, core as unknown as WalletCore, 5 * 60 * 1000);
    const made = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    await service.lock();
    let open!: () => void;
    core.gate = new Promise((r) => (open = r));
    const unlocking = service.unlock(made.id, 'pw');
    await new Promise((r) => setTimeout(r, 5));
    await service.lock();
    open();
    await expect(unlocking).rejects.toBeInstanceOf(UnlockCancelledError);
    expect(core.unlocked).toBeNull();
  });

  it('locks by the wall clock, so time that passed while the device slept counts', async () => {
    const { core, service } = await setup(60_000);
    await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    const realNow = Date.now;
    try {
      // The device sleeps for ten minutes: no timer fires, the clock moves.
      Date.now = () => realNow() + 10 * 60_000;
      // It wakes, and the app comes back into view.
      service.lockIfIdle();
      await new Promise((r) => setTimeout(r, 5));
      expect(core.unlocked).toBeNull();
      expect(service.currentAccountId).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('a password change does not undo what the sync wrote meanwhile, and is not undone by it', async () => {
    const { core, service } = await setup();
    const made = await service.createAccount(await service.generatePhrase(), 'old-password', 'regtest', 1);
    // The sync writes key indices while the new password is being hashed.
    let open!: () => void;
    const changing = (async () => {
      core.gate = new Promise((r) => (open = r));
      return service.changePassword(made.id, 'old-password', 'new-password');
    })();
    await new Promise((r) => setTimeout(r, 5));
    await db.put('accounts', { ...(await db.get('accounts', made.id))!, nextKeyIndices: { generation: 9, ec_hybrid: 2, viewing: 1 }, birthdayHeight: 77 });
    open();
    core.gate = null;
    await changing;
    const after = (await db.get('accounts', made.id))!;
    expect(after.nextKeyIndices).toEqual({ generation: 9, ec_hybrid: 2, viewing: 1 });
    expect(after.birthdayHeight).toBe(77);
    await service.lock();
    await service.unlock(made.id, 'new-password');
    await service.lock();
    await expect(service.unlock(made.id, 'old-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('lock always reaches the core, even when nothing is marked unlocked', async () => {
    const { core, service } = await setup();
    core.unlocked = ['left', 'behind'];
    await service.lock();
    expect(core.unlocked).toBeNull();
  });

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

  it('enables passkey unlock, unlocks with it, survives a password change, and turns off', async () => {
    db = await openVaultDb();
    const core = new FakeCore();
    const passkeys = new FakePasskeys();
    const service = new AccountService(db, core as unknown as WalletCore, 5 * 60 * 1000, passkeys);
    const record = await service.createAccount(await service.generatePhrase(), 'pw-one', 'regtest', 1);
    await expect(service.enablePasskey(record.id, 'wrong')).rejects.toThrow(WrongPasswordError);
    await service.enablePasskey(record.id, 'pw-one');
    expect((await db.get('accounts', record.id))?.passkey?.credentialId).toBe('cred');
    await service.lock();
    await service.unlockWithPasskey(record.id);
    expect(service.currentAccountId).toBe(record.id);
    await service.changePassword(record.id, 'pw-one', 'pw-two-long');
    await service.lock();
    await service.unlockWithPasskey(record.id);
    expect(service.currentAccountId).toBe(record.id);
    await service.disablePasskey(record.id);
    expect((await db.get('accounts', record.id))?.passkey).toBeUndefined();
    await expect(service.unlockWithPasskey(record.id)).rejects.toThrow('No passkey');
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

  it('rescans from a block by dropping the local view, in the engine', async () => {
    db = await openVaultDb();
    const vault = await testEngine();
    try {
      // The core's keys faked, its store the real engine's; unlocking hands the engine the content key.
      const core = Object.assign(new FakeCore(), vault.store, {
        async unlock(this: FakeCore, phrase: string[], _network?: string, contentKey?: Uint8Array) {
          this.unlocked = phrase;
          vault.unlock(contentKey);
        },
      });
      const service = new AccountService(db, core as unknown as WalletCore, 5 * 60 * 1000);
      const record = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 40);
      const view = chainView(vault, db, record.id);
      await view.put('syncState', { accountId: record.id, syncedHeight: 50, syncedHash: 'h', updatedAt: 1 });
      await view.put('history', { key: `${record.id}:recv:x`, accountId: record.id, kind: 'received', status: 'confirmed', txid: '', amountNau: '1', feeNau: null, timestampMs: 1, height: 45, inputHashes: [], recipient: null, error: null });
      await view.put('blocks', { key: `${record.id}:45`, accountId: record.id, height: 45, hash: 'b', prevHash: 'a', timestampMs: 1 });

      await service.rescanFrom(record.id, 44);
      expect((await view.get('accounts', record.id))?.birthdayHeight).toBe(44);
      expect(await view.get('syncState', record.id)).toBeUndefined();
      expect(await view.getAllFromIndex('history')).toEqual([]);
      expect(await view.getAllFromIndex('blocks')).toEqual([]);
    } finally {
      vault.close();
    }
  });

  it('records the last backup on export and on import', async () => {
    const { service } = await setup();
    const created = await service.createAccount(await service.generatePhrase(), 'pw', 'regtest', 1);
    expect((await db.get('accounts', created.id))?.lastBackupAt).toBeUndefined();
    const file = await service.exportFile(created.id, 'pw');
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
    await expect(service.exportFile(created.id, 'not-it')).rejects.toBeInstanceOf(WrongPasswordError);
    const file = await service.exportFile(created.id, 'pw');
    expect(file.format).toBe('neptune-vault-backup');
    expect(file.version).toBe(3);
    // Nothing of the contacts is readable in the file.
    expect('contacts' in file).toBe(false);
    expect(file.birthdayHeight).toBe(7);

    await service.lock();
    await expect(service.importFile(file, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    const imported = await service.importFile(file, 'pw');
    expect(imported.id).not.toBe(created.id);
    expect(imported.address0).toBe(created.address0);
    expect(imported.backupConfirmed).toBe(true);
  });
});
