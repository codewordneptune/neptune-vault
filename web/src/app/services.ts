// Wires the long-lived objects together: database, settings, wallet worker,
// node client, account service. Screens reach them through AppContext.

import { NodeClient } from '../node/rpc';
import { ProverClient } from '../prover/client';
import { loadSettings, openVaultDb, requestPersistentStorage, saveSettings, type Network, type SettingsRecord, type VaultDb } from '../storage/db';
import { WalletWorkerClient } from '../wallet/workerClient';
import { SyncEngine, type SyncProgress } from '../wallet/sync';
import { AccountService } from './accounts';
import { SendService } from './send';

export interface Services {
  db: VaultDb;
  settings: SettingsRecord;
  core: WalletWorkerClient;
  accounts: AccountService;
  prover: ProverClient;
  persistent: boolean;
  node(): NodeClient;
  updateSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
  syncEngine(accountId: string, onProgress: (p: SyncProgress) => void): SyncEngine;
  sendService(accountId: string): SendService;
  networkName(): string;
}

/** The wasm core's spelling of the network (neptune-primitives `Network`). */
export function coreNetworkName(network: Network): string {
  return network === 'main' ? 'main' : network === 'testnet' ? 'testnet' : 'regtest';
}

export async function createServices(): Promise<Services> {
  const db = await openVaultDb();
  const persistent = await requestPersistentStorage();
  let settings = await loadSettings(db);
  const core = new WalletWorkerClient();
  const accounts = new AccountService(db, core, settings.lockTimeoutMs);
  const prover = new ProverClient();

  const services: Services = {
    db,
    settings,
    core,
    accounts,
    prover,
    persistent,
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
      return new SyncEngine(db, services.node(), core, accountId, { onProgress });
    },
    sendService(accountId) {
      return new SendService(db, services.node(), core, prover, accountId, coreNetworkName(settings.network), ProverClient.defaultThreads(), settings.network === 'regtest');
    },
    networkName() {
      return coreNetworkName(settings.network);
    },
  };
  return services;
}
