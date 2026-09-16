// IndexedDB schema for Neptune Vault.
//
// Every store is keyed by account id and network so several accounts and
// both networks can coexist (R14, F20). The wallet core's own types
// (StoredUtxo, ScannedBlock, SendSummary) are stored as it produces them.

import type { NextKeyIndices } from '../wallet/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type Network = 'main' | 'testnet' | 'regtest';

/** The password-wrapped seed and the parameters needed to unwrap it. */
export interface SeedEnvelope {
  version: 1;
  kdf: { name: 'argon2id'; mKib: number; tCost: number; pCost: number; salt: string };
  /** AES-256-GCM over the 32-byte content key, keyed by the Argon2 output. */
  wrappedContentKey: { iv: string; ciphertext: string };
  /** AES-256-GCM over the UTF-8 seed phrase, keyed by the content key. */
  seed: { iv: string; ciphertext: string };
}

export interface AccountRecord {
  id: string;
  network: Network;
  createdAt: number;
  /** First block height worth scanning for this account; 0 means unknown
   * (the node was unreachable at creation) and becomes the tip at first sync. */
  birthdayHeight: number;
  envelope: SeedEnvelope;
  /** Address of key 0, so the receive screen works before unlocking. */
  address0: string;
  /** Next unused derivation index per key kind, advanced by scanning. */
  nextKeyIndices: NextKeyIndices;
  /** True once the user confirmed the seed phrase (F3). */
  backupConfirmed: boolean;
  /** The wallet's name on this device, for telling several apart. Absent on the first wallets ever made. */
  name?: string;
  /**
   * A fast restore is pending: the next sync asks the node's coin index
   * which blocks are this wallet's and scans only those, instead of every
   * block from the start height. Cleared when it has run.
   */
  restore?: 'fast';
  /** When an export file was last saved, or the file's date for an imported account. Absent: never. */
  lastBackupAt?: number;
  /** When the Home backup reminder was last dismissed; it returns after a week. */
  backupNudgeDismissedAt?: number;
  /** Passkey unlock: the content key wrapped under the passkey's PRF secret. */
  passkey?: { credentialId: string; prfSalt: string; wrappedContentKey: { iv: string; ciphertext: string } };
}

export interface UtxoRecord {
  /** `${accountId}:${hash}` so the store can be keyed by one string. */
  key: string;
  accountId: string;
  hash: string;
  /** Opaque wallet-core StoredUtxo; passed back to it for scanning and spending. */
  stored: unknown;
  amountNau: string;
  amount: string;
  confirmedHeight: number;
  confirmedTimestampMs: number;
  releaseDateMs: number | null;
  spentHeight: number | null;
  spentTxid: string | null;
  /** Reserved by a pending outgoing transaction (R18). */
  pendingTxid: string | null;
}

export interface BlockRecord {
  key: string;
  accountId: string;
  height: number;
  hash: string;
  prevHash: string;
  timestampMs: number;
}

export type HistoryKind = 'received' | 'sent';
export type HistoryStatus = 'pending' | 'confirmed' | 'failed';

export interface HistoryRecord {
  key: string;
  accountId: string;
  kind: HistoryKind;
  status: HistoryStatus;
  txid: string;
  amountNau: string;
  feeNau: string | null;
  timestampMs: number;
  height: number | null;
  /** For sends: the UTXO hashes reserved until confirmation. */
  inputHashes: string[];
  recipient: string | null;
  error: string | null;
  /** For sends: the change that comes back, so history can fold it in. Absent on rows from before it was kept. */
  changeNau?: string | null;
  /** For sends: the outputs' canonical commitments, the explorer's keys. Absent on rows from before it was kept. */
  outputs?: HistoryOutput[];
  /** For sends made from a payment link: the link's message, kept for the payer; never sent anywhere. */
  note?: string | null;
  /** For pending sends: when the node's mempool was last seen holding it, and when that was last checked. */
  mempoolSeenAt?: number | null;
  mempoolCheckedAt?: number | null;
}

export interface HistoryOutput {
  commitment: string;
  role: 'recipient' | 'change';
}

export interface SyncStateRecord {
  accountId: string;
  /** Last height fully scanned, or birthday minus one. */
  syncedHeight: number;
  syncedHash: string | null;
  updatedAt: number;
}

export interface SettingsRecord {
  id: 'settings';
  network: Network;
  nodeUrls: Record<Network, string>;
  currentAccountId: string | null;
  lockTimeoutMs: number;
  /** Last fee preset chosen on Send, and the custom value if any. */
  feePreset?: string;
  feeCustom?: string;
  /** Balance and amounts masked on Home (an eye toggle). */
  hideBalance?: boolean;
  /** When the Home install notice was last dismissed; it returns after two weeks. Per device, not per wallet. */
  installNudgeDismissedAt?: number;
  /** Last connection test per network, kept so Settings shows it on return. */
  nodeProbe?: Partial<Record<Network, { ok: boolean; text: string; at: number }>>;
  /** How the last proof on this device went, for Diagnostics and bug reports. */
  lastProving?: LastProving;
}

