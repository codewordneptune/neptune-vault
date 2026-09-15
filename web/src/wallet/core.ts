// The wallet core as the app sees it: a small interface over the wasm
// package so the sync engine and the UI can be tested with a fake, and so
// the real one can live in a Web Worker.

export interface ScannedBlock {
  height: number;
  hash: string;
  prev_hash: string;
  timestamp_ms: number;
  incoming: StoredUtxo[];
  spent: string[];
}

/** Address kinds the app offers; names match the Rust serde names. */
export type KeyKind = 'generation' | 'ec_hybrid' | 'viewing';
export const KEY_KINDS: KeyKind[] = ['generation', 'ec_hybrid', 'viewing'];

/** Next unused derivation index per key kind. */
export interface NextKeyIndices {
  generation: number;
  ec_hybrid: number;
  viewing: number;
}

export interface ScanResult {
  blocks: ScannedBlock[];
  next_key_indices: NextKeyIndices;
}

/** An output of an unmined transaction that belongs to this wallet. */
export interface PendingIncoming {
  commitment: string;
  amount_nau: string;
  amount: string;
  key_kind: KeyKind;
  key_index: number;
  /** Created by a transaction built from this seed: not incoming. */
  own: boolean;
}

/** What one mempool transaction means for this wallet. */
export interface MempoolScan {
  incoming: PendingIncoming[];
  /** Hashes of this wallet's unspent UTXOs the transaction spends. */
  spent: string[];
  timestamp_ms: number;
}

/** Opaque to the app except for the fields it displays or indexes. */
export interface StoredUtxo {
  hash: string;
  /** Canonical commitment (explorer key); empty on records scanned before it was kept. */
  commitment?: string;
  /**
   * The height a transaction built from this seed was built against when it
   * created this coin (change, or a payment to itself); null when another
   * wallet created it; absent on records scanned before it was kept.
   */
  own_build_height?: number | null;
  amount_nau: string;
  amount: string;
  key_kind: KeyKind;
  key_index: number;
  release_date_ms: number | null;
  confirmed_height: number;
  confirmed_block: string;
  confirmed_timestamp_ms: number;
  recovery: unknown;
}

export interface SendRequest {
  recipient: string;
  amount: string;
  fee: string;
  accept_lustration: boolean;
}

export interface InputPlan {
  inputs: StoredUtxo[];
  absolute_index_sets: unknown[];
  total_in_nau: string;
}

export interface SendSummary {
  txid: string;
  input_hashes: string[];
  amount_nau: string;
  fee_nau: string;
  change_nau: string | null;
  /** Output commitments in kernel order: recipient first, change last if any. */
  output_commitments: string[];
  timestamp_ms: number;
  built_against_height: number;
  built_against_hash: string;
  requires_lustration: boolean;
}

export interface SendPlan {
  witness: Uint8Array;
  kernel: Uint8Array;
  summary: SendSummary;
}

/** Everything the app asks of the wallet core, unlocked or not. */
export interface WalletCore {
  /** Version of the wasm wallet core package. */
  coreVersion?(): Promise<string>;
  /** Claim version the rules require at a height (5 before the fork, 8 after). */
  claimVersion?(network: string, blockHeight: number): Promise<number>;
  generatePhrase(): Promise<string[]>;
  deriveKey(password: Uint8Array, salt: Uint8Array, mKib: number, tCost: number, pCost: number): Promise<Uint8Array>;
  parseAmount(text: string): Promise<string>;
  formatAmount(nau: string): Promise<string>;
  isValidAddress(encoded: string, network: string): Promise<boolean>;

  /** Load the account into memory. Replaces any previously unlocked one. */
  unlock(phrase: string[], network: string): Promise<void>;
  lock(): Promise<void>;
  isUnlocked(): Promise<boolean>;

  /** The unlocked account's phrase, for the backup screen. */
  phrase(): Promise<string[]>;
  address(kind: KeyKind, index: number): Promise<string>;
  /** `blocksResponse` is the node's raw JSON-RPC response text for wallet_getBlocks. */
  scanBlocks(blocksResponse: string, unspent: StoredUtxo[], nextKeyIndices: NextKeyIndices): Promise<ScanResult>;
  /** `kernelResponse` is the raw JSON-RPC response text of mempool_getTransactionKernel. */
  scanMempoolKernel(kernelResponse: string, unspent: StoredUtxo[], nextKeyIndices: NextKeyIndices, tipHeight: number): Promise<MempoolScan>;
  planInputs(unspent: StoredUtxo[], request: SendRequest, nowMs: number): Promise<InputPlan>;
  /** `snapshotResponse` and `tipHeaderResponse` are raw JSON-RPC response texts. */
  buildSend(
    inputs: StoredUtxo[],
    snapshotResponse: string,
    tipHeaderResponse: string,
    request: SendRequest,
    nowMs: number,
  ): Promise<SendPlan>;
  /** Mock ProofCollection for mock-proof networks (regtest), where real proofs are rejected. */
  mockProofCollection(witness: Uint8Array): Promise<Uint8Array>;
  assembleSubmission(kernel: Uint8Array, proofCollection: Uint8Array): Promise<unknown>;
}
