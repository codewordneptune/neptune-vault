// Wires the long-lived objects together: database, settings, wallet worker,
// node client, account service. Screens reach them through AppContext.

import { createBackend, type BackendKind } from '../backend';
import type { Prover, WalletCore } from '../backend/types';
import { NodeClient } from '../node/rpc';
import { loadSettings, openVaultDb, requestPersistentStorage, saveSettings, type Network, type SettingsRecord, type VaultDb } from '../storage/db';
import { ContactsService } from './contacts';
import { WebAuthnPasskeys } from './passkey';
import { MempoolWatcher } from '../wallet/mempool';
import { SyncEngine, type SyncProgress } from '../wallet/sync';
import { AccountService } from './accounts';
import { SendService } from './send';
import type { WindowOwner } from './windowOwner';

export interface Services {
  db: VaultDb;
  settings: SettingsRecord;
  core: WalletCore;
  accounts: AccountService;
  prover: Prover;
  /** Whether the wallet's Rust runs as wasm here or natively in a shell. */
  backendKind: BackendKind;
  persistent: boolean;
  /** This window's hold on the wallet; a send marks it busy so the wallet is not taken mid-way. */
  window: WindowOwner;
  node(): NodeClient;
  updateSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
  syncEngine(accountId: string, onProgress: (p: SyncProgress) => void): SyncEngine;
  sendService(accountId: string): SendService;
  mempoolWatcher(accountId: string): MempoolWatcher;
  contacts: ContactsService;
  networkName(): string;
  /** Drop what is cached for a wallet that was removed from this device. */
  forgetAccount(accountId: string): void;
}

/** The wasm core's spelling of the network (neptune-primitives `Network`). */
export function coreNetworkName(network: Network): string {
  return network === 'main' ? 'main' : network === 'testnet' ? 'testnet' : 'regtest';
}

export async function createServices(owner: WindowOwner): Promise<Services> {
  const watchers = new Map<string, MempoolWatcher>();
  const db = await openVaultDb();
  const persistent = await requestPersistentStorage();
  let settings = await loadSettings(db);
  const { core, prover, backendKind } = await createBackend().then((b) => ({ core: b.core, prover: b.prover, backendKind: b.kind }));
  const accounts = new AccountService(db, core, settings.lockTimeoutMs, new WebAuthnPasskeys());

  const services: Services = {
    db,
    settings,
    core,
    accounts,
    prover,
    backendKind,
    persistent,
    window: owner,
    node() {
      return new NodeClient(settings.nodeUrls[settings.network]);
    },
    async updateSettings(patch) {
      settings = { ...settings, ...patch, id: 'settings' };
      services.settings = settings;
      await saveSettings(db, settings);
      return settings;
    },
    syncEngine(accountId, onProgress) {
      // The node of the account's own network, whatever the settings say at this instant.
      return new SyncEngine(db, (network) => new NodeClient(settings.nodeUrls[network]), core, accountId, { onProgress });
    },
    contacts: new ContactsService(db, core, () => coreNetworkName(services.settings.network), accounts.engine),
    mempoolWatcher(accountId) {
      const key = `${accountId}:${settings.nodeUrls[settings.network]}`;
      let w = watchers.get(key);
      if (!w) {
        w = new MempoolWatcher(services.node(), core, accountId, { isCurrent: () => accounts.currentAccountId === accountId });
        watchers.set(key, w);
      }
      return w;
    },
    sendService(accountId) {
      return new SendService(services.node(), core, prover, accountId, coreNetworkName(settings.network), prover.defaultThreads(), settings.network === 'regtest');
    },
    forgetAccount(accountId) {
      for (const key of [...watchers.keys()]) if (key.startsWith(`${accountId}:`)) watchers.delete(key);
    },
    networkName() {
      return coreNetworkName(settings.network);
    },
  };
  return services;
}