export interface LastProving {
  at: number;
  claimVersion: number;
  threads: number;
  peakMb: number;
  seconds: number;
  error: string | null;
}

/** A saved recipient (contact), per account. */
export interface ContactRecord {
  /** `${accountId}:${id}`. */
  key: string;
  id: string;
  accountId: string;
  name: string;
  /** Full bech32m address, lower case. */
  address: string;
  /** Human label of the address kind, from its prefix. */
  kind: string;
  createdAt: number;
  updatedAt: number;
}

interface VaultSchema extends DBSchema {
  accounts: { key: string; value: AccountRecord; indexes: { byNetwork: Network } };
  contacts: { key: string; value: ContactRecord; indexes: { byAccount: string } };
  utxos: { key: string; value: UtxoRecord; indexes: { byAccount: string } };
  blocks: { key: string; value: BlockRecord; indexes: { byAccountHeight: [string, number] } };
  history: { key: string; value: HistoryRecord; indexes: { byAccount: string } };
  syncState: { key: string; value: SyncStateRecord };
  settings: { key: string; value: SettingsRecord };
}

export type VaultDb = IDBPDatabase<VaultSchema>;

export const DB_NAME = 'neptune-vault';
// Version history: 1 initial; 2 adds the contacts store.
export const DB_VERSION = 2;

export const DEFAULT_NODE_URLS: Record<Network, string> = {
  main: 'https://wallet.neptunefundamentals.org',
  testnet: '',
  // The dev server proxies /regtest-node to a local regtest node (vite.config.ts).
  regtest: '/regtest-node',
};

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'settings',
  network: 'main',
  nodeUrls: DEFAULT_NODE_URLS,
  currentAccountId: null,
  lockTimeoutMs: 5 * 60 * 1000,
};

export async function openVaultDb(): Promise<VaultDb> {
  try {
    return await openVaultDbAt(DB_VERSION);
  } catch (e) {
    // The browser refuses to open a database at a version below the one on
    // disk: a newer app wrote it. Say so rather than touch it.
    if ((e as { name?: string }).name === 'VersionError') {
      throw new Error('This wallet\x27s data was written by a newer version of Neptune Vault. Update the app.');
    }
    throw e;
  }
}

function openVaultDbAt(version: number): Promise<VaultDb> {
  return openDB<VaultSchema>(DB_NAME, version, {
    // Each step runs once, in order, inside the upgrade transaction; a
    // store that exists is never recreated, so data is kept.
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
        accounts.createIndex('byNetwork', 'network');
        const utxos = db.createObjectStore('utxos', { keyPath: 'key' });
        utxos.createIndex('byAccount', 'accountId');
        const blocks = db.createObjectStore('blocks', { keyPath: 'key' });
        blocks.createIndex('byAccountHeight', ['accountId', 'height']);
        const history = db.createObjectStore('history', { keyPath: 'key' });
        history.createIndex('byAccount', 'accountId');
        db.createObjectStore('syncState', { keyPath: 'accountId' });
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        const contacts = db.createObjectStore('contacts', { keyPath: 'key' });
        contacts.createIndex('byAccount', 'accountId');
      }
    },
    blocked() {
      // Another tab or the installed app still holds the old version open.
      alert('Neptune Vault is open in another tab or window. Close it and reload this one.');
    },
  });
}

export async function loadSettings(db: VaultDb): Promise<SettingsRecord> {
  return (await db.get('settings', 'settings')) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(db: VaultDb, settings: SettingsRecord): Promise<void> {
  await db.put('settings', settings);
}

/** Ask the browser not to evict our data under storage pressure (F7). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // Not available in this context; nothing to do.
  }
  return false;
}

/** Indices for a brand-new account: key 0 of each kind is shown first. */
export const FRESH_KEY_INDICES: NextKeyIndices = { generation: 1, ec_hybrid: 0, viewing: 0 };

/**
 * Accounts stored before address kinds existed carry a single
 * `nextKeyIndex`; read them as generation-only.
 */
/** The name a wallet is shown under; the first wallets ever made have none. */
export function walletName(account: Pick<AccountRecord, 'name'>): string {
  return account.name?.trim() || 'Wallet 1';
}

export function nextKeyIndicesOf(account: AccountRecord): NextKeyIndices {
  const legacy = (account as unknown as { nextKeyIndex?: number }).nextKeyIndex;
  return account.nextKeyIndices ?? { generation: legacy ?? 1, ec_hybrid: 0, viewing: 0 };
}
