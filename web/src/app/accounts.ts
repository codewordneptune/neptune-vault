// Account lifecycle: create or import, unlock, lock, and the auto-lock
// policy: after an idle time the person chooses (five minutes unless
// changed, and immediately on backgrounding).

import { FRESH_KEY_INDICES, walletName, type AccountRecord, type ContactRecord, type Network, type SeedEnvelope, type SendFailure, type VaultDb } from '../storage/db';

/** The private note, in a wallet's sealed log, about its last failed send. */
const LAST_SEND_FAILURE = 'lastSendFailure';
const LAST_SEND = 'lastSend';
import { assertEnvelope, changePassword as reWrapSeed, DEFAULT_KDF, extractContentKey, isWeakerThanDefault, openBackup, openSeed, openSeedWithSecret, sealBackup, sealSeedKeepingKey, wrapContentKey, type DeriveKey, type ExportFile } from '../storage/envelope';
import { CHAIN_PARTS, ENGINE_PARTS, type WalletPart } from '../backend/types';
import { EngineParts } from './engineParts';
import type { PasskeyProvider } from './passkey';
import { addressKindLabel } from '../util/address';
import { distinctNames } from './contacts';
import type { WalletCore } from '../backend/types';
import type { LastSend } from './send';

export type LockListener = (locked: boolean) => void;

/** An unlock, create or import that was overtaken by a lock: another wallet was picked, or the app went to the background. Not a failure to report. */
export class UnlockCancelledError extends Error {
  constructor() {
    super('Interrupted: the app went to the background, or another wallet was picked. Try again.');
    this.name = 'UnlockCancelledError';
  }
}

/**
 * The idle times a person can choose. No "never": a wallet in a browser left
 * unlocked on a shared or lost device is what the lock is there for, and
 * locking on backgrounding stays whatever is chosen here.
 */
/** A wallet name already used by another wallet on the same network, where the two would share a menu. */
export class WalletNameTakenError extends Error {
  constructor(readonly taken: string) {
    super(`Another wallet here is called ${taken}.`);
    this.name = 'WalletNameTakenError';
  }
}

/** Longest name a wallet can have; longer ones are cut. */
export const WALLET_NAME_MAX = 40;

/**
 * "Wallet n" for a new wallet: the lowest n no wallet in `names` uses.
 * Counting the wallets instead would repeat a name once an earlier one was
 * removed: two of two, remove Wallet 1, add one, and there were two Wallet 2s.
 */
export function nextWalletName(names: string[]): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`wallet ${n}`)) n += 1;
  return `Wallet ${n}`;
}

/** The name in `names` that `name` would repeat, ignoring case and outer spaces, or null. */
export function clashingName(name: string, names: string[]): string | null {
  const wanted = name.trim().toLowerCase();
  return names.find((n) => n.trim().toLowerCase() === wanted) ?? null;
}

export const LOCK_CHOICES_MS = [1, 5, 15, 30].map((minutes) => minutes * 60 * 1000);
export const DEFAULT_LOCK_MS = 5 * 60 * 1000;
/** A stored idle time, or the default when it is not one of the choices. */
export function lockTimeoutOf(ms: number | undefined): number {
  return ms !== undefined && LOCK_CHOICES_MS.includes(ms) ? ms : DEFAULT_LOCK_MS;
}

