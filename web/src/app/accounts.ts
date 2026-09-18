// Account lifecycle: create or import, unlock, lock, and the auto-lock
// policy (R11: five minutes idle, immediately on backgrounding).

import { FRESH_KEY_INDICES, type AccountRecord, type Network, type VaultDb } from '../storage/db';
import { changePassword as reWrapSeed, DEFAULT_KDF, extractContentKey, openSeed, openSeedWithSecret, sealSeed, wrapContentKey, type DeriveKey, type ExportFile } from '../storage/envelope';
import type { PasskeyProvider } from './passkey';
import { addressKindLabel } from '../util/address';
import type { WalletCore } from '../wallet/core';

export type LockListener = (locked: boolean) => void;

/** An unlock, create or import that was overtaken by a lock: another wallet was picked, or the app went to the background. Not a failure to report. */
export class UnlockCancelledError extends Error {
  constructor() {
    super('Interrupted: the app went to the background, or another wallet was picked. Try again.');
    this.name = 'UnlockCancelledError';
  }
}

export class AccountService {
  private unlockedId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<LockListener>();
  private visibilityHandler: (() => void) | null = null;
  // While a send is running the seed must stay loaded, so the background
  // and idle locks are deferred and applied once the send finishes.
  private lockDeferred = false;
  private lockPending = false;
  // Counts locks. Unlocking takes seconds (the password hash), and a lock
  // can arrive in the middle: the person picks another wallet, or the app
  // goes to the background. Whatever was loading then must not end up
  // unlocked under another wallet's name, or unlocked with nobody looking.
  private epoch = 0;
  private doc: Document | null = typeof document === 'undefined' ? null : document;

  constructor(
    private readonly db: VaultDb,
    private readonly core: WalletCore,
    private readonly lockTimeoutMs: number,
    private readonly passkeys: PasskeyProvider | null = null,
  ) {}

  passkeySupported(): Promise<boolean> {
    return this.passkeys ? this.passkeys.supported() : Promise.resolve(false);
  }

  /**
   * Set up passkey unlock: the password proves the account, the passkey is
   * created with user verification, and its PRF secret wraps the content
   * key. Throws WrongPasswordError for a wrong password.
   */
  async enablePasskey(accountId: string, password: string): Promise<void> {
    if (!this.passkeys) throw new Error('Passkeys are not available here');
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const contentRaw = await extractContentKey(record.envelope, password, this.derive);
    try {
      const enrolment = await this.passkeys.enrol(`Neptune Vault (${record.network})`);
      const wrappedContentKey = await wrapContentKey(contentRaw, enrolment.secret);
      enrolment.secret.fill(0);
      await this.db.put('accounts', { ...record, passkey: { credentialId: enrolment.credentialId, prfSalt: enrolment.prfSalt, wrappedContentKey } });
    } finally {
      contentRaw.fill(0);
    }
  }

