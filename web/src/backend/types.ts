// The wallet core as the app sees it: a small interface over the wasm
// package so the sync engine and the UI can be tested with a fake, and so
// the real one can live in a Web Worker.

import type { SeedEnvelope } from '../storage/db';

export interface ScannedBlock {
  height: number;
  hash: string;
  prev_hash: string;
  timestamp_ms: number;
  incoming: StoredUtxo[];
  spent: string[];
  /** Which watched output commitments the block carries. */
  seen?: string[];
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
  /** Time lock, if any, in milliseconds since the epoch. */
  release_date_ms?: number | null;
}

/**
 * What the node was asked for, so the core can hold the answer against it:
 * the heights, the block the first one must follow, and the output
 * commitments of pending sends to report back when a block carries them.
 */
export interface ScanExpectation {
  from: number;
  to: number;
  prev_hash: string | null;
  watch: string[];
}

/** How many addresses past the newest used one the scan looks at; the core's KEY_LOOKAHEAD. */
export const KEY_LOOKAHEAD = 5;

/** The core's message when a block does not follow the wallet's last one: a reorganisation, not an error. */
export const NOT_LINKED = 'chain check: not linked';

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
  /** The amount and fee in nau, exactly as reviewed. When present the core sends these and the texts are for the record. */
  amount_nau?: string;
  fee_nau?: string;
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
  /** Why `words` cannot be a seed phrase, in plain words, or null when they can. */
  phraseProblem(words: string[]): Promise<string | null>;

  /** Load the account into memory. Replaces any previously unlocked one. */
  unlock(phrase: string[], network: string): Promise<void>;
  /**
   * Open the envelope and load the account inside the core, so the phrase
   * never reaches the page. Throws WrongPasswordError. Optional: a core
   * without it is given the phrase through `unlock`.
   */
  unlockEnvelope?(envelope: SeedEnvelope, password: string, network: string): Promise<void>;
  /** The same through a passkey's secret, which is zeroed once used. */
  unlockEnvelopeWithSecret?(envelope: SeedEnvelope, wrapped: { iv: string; ciphertext: string }, secret: Uint8Array, network: string): Promise<void>;
  /** Check the password and, when `wantPhrase`, give the words back for showing. */
  openEnvelope?(envelope: SeedEnvelope, password: string, wantPhrase: boolean): Promise<string[] | null>;
  /** End the core's worker and everything in its memory. Optional: a core without it is asked to `lock`. */
  terminate?(): void;
  lock(): Promise<void>;
  isUnlocked(): Promise<boolean>;

  address(kind: KeyKind, index: number): Promise<string>;
  /** `blocksResponse` is the node's raw JSON-RPC response text for wallet_getBlocks. */
  scanBlocks(blocksResponse: string, unspent: StoredUtxo[], nextKeyIndices: NextKeyIndices, expectation: ScanExpectation): Promise<ScanResult>;
  /** The announcement flags of the keys a scan would try, as the JSON text of the index request. */
  announcementFlags(nextKeyIndices: NextKeyIndices): Promise<string>;
  /** The absolute index sets of these coins, as the JSON text of the index request. */
  absoluteIndexSets(unspent: StoredUtxo[]): Promise<string>;
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

// ---------------------------------------------------------------------------
// The prover. It takes a witness and returns a proof collection, and is the
// slowest thing the wallet does, so its progress is reported as it goes.
// ---------------------------------------------------------------------------

export interface ProveRequest {
  /** How many inputs the transaction spends, to weight the progress bar; optional. */
  inputs?: number;
  witness: Uint8Array;
  network: string;
  blockHeight: number;
  threads: number;
  /** Use the pre-fork prover package (claim version 5). */
  legacy?: boolean;
}

export interface ProveProgress {
  index: number;
  total: number;
  name: string;
  /** Share of the proving work finished, 0 to 1, by the measured cost of each sub-proof; not a time. */
  work?: number;
  /** Seconds spent on finished sub-proofs so far. */
  elapsedSeconds: number;
  memoryMb: number;
  threads: number;
}

export interface ProveOutcome {
  proofCollection: Uint8Array;
  seconds: number;
  memoryMb: number;
  threads: number;
}

/**
 * The prover as the send flow needs it. In a browser this is wasm in a
 * worker; in a native shell it is the same Rust compiled for the device.
 */
export interface Prover {
  prove(request: ProveRequest, onProgress: (p: ProveProgress) => void): Promise<ProveOutcome>;
  /** Abandon the running proof. Settles the promise `prove` returned. */
  cancel(): void;
  /** How many threads to ask for, as this implementation counts them. */
  defaultThreads(): number;
}
