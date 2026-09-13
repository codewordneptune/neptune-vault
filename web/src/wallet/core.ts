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

export interface ScanResult {
  blocks: ScannedBlock[];
  next_key_index: number;
}

/** Opaque to the app except for the fields it displays or indexes. */
export interface StoredUtxo {
  hash: string;
  amount_nau: string;
  amount: string;
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
  address(index: number): Promise<string>;
  scanBlocks(blocks: unknown[], unspent: StoredUtxo[], nextKeyIndex: number): Promise<ScanResult>;
  planInputs(unspent: StoredUtxo[], request: SendRequest, nowMs: number): Promise<InputPlan>;
  buildSend(
    inputs: StoredUtxo[],
    snapshot: unknown,
    tipHeader: unknown,
    request: SendRequest,
    nowMs: number,
  ): Promise<SendPlan>;
  assembleSubmission(kernel: Uint8Array, proofCollection: Uint8Array): Promise<unknown>;
}