  async disablePasskey(accountId: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) return;
    const { passkey: _dropped, ...rest } = record;
    await this.db.put('accounts', rest);
  }

  async unlockWithPasskey(accountId: string): Promise<void> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    if (!this.passkeys) throw new Error('Passkeys are not available here');
    const record = await this.db.get('accounts', accountId);
    if (!record?.passkey) throw new Error('No passkey is set up for this wallet');
    const secret = await this.passkeys.secret(record.passkey.credentialId, record.passkey.prfSalt);
    let phrase: string[];
    try {
      phrase = await openSeedWithSecret(record.envelope, record.passkey.wrappedContentKey, secret);
    } finally {
      secret.fill(0);
    }
    await this.load(phrase, record.network, epoch);
    this.setUnlocked(accountId);
  }

  /**
   * Hand the phrase to the core, unless a lock arrived since `epoch` was
   * read or the page is hidden; then nothing stays loaded.
   */
  private async load(phrase: string[], network: Network, epoch: number): Promise<void> {
    if (epoch !== this.epoch) throw new UnlockCancelledError();
    await this.core.unlock(phrase, network);
    const hidden = this.doc?.visibilityState === 'hidden' && !this.lockDeferred;
    if (epoch !== this.epoch || hidden) {
      await this.core.lock().catch(() => undefined);
      throw new UnlockCancelledError();
    }
  }

  private readonly derive: DeriveKey = (pw, salt, m, t, p) => this.core.deriveKey(pw, salt, m, t, p);

  get currentAccountId(): string | null {
    return this.unlockedId;
  }

  onLockChange(listener: LockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Generate a phrase for the onboarding flow; nothing is stored yet. */
  generatePhrase(): Promise<string[]> {
    return this.core.generatePhrase();
  }

  /**
   * Store a new account for `phrase` under `password` and unlock it.
   * `birthdayHeight` is where scanning starts: the current tip for a fresh
   * account, a user-supplied height (or 1) for an import.
   */
  /** "Wallet n" for the next wallet on this network, counting the ones already there. */
  private async nextName(network: Network): Promise<string> {
    const count = (await this.db.getAllFromIndex('accounts', 'byNetwork', network)).length;
    return 'Wallet ' + (count + 1);
  }

  async rename(accountId: string, name: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) throw new Error('A wallet needs a name');
    await this.db.put('accounts', { ...record, name: trimmed });
  }

  /** Proves the password opens this wallet; throws WrongPasswordError otherwise. */
  async verifyPassword(accountId: string, password: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const phrase = await openSeed(record.envelope, password, this.derive);
    phrase.fill('');
  }

  /**
   * Remove a wallet from this device: its seed, coins, history, blocks,
   * contacts and sync state, in one transaction. The funds stay on the
   * chain and the phrase restores them anywhere. Locks first when it is
   * the wallet in memory.
   */
  async deleteAccount(accountId: string): Promise<void> {
    if (this.unlockedId === accountId) await this.lock();
    const tx = this.db.transaction(['accounts', 'syncState', 'utxos', 'history', 'blocks', 'contacts'], 'readwrite');
    await tx.objectStore('accounts').delete(accountId);
    await tx.objectStore('syncState').delete(accountId);
    for (const key of await tx.objectStore('utxos').index('byAccount').getAllKeys(accountId)) await tx.objectStore('utxos').delete(key);
    for (const key of await tx.objectStore('history').index('byAccount').getAllKeys(accountId)) await tx.objectStore('history').delete(key);
    for (const key of await tx.objectStore('contacts').index('byAccount').getAllKeys(accountId)) await tx.objectStore('contacts').delete(key);
    const blockKeys = await tx.objectStore('blocks').index('byAccountHeight').getAllKeys(IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER]));
    for (const key of blockKeys) await tx.objectStore('blocks').delete(key);
    await tx.done;
  }

  async createAccount(phrase: string[], password: string, network: Network, birthdayHeight: number, options: { fastRestore?: boolean } = {}): Promise<AccountRecord> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    const name = await this.nextName(network);
    const envelope = await sealSeed(phrase, password, this.derive, DEFAULT_KDF);
    await this.load(phrase, network, epoch);
    // From here the keys are in the core. Whatever fails below, they must
    // not stay there with no lock armed.
    try {
      const address0 = await this.core.address('generation', 0);
      const record: AccountRecord = {
        id: crypto.randomUUID(),
        network,
        createdAt: Date.now(),
        birthdayHeight: Math.max(0, birthdayHeight),
        envelope,
        address0,
        nextKeyIndices: FRESH_KEY_INDICES,
        backupConfirmed: false,
        name,
        ...(options.fastRestore ? { restore: 'fast' as const } : {}),
      };
      await this.db.put('accounts', record);
      if (epoch !== this.epoch) throw new UnlockCancelledError();
      this.setUnlocked(record.id);
      return record;
    } catch (e) {
      await this.core.lock().catch(() => undefined);
      throw e;
    }
  }

  async unlock(accountId: string, password: string): Promise<void> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const phrase = await openSeed(record.envelope, password, this.derive);
    await this.load(phrase, record.network, epoch);
    this.setUnlocked(accountId);
  }

  /**
   * Change the password: the content key is re-wrapped under the new
   * password; the seed ciphertext is untouched. Throws WrongPasswordError
   * when the current password is wrong. The account stays unlocked.
   */
  async changePassword(accountId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new Error('The new password must be at least 8 characters');
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const envelope = await reWrapSeed(record.envelope, currentPassword, newPassword, this.derive, DEFAULT_KDF);
    await this.db.put('accounts', { ...record, envelope });
  }

  /**
   * Lock, whatever state things are in. It is never a no-op: an unlock may
   * be in flight with nothing marked unlocked yet, and a create or import
   * that failed half way may have left keys in the core. The screen learns
   * first, so a busy worker cannot keep the balance on show.
   */
  async lock(): Promise<void> {
    this.epoch += 1;
    this.unlockedId = null;
    this.lockPending = false;
    this.clearIdleTimer();
    for (const l of this.listeners) l(true);
    await this.core.lock();
  }

  /** Call on any user interaction to postpone the idle lock. */
  touch(): void {
    if (this.unlockedId === null) return;
    this.lockPending = false;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.requestLock(), this.lockTimeoutMs);
  }

  /**
   * Defer the automatic locks (background, idle) while a send runs; when
   * deferral ends and a lock was requested meanwhile, lock then.
   */
  setLockDeferred(deferred: boolean): void {
    this.lockDeferred = deferred;
    if (!deferred && this.lockPending) {
      this.lockPending = false;
      void this.lock();
    }
  }

  private requestLock(): void {
    if (this.lockDeferred) this.lockPending = true;
    else void this.lock();
  }

  /** Lock as soon as the page is hidden (backgrounded or tab switched). */
  installVisibilityLock(doc: Document = document): () => void {
    this.doc = doc;
    this.visibilityHandler = () => {
      if (doc.visibilityState === 'hidden') this.requestLock();
    };
    doc.addEventListener('visibilitychange', this.visibilityHandler);
    return () => {
      if (this.visibilityHandler) doc.removeEventListener('visibilitychange', this.visibilityHandler);
    };
  }

  async markBackupConfirmed(accountId: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (record) await this.db.put('accounts', { ...record, backupConfirmed: true });
  }

  /** The export file (R8). The envelope stays password-protected. */
  async exportFile(accountId: string): Promise<ExportFile> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const contacts = await this.db.getAllFromIndex('contacts', 'byAccount', accountId);
    return {
      format: 'neptune-vault-backup',
      version: 2,
      network: record.network,
      birthdayHeight: record.birthdayHeight,
      envelope: record.envelope,
      exportedAt: Date.now(),
      contacts: contacts.map((c) => ({ name: c.name, address: c.address })),
    };
  }

  /**
   * Start scanning again from `height`: local sync state, UTXOs, history
   * and block records for the account are dropped and rebuilt from the
   * chain. Funds are unaffected; only the local view is rebuilt.
   */
  async rescanFrom(accountId: string, height: number, fast = false): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const tx = this.db.transaction(['accounts', 'syncState', 'utxos', 'history', 'blocks'], 'readwrite');
    const { restore: _previous, restoredAt: _how, ...rest } = record;
    await tx.objectStore('accounts').put({ ...rest, birthdayHeight: Math.max(0, Math.floor(height)), nextKeyIndices: FRESH_KEY_INDICES, ...(fast ? { restore: 'fast' as const } : {}) });
    await tx.objectStore('syncState').delete(accountId);
    for (const key of await tx.objectStore('utxos').index('byAccount').getAllKeys(accountId)) await tx.objectStore('utxos').delete(key);
    for (const key of await tx.objectStore('history').index('byAccount').getAllKeys(accountId)) await tx.objectStore('history').delete(key);
    const blockKeys = await tx.objectStore('blocks').index('byAccountHeight').getAllKeys(IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER]));
    for (const key of blockKeys) await tx.objectStore('blocks').delete(key);
    await tx.done;
  }

  /** Record that the export file was saved (R8), for the reminder and Settings. */
  async markBackedUp(accountId: string, when = Date.now()): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (record) await this.db.put('accounts', { ...record, lastBackupAt: when });
  }

  /** Snooze the Home backup reminder for a week. */
  async dismissBackupNudge(accountId: string, when = Date.now()): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (record) await this.db.put('accounts', { ...record, backupNudgeDismissedAt: when });
  }

  /** Import an export file. The password is checked by unlocking. */
  async importFile(file: ExportFile, password: string, options: { fastRestore?: boolean } = {}): Promise<AccountRecord> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    if (file.format !== 'neptune-vault-backup') throw new Error('not a Neptune Vault backup file');
    // Every version ever written stays readable; one this app does not know
    // is from a newer app, never a reason to guess at the contents.
    if (file.version !== 1 && file.version !== 2) {
      throw new Error('This backup file was made by a newer version of Neptune Vault. Update the app, then restore it.');
    }
    // The file is someone's input: everything is looked at before any of
    // it is used, so a malformed file is refused whole and cannot leave a
    // half-made wallet or loaded keys behind.
    const network = file.network as Network;
    if (network !== 'main' && network !== 'testnet' && network !== 'regtest') throw new Error('This backup file names a network this app does not know.');
    const birthday = Number.isSafeInteger(file.birthdayHeight) && file.birthdayHeight >= 0 ? file.birthdayHeight : 1;
    const exportedAt = Number.isSafeInteger(file.exportedAt) ? file.exportedAt : Date.now();
    const listed: unknown[] = Array.isArray(file.contacts) ? file.contacts.slice(0, 5000) : [];
    const contacts = listed
      .filter((c): c is { name: string; address: string } => typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string' && typeof (c as { address?: unknown }).address === 'string')
      .map((c) => ({ name: c.name.trim().slice(0, 80), address: c.address.trim().toLowerCase() }))
      .filter((c) => c.name !== '' && c.address.length <= 8000);

    const name = await this.nextName(network);
    const phrase = await openSeed(file.envelope, password, this.derive);
    await this.load(phrase, network, epoch);
    let recordId: string | null = null;
    try {
      const address0 = await this.core.address('generation', 0);
      const record: AccountRecord = {
        id: crypto.randomUUID(),
        network,
        createdAt: Date.now(),
        birthdayHeight: Math.max(1, birthday),
        envelope: file.envelope,
        address0,
        nextKeyIndices: FRESH_KEY_INDICES,
        backupConfirmed: true,
        name,
        // The file it came from is a backup as of its export date.
        lastBackupAt: exportedAt,
        ...(options.fastRestore ? { restore: 'fast' as const } : {}),
      };
      const valid: typeof contacts = [];
      for (const c of contacts) if (await this.core.isValidAddress(c.address, network)) valid.push(c);
      // The wallet and its contacts arrive together or not at all.
      const tx = this.db.transaction(['accounts', 'contacts'], 'readwrite');
      await tx.objectStore('accounts').put(record);
      recordId = record.id;
      for (const c of valid) {
        const id = crypto.randomUUID();
        const now = Date.now();
        await tx.objectStore('contacts').put({ key: `${record.id}:${id}`, id, accountId: record.id, name: c.name, address: c.address, kind: addressKindLabel(c.address), createdAt: now, updatedAt: now });
      }
      await tx.done;
      if (epoch !== this.epoch) throw new UnlockCancelledError();
      this.setUnlocked(record.id);
      return record;
    } catch (e) {
      await this.core.lock().catch(() => undefined);
      // A cancelled import keeps the wallet it made: it is whole, only locked.
      if (recordId !== null && !(e instanceof UnlockCancelledError)) await this.deleteAccount(recordId).catch(() => undefined);
      throw e;
    }
  }

  private setUnlocked(id: string): void {
    this.unlockedId = id;
    this.touch();
    for (const l of this.listeners) l(false);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