export class AccountService {
  private unlockedId: string | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** When the person last did something, by the wall clock. */
  private lastActivityAt = 0;
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
    private lockTimeoutMs: number,
    private readonly passkeys: PasskeyProvider | null = null,
    /** Which parts of the unlocked wallet the engine holds; shared with the services that read them. */
    readonly engine: EngineParts = new EngineParts(typeof core.storeOpen === 'function'),
  ) {}

  /**
   * Open the unlocked wallet's sealed log, and move over any part the app
   * now reads from the engine that is still in the database. A part moves
   * only if it comes through unchanged, record for record; one that does
   * not stays where it was, and the wallet works as before.
   */
  private async openStore(accountId: string): Promise<void> {
    if (!this.core.storeOpen || !this.core.storeMigrate) return;
    let moved: WalletPart[];
    try {
      moved = await this.core.storeOpen(accountId);
    } catch (e) {
      // The wallet still unlocks. See EngineParts.unopenable.
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`The sealed log of wallet ${accountId} did not open: ${why}`);
      this.engine.unopenable(accountId, why);
      return;
    }
    // Parts written together move together, in one batch, or not at all.
    const groups = [ENGINE_PARTS.filter((p) => !CHAIN_PARTS.includes(p)).map((p) => [p]), ENGINE_PARTS.some((p) => CHAIN_PARTS.includes(p)) ? [CHAIN_PARTS] : []].flat();
    for (const parts of groups) {
      if (parts.every((p) => moved.includes(p))) continue;
      const dump = await this.dump(accountId, parts);
      try {
        await this.core.storeMigrate(accountId, parts, dump);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // The chain is the truth about coins, so a chain that will not move
        // is rebuilt from it rather than left unreadable. Nothing is deleted.
        if (parts.some((p) => CHAIN_PARTS.includes(p)) && this.core.storeRebuild) {
          try {
            await this.core.storeRebuild(accountId, dump);
            console.warn(`The coins and history of wallet ${accountId} are being rebuilt from the chain: ${why}`);
            this.engine.rebuilding(accountId, why);
            continue;
          } catch {
            // Neither moved nor rebuilt: say why it did not move.
          }
        }
        console.warn(`The ${parts.join(', ')} of wallet ${accountId} stay in the database: ${why}`);
        for (const part of parts) this.engine.stays(accountId, part, why);
      }
    }
    this.engine.opened(accountId, await this.core.storeOpen(accountId));
  }

  /** What the database holds of one part of one wallet, for the engine to take over and check itself against. */
  private async dump(accountId: string, parts: WalletPart[]): Promise<unknown> {
    const accounts = [await this.db.get('accounts', accountId)];
    const dump: Record<string, unknown> = { accounts };
    for (const part of parts) {
      if (part === 'contacts') dump.contacts = await this.db.getAllFromIndex('contacts', 'byAccount', accountId);
      else if (part === 'utxos') dump.utxos = await this.db.getAllFromIndex('utxos', 'byAccount', accountId);
      else if (part === 'history') dump.history = await this.db.getAllFromIndex('history', 'byAccount', accountId);
      else if (part === 'blocks') dump.blocks = await this.db.getAllFromIndex('blocks', 'byAccountHeight', IDBKeyRange.bound([accountId, 0], [accountId, Infinity]));
      else if (part === 'sync') dump.syncState = [await this.db.get('syncState', accountId)].filter(Boolean);
      else if (part === 'scan') continue; // Read from the account record, which is always in the dump.
      // The note about a failed send, which older versions kept in the settings.
      else if (part === 'private') dump.settings = await this.db.get('settings', 'settings');
      else throw new Error(`the app does not move ${part} yet`);
    }
    return dump;
  }

  /**
   * Change an account record: read, change and write inside one
   * transaction. The sync writes to the same record (key indices, the
   * start block, the restore marker), and the slow steps here take seconds:
   * a password hash, a passkey sheet. Writing back a copy read before them
   * would undo whatever the sync wrote meanwhile, and the other way round a
   * stale copy written by the sync would undo a password change, leaving the
   * old password the valid one. So the slow work is done first, and only
   * then is the record read again and the one field set.
   */
  private async patch(accountId: string, change: (current: AccountRecord) => AccountRecord): Promise<AccountRecord | null> {
    const tx = this.db.transaction('accounts', 'readwrite');
    const current = await tx.store.get(accountId);
    const next = current ? change(current) : null;
    if (next) await tx.store.put(next);
    await tx.done;
    return next;
  }

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
      const passkey = { credentialId: enrolment.credentialId, prfSalt: enrolment.prfSalt, wrappedContentKey };
      await this.patch(accountId, (current) => ({ ...current, passkey }));
    } finally {
      contentRaw.fill(0);
    }
  }

  async disablePasskey(accountId: string): Promise<void> {
    await this.patch(accountId, ({ passkey: _dropped, ...rest }) => rest);
  }

  async unlockWithPasskey(accountId: string): Promise<void> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    if (!this.passkeys) throw new Error('Passkeys are not available here');
    const record = await this.db.get('accounts', accountId);
    if (!record?.passkey) throw new Error('No passkey is set up for this wallet');
    const secret = await this.passkeys.secret(record.passkey.credentialId, record.passkey.prfSalt);
    const wrapped = record.passkey.wrappedContentKey;
    await this.load(epoch, async () => {
      try {
        if (this.core.unlockEnvelopeWithSecret) await this.core.unlockEnvelopeWithSecret(record.envelope, wrapped, new Uint8Array(secret), record.network);
        else await this.core.unlock(await openSeedWithSecret(record.envelope, wrapped, secret), record.network);
      } finally {
        secret.fill(0);
      }
    });
    await this.openStore(accountId);
    if (epoch !== this.epoch) throw new UnlockCancelledError();
    this.setUnlocked(accountId);
  }

  /**
   * Load the keys into the core with `into`, unless a lock arrived since
   * `epoch` was read or the page is hidden; then nothing stays loaded.
   */
  private async load(epoch: number, into: () => Promise<void>): Promise<void> {
    if (epoch !== this.epoch) throw new UnlockCancelledError();
    try {
      await into();
    } catch (e) {
      // A lock ends the worker, and the call it was busy with fails: that is the lock, not an error.
      if (epoch !== this.epoch) throw new UnlockCancelledError();
      throw e;
    }
    const hidden = this.doc?.visibilityState === 'hidden' && !this.lockDeferred;
    if (epoch !== this.epoch || hidden) {
      await this.forget();
      throw new UnlockCancelledError();
    }
  }

  /** Drop whatever the core holds: end its worker where it has one. */
  private async forget(): Promise<void> {
    if (this.core.terminate) this.core.terminate();
    else await this.core.lock().catch(() => undefined);
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
   * The names of the wallets on a network, but for one. Names are unique
   * per network, as the header menu and "Not this wallet?" list them.
   */
  private async namesOn(network: Network, except?: string): Promise<string[]> {
    return (await this.db.getAllFromIndex('accounts', 'byNetwork', network)).filter((a) => a.id !== except).map((a) => walletName(a));
  }

  /** The name a new wallet on this network gets when none is given. */
  async nextName(network: Network): Promise<string> {
    return nextWalletName(await this.namesOn(network));
  }

  /** A name asked for, trimmed and checked; the next free "Wallet n" when none was. Throws WalletNameTakenError. */
  private async newName(network: Network, asked: string | undefined): Promise<string> {
    const trimmed = (asked ?? '').trim().slice(0, WALLET_NAME_MAX);
    const names = await this.namesOn(network);
    if (!trimmed) return nextWalletName(names);
    const taken = clashingName(trimmed, names);
    if (taken !== null) throw new WalletNameTakenError(taken);
    return trimmed;
  }

  /** Throws WalletNameTakenError for a name another wallet on its network has. */
  async rename(accountId: string, name: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const trimmed = name.trim().slice(0, WALLET_NAME_MAX);
    if (!trimmed) throw new Error('A wallet needs a name');
    const taken = clashingName(trimmed, await this.namesOn(record.network, accountId));
    if (taken !== null) throw new WalletNameTakenError(taken);
    await this.patch(accountId, (current) => ({ ...current, name: trimmed }));
  }

  /**
   * The note about this wallet's last failed send, from its sealed log,
   * where it is readable only while the wallet is unlocked. Throws while
   * locked. A wallet whose notes could not move keeps none.
   */
  async lastSendFailure(accountId: string): Promise<SendFailure | null> {
    if (this.engine.where(accountId, 'private') !== 'engine') return null;
    const notes = (await this.core.storeRead!(accountId, 'private')) as { key: string; value: SendFailure }[];
    return notes.find((n) => n.key === LAST_SEND_FAILURE)?.value ?? null;
  }

  /** Keep, or with null clear, the note about this wallet's last failed send. Throws while locked. */
  async setLastSendFailure(accountId: string, failure: SendFailure | null): Promise<void> {
    if (this.engine.where(accountId, 'private') !== 'engine') return;
    await this.core.storeCommit!(accountId, [failure ? { op: 'putPrivate', key: LAST_SEND_FAILURE, value: failure } : { op: 'deletePrivate', key: LAST_SEND_FAILURE }]);
  }

  /** The note about this wallet's last send that reached the node, or null; kept like the failure note. */
  async lastSend(accountId: string): Promise<LastSend | null> {
    if (this.engine.where(accountId, 'private') !== 'engine') return null;
    const notes = (await this.core.storeRead!(accountId, 'private')) as { key: string; value: LastSend }[];
    return notes.find((n) => n.key === LAST_SEND)?.value ?? null;
  }

  /** Keep, or with null clear, the note about this wallet's last send. Throws while locked. */
  async setLastSend(accountId: string, note: LastSend | null): Promise<void> {
    if (this.engine.where(accountId, 'private') !== 'engine') return;
    await this.core.storeCommit!(accountId, [note ? { op: 'putPrivate', key: LAST_SEND, value: note } : { op: 'deletePrivate', key: LAST_SEND }]);
  }

  /** Proves the password opens this wallet; throws WrongPasswordError otherwise. */
  async verifyPassword(accountId: string, password: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    if (this.core.openEnvelope) await this.core.openEnvelope(record.envelope, password, false);
    else await openSeed(record.envelope, password, this.derive);
  }

  /**
   * The seed phrase, for showing. It is opened from the stored envelope
   * with the password, every time: being unlocked is not enough, since an
   * unlocked phone may be in someone else's hand. Throws WrongPasswordError.
   */
  async revealPhrase(accountId: string, password: string): Promise<string[]> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    if (this.core.openEnvelope) return (await this.core.openEnvelope(record.envelope, password, true)) ?? [];
    return openSeed(record.envelope, password, this.derive);
  }

  /**
   * Remove a wallet from this device: its seed, coins, history, blocks,
   * contacts and sync state, in one transaction. The funds stay on the
   * chain and the phrase restores them anywhere. Locks first when it is
   * the wallet in memory.
   */
  async deleteAccount(accountId: string): Promise<void> {
    if (this.unlockedId === accountId) await this.lock();
    // The sealed log first. Should the rest fail, a wallet with no log is a
    // wallet whose moved parts are empty; the other way round would leave a
    // log nobody can reach.
    await this.core.storeRemove?.(accountId);
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

  /**
   * Store a new account for `phrase` under `password` and unlock it.
   * `birthdayHeight` is where scanning starts: the current tip for a fresh
   * account, a user-supplied height (or 1) for an import. `name` is the
   * one asked for, if any; throws WalletNameTakenError when it is taken.
   */
  async createAccount(phrase: string[], password: string, network: Network, birthdayHeight: number, options: { fastRestore?: boolean; name?: string } = {}): Promise<AccountRecord> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    const name = await this.newName(network, options.name);
    // The new wallet's log is keyed from the content key, which is made here
    // with the envelope and handed to the core once, along with the phrase.
    const { envelope, contentKey } = await sealSeedKeepingKey(phrase, password, this.derive, DEFAULT_KDF);
    await this.load(epoch, () => this.core.unlock(phrase, network, contentKey));
    // From here the keys are in the core. Whatever fails below, they must
    // not stay there with no lock armed.
    try {
      const record: AccountRecord = {
        id: crypto.randomUUID(),
        network,
        createdAt: Date.now(),
        birthdayHeight: Math.max(0, birthdayHeight),
        envelope,
        nextKeyIndices: FRESH_KEY_INDICES,
        backupConfirmed: false,
        name,
        ...(options.fastRestore ? { restore: 'fast' as const } : {}),
      };
      await this.db.put('accounts', record);
      await this.openStore(record.id);
      if (epoch !== this.epoch) throw new UnlockCancelledError();
      this.setUnlocked(record.id);
      return record;
    } catch (e) {
      await this.forget();
      throw e;
    }
  }

  async unlock(accountId: string, password: string): Promise<void> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    await this.load(epoch, async () => {
      if (this.core.unlockEnvelope) await this.core.unlockEnvelope(record.envelope, password, record.network);
      else await this.core.unlock(await openSeed(record.envelope, password, this.derive), record.network);
    });
    await this.openStore(accountId);
    if (epoch !== this.epoch) throw new UnlockCancelledError();
    this.setUnlocked(accountId);
    // Not awaited: the wallet is open, and this is housekeeping.
    void this.strengthen(accountId, password).catch(() => undefined);
  }

  /**
   * An envelope keeps the password hash settings it was made with: those of
   * an early version, or of whatever file it was restored from. If they
   * are cheaper to guess against than today's default, the content key is
   * wrapped again at the default, now that the password is in hand. The
   * seed's own ciphertext does not change. A backup file made earlier keeps
   * the settings it has; only a fresh export carries the new ones.
   */
  private async strengthen(accountId: string, password: string): Promise<void> {
    const record = await this.db.get('accounts', accountId);
    if (!record || !isWeakerThanDefault(record.envelope.kdf)) return;
    const envelope = await reWrapSeed(record.envelope, password, password, this.derive, DEFAULT_KDF);
    // The record may have moved on during the seconds that took: only the
    // envelope is touched, and only if it is still the one that was read.
    const tx = this.db.transaction('accounts', 'readwrite');
    const current = await tx.store.get(accountId);
    if (current && current.envelope.kdf.salt === record.envelope.kdf.salt) await tx.store.put({ ...current, envelope });
    await tx.done;
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
    let replaced = false;
    await this.patch(accountId, (current) => {
      // Only the envelope that was re-wrapped may be replaced.
      if (current.envelope.kdf.salt !== record.envelope.kdf.salt) return current;
      replaced = true;
      return { ...current, envelope };
    });
    if (!replaced) throw new Error('The password was changed elsewhere in the meantime. Nothing was changed here; try again.');
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
    this.engine.forgetAll();
    await this.forget();
  }

  /** Call on any user interaction to postpone the idle lock. */
  touch(): void {
    if (this.unlockedId === null) return;
    this.lockPending = false;
    this.lastActivityAt = Date.now();
    if (this.idleTimer === null) {
      // A look at the clock every little while, not one long timer. A timer
      // stops while the device sleeps and carries on where it left off, so
      // a laptop closed for the night and opened in the morning would stay
      // unlocked for the rest of its idle time. The clock does not stop.
      const every = Math.max(5, Math.min(15_000, Math.floor(this.lockTimeoutMs / 4)));
      this.idleTimer = setInterval(() => this.lockIfIdle(), every);
    }
  }

  /**
   * A new idle time, chosen in Settings. It counts from the last activity,
   * which the choice itself is; the clock checks follow the new time.
   */
  setLockTimeout(ms: number): void {
    this.lockTimeoutMs = ms;
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.touch();
  }

  /** Lock when the idle time has passed by the wall clock. Also asked when the app comes back into view. */
  lockIfIdle(): void {
    if (this.unlockedId === null) return;
    if (Date.now() - this.lastActivityAt >= this.lockTimeoutMs) this.requestLock();
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
      // Coming back: not every platform hid the page while it was away.
      else this.lockIfIdle();
    };
    const back = () => this.lockIfIdle();
    const view = doc.defaultView;
    doc.addEventListener('visibilitychange', this.visibilityHandler);
    view?.addEventListener('focus', back);
    view?.addEventListener('pageshow', back);
    return () => {
      if (this.visibilityHandler) doc.removeEventListener('visibilitychange', this.visibilityHandler);
      view?.removeEventListener('focus', back);
      view?.removeEventListener('pageshow', back);
    };
  }

  async markBackupConfirmed(accountId: string): Promise<void> {
    await this.patch(accountId, (current) => ({ ...current, backupConfirmed: true }));
  }

  /**
   * The export file, version 3: the contacts encrypted, the rest
   * authenticated (see ExportFile). That takes the content key, and so the
   * password: being unlocked is not enough. Throws WrongPasswordError.
   */
  async exportFile(accountId: string, password: string): Promise<ExportFile> {
    const record = await this.db.get('accounts', accountId);
    if (!record) throw new Error('account not found');
    const contacts =
      this.engine.where(accountId, 'contacts') === 'engine'
        ? ((await this.core.storeRead!(accountId, 'contacts')) as ContactRecord[])
        : await this.db.getAllFromIndex('contacts', 'byAccount', accountId);
    return sealBackup(
      { network: record.network, birthdayHeight: record.birthdayHeight, exportedAt: Date.now() },
      record.envelope,
      { contacts: contacts.map((c) => ({ name: c.name, address: c.address })) },
      password,
      this.derive,
    );
  }

  /**
   * Start scanning again from `height`: local sync state, UTXOs, history
   * and block records for the account are dropped and rebuilt from the
   * chain. Funds are unaffected; only the local view is rebuilt.
   */
  async rescanFrom(accountId: string, height: number, fast = false): Promise<void> {
    if (!(await this.db.get('accounts', accountId))) throw new Error('account not found');
    // What scanning found goes, what a person made stays, and the scan state
    // starts again, in one step. The engine's; a wallet is unlocked to do it.
    if (this.engine.where(accountId, 'utxos') !== 'engine' || !this.core.ledger) {
      throw new Error('This wallet\'s coins could not be read, so there is nothing to rescan into. Unlock it again, and see Settings, Diagnostics.');
    }
    await this.core.ledger(accountId, { op: 'resetForRescan', height: Math.max(0, Math.floor(height)), fast });
  }

  /** Record that the export file was saved, for the reminder and Settings. */
  async markBackedUp(accountId: string, when = Date.now()): Promise<void> {
    await this.patch(accountId, (current) => ({ ...current, lastBackupAt: when }));
  }

  /** Snooze the Home backup reminder for a week. */
  async dismissBackupNudge(accountId: string, when = Date.now()): Promise<void> {
    await this.patch(accountId, (current) => ({ ...current, backupNudgeDismissedAt: when }));
  }

  /** Import an export file. The password is checked by unlocking. */
  async importFile(file: ExportFile, password: string, options: { fastRestore?: boolean } = {}): Promise<AccountRecord> {
    // Read before the first await: a lock that arrives at any point after this cancels what follows.
    const epoch = this.epoch;
    if (file.format !== 'neptune-vault-backup') throw new Error('not a Neptune Vault backup file');
    // Every version ever written stays readable; one this app does not know
    // is from a newer app, never a reason to guess at the contents.
    if (file.version !== 1 && file.version !== 2 && file.version !== 3) {
      throw new Error('This backup file was made by a newer version of Neptune Vault. Update the app, then restore it.');
    }
    if (file.version !== 3) assertEnvelope(file.envelope);
    // The file is someone's input: everything is looked at before any of
    // it is used, so a malformed file is refused whole and cannot leave a
    // half-made wallet or loaded keys behind.
    const network = file.network as Network;
    if (network !== 'main' && network !== 'testnet' && network !== 'regtest') throw new Error('This backup file names a network this app does not know.');
    const birthday = Number.isSafeInteger(file.birthdayHeight) && file.birthdayHeight >= 0 ? file.birthdayHeight : 1;
    const exportedAt = Number.isSafeInteger(file.exportedAt) ? file.exportedAt : Date.now();
    // A version 3 file keeps its contacts encrypted and everything else
    // authenticated: opening that part proves the password and proves that
    // nothing readable was changed, before any key is loaded. A wrong
    // password and an altered file are told apart.
    // It also yields the envelope the database keeps, which is an ordinary
    // one: the file's own cannot be opened by the unlock path, by design.
    let envelope: SeedEnvelope;
    let fromFile: unknown;
    if (file.version === 3) {
      const opened = await openBackup(file, password, this.derive);
      envelope = opened.envelope;
      fromFile = opened.secrets.contacts;
    } else {
      envelope = file.envelope;
      fromFile = file.contacts;
    }
    const listed: unknown[] = Array.isArray(fromFile) ? fromFile.slice(0, 5000) : [];
    const contacts = listed
      .filter((c): c is { name: string; address: string } => typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string' && typeof (c as { address?: unknown }).address === 'string')
      .map((c) => ({ name: c.name.trim().slice(0, 80), address: c.address.trim().toLowerCase() }))
      .filter((c) => c.name !== '' && c.address.length <= 8000);

    const name = await this.nextName(network);
    await this.load(epoch, async () => {
      if (this.core.unlockEnvelope) await this.core.unlockEnvelope(envelope, password, network);
      else await this.core.unlock(await openSeed(envelope, password, this.derive), network);
    });
    let recordId: string | null = null;
    try {
      const record: AccountRecord = {
        id: crypto.randomUUID(),
        network,
        createdAt: Date.now(),
        birthdayHeight: Math.max(1, birthday),
        envelope,
        nextKeyIndices: FRESH_KEY_INDICES,
        backupConfirmed: true,
        name,
        // The file it came from is a backup as of its export date.
        lastBackupAt: exportedAt,
        ...(options.fastRestore ? { restore: 'fast' as const } : {}),
      };
      const usable: typeof contacts = [];
      const seenAddresses = new Set<string>();
      for (const c of contacts) {
        if (seenAddresses.has(c.address) || !(await this.core.isValidAddress(c.address, network))) continue;
        seenAddresses.add(c.address);
        usable.push(c);
      }
      // No two contacts of a wallet share a name; a file from before that rule may hold namesakes.
      const valid = distinctNames(usable);
      const rows: ContactRecord[] = valid.map((c) => {
        const id = crypto.randomUUID();
        const now = Date.now();
        return { key: `${record.id}:${id}`, id, accountId: record.id, name: c.name, address: c.address, kind: addressKindLabel(c.address), createdAt: now, updatedAt: now };
      });
      // The wallet and its contacts arrive together or not at all: a failure
      // below removes the wallet that was made, and its log with it.
      const tx = this.db.transaction(['accounts', 'contacts'], 'readwrite');
      await tx.objectStore('accounts').put(record);
      recordId = record.id;
      if (!this.core.storeCommit) for (const row of rows) await tx.objectStore('contacts').put(row);
      await tx.done;
      await this.openStore(record.id);
      if (this.core.storeCommit && rows.length > 0) {
        if (this.engine.where(record.id, 'contacts') === 'engine') await this.core.storeCommit(record.id, rows.map((contact) => ({ op: 'putContact' as const, contact })));
        else for (const row of rows) await this.db.put('contacts', row);
      }
      if (epoch !== this.epoch) throw new UnlockCancelledError();
      this.setUnlocked(record.id);
      void this.strengthen(record.id, password).catch(() => undefined);
      return record;
    } catch (e) {
      await this.forget();
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
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}
