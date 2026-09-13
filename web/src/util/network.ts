// Human labels for the network ids neptune-core uses ("main" stays the id).

import type { Network } from '../storage/db';

export const NETWORK_LABELS: Record<Network, string> = {
  main: 'Mainnet',
  testnet: 'Testnet',
  regtest: 'Regtest',
};

export const NETWORK_OPTIONS = (Object.keys(NETWORK_LABELS) as Network[]).map((value) => ({ value, label: NETWORK_LABELS[value] }));

export function networkLabel(network: Network | string | undefined): string {
  return network ? (NETWORK_LABELS[network as Network] ?? network) : '';
}
