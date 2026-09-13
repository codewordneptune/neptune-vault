// IndexedDB schema for Neptune Vault.
//
// Every store is keyed by account id and network so several accounts and
// both networks can coexist (R14, F20). The wallet core's own types
// (StoredUtxo, ScannedBlock, SendSummary) are stored as it produces them.

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
  /** First block height worth scanning for this account. */
  birthdayHeight: number;
  envelope: SeedEnvelope;
  /** Address of key 0, so the receive screen works before unlocking. */
  address0: string;
  /** Next unused generation key index, advanced by scanning. */
  nextKeyIndex: number;
  /** True once the user confirmed the seed phrase (F3). */
  backupConfirmed: boolean;
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
}

interface VaultSchema extends DBSchema {
  accounts: { key: string; value: AccountRecord; indexes: { byNetwork: Network } };
  utxos: { key: string; value: UtxoRecord; indexes: { byAccount: string } };
  blocks: { key: string; value: BlockRecord; indexes: { byAccountHeight: [string, number] } };
  history: { key: string; value: HistoryRecord; indexes: { byAccount: string } };
  syncState: { key: string; value: SyncStateRecord };
  settings: { key: string; value: SettingsRecord };
}

export type VaultDb = IDBPDatabase<VaultSchema>;

export const DB_NAME = 'neptune-vault';
export const DB_VERSION = 1;

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
  return openDB<VaultSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
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
