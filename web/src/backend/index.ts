// Which side of the boundary the wallet's Rust runs on.
//
// In a browser it is wasm in two workers. In a native shell it is the same
// crates compiled for the device, reached over the shell's command channel:
// faster, and with no need for SharedArrayBuffer, since threads then belong
// to rayon rather than to the page.
//
// The choice is made once at start-up, by asking whether a shell is hosting
// us, and both sides are loaded on demand so that neither ships in the
// other's bundle.

import type { Prover, WalletCore } from './types';

export interface Backend {
  core: WalletCore;
  prover: Prover;
  /** Which implementation is in use. Shown on Diagnostics, and worth having in a bug report. */
  kind: BackendKind;
}

export type BackendKind = 'browser' | 'native';

/**
 * Whether a native shell is hosting this interface. Tauri puts its bridge on
 * the window before any of our code runs, so this is settled by the time
 * anything asks.
 */
export function isNative(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function createBackend(): Promise<Backend> {
  if (isNative()) {
    const [wallet, prover] = await Promise.all([import('./native/walletClient'), import('./native/proverClient')]);
    return { core: new wallet.NativeWalletClient(), prover: new prover.NativeProverClient(), kind: 'native' };
  }
  const [wallet, prover] = await Promise.all([import('./browser/walletClient'), import('./browser/proverClient')]);
  return { core: new wallet.WalletWorkerClient(), prover: new prover.ProverClient(), kind: 'browser' };
}
