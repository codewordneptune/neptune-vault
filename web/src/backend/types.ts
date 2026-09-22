// The wallet core as the app sees it: a small interface over the wasm
// package so the sync engine and the UI can be tested with a fake, and so
// the real one can live in a Web Worker.

import type { ContactRecord, HistoryRecord, SeedEnvelope } from '../storage/db';

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

/**
 * The parts of a wallet that can live in the engine's sealed log. The app
 * moves over one part at a time; `ENGINE_PARTS` says which have.
 */
export type WalletPart = 'details' | 'scan' | 'sync' | 'utxos' | 'blocks' | 'history' | 'contacts' | 'private';

/**
 * Parts written together, which therefore move together, in one batch: the
 * sync writes the scan state, its position, the coins, the blocks and the
 * history in a single step. The engine's migrate::CHAIN.
 */
export const CHAIN_PARTS: WalletPart[] = ['scan', 'sync', 'utxos', 'blocks', 'history'];

/** Where a pass begins: the last height scanned, and the hash the next block must follow. */
export interface Position {
  syncedHeight: number;
  syncedHash: string | null;
}

/** How a wallet is scanned, as the engine keeps it. */
export interface ScanSettings {
  birthdayHeight: number;
  nextKeyIndices: NextKeyIndices;
  /**
   * `fast` when a person asked for a restore through the node's coin index;
   * `rebuild` when the wallet's chain could not be moved into the engine and
   * is being rebuilt, which falls back to a plain scan on a node without one.
   */
  restore?: 'fast' | 'rebuild';
  restoredAt?: number;
}

/**
 * One operation of the engine's ledger: every change to a wallet's coins,
 * history and scan position is one of these, decided against the wallet as
 * it is and applied only once written down. The names are the engine's
 * (ledger::op::Op).
 */
export type LedgerOp =
  | { op: 'unspentHashes' }
  | { op: 'spendable'; now: number }
  | { op: 'forkCandidates'; below: number }
  | { op: 'rollbackFloor' }
  | { op: 'watchedCommitments' }
  | { op: 'announcementFlags' }
  | { op: 'absoluteIndexSets' }
  | { op: 'scanBlocks'; blocksResponse: string; from: number; to: number; prevHash: string | null }
  | { op: 'scanMempoolKernel'; kernelResponse: string }
  | { op: 'startPass'; tipHeight: number }
  | { op: 'rollBack'; height: number; hash: string | null; now: number }
  | { op: 'persistScan'; result: ScanResult; keepBlocks?: number; now: number }
  | { op: 'finishFastRestore'; handover: number; lowest: number; now: number }
  | { op: 'resetForRescan'; height: number; fast: boolean }
  | { op: 'clearRestore' }
  | { op: 'recordPending'; entry: HistoryRecord }
  | { op: 'discardPending'; txid: string }
  | { op: 'forgetSend'; txid: string }
  | { op: 'recordOutgoing'; row: HistoryRecord }
  | { op: 'recordIncoming'; row: HistoryRecord }
  | { op: 'dropRow'; key: string }
  | { op: 'expireRow'; key: string }
  | { op: 'markMempoolChecked'; asked: string[]; present: string[]; at: number };

/** What each operation answers. */
export interface LedgerAnswers {
  unspentHashes: string[];
  spendable: StoredUtxo[];
  forkCandidates: [number, string][];
  rollbackFloor: number;
  watchedCommitments: string[];
  /** JSON text: the identifiers are 64-bit values a JavaScript number cannot hold. */
  announcementFlags: string;
  /** JSON text, for the same reason. */
  absoluteIndexSets: string;
  scanBlocks: ScanResult;
  scanMempoolKernel: MempoolScan;
  startPass: Position;
  rollBack: null;
  persistScan: null;
  finishFastRestore: null;
  resetForRescan: null;
  clearRestore: null;
  recordPending: null;
  discardPending: null;
  forgetSend: null;
  /** Whether the row was written; false when it was there already. */
  recordOutgoing: boolean;
  recordIncoming: boolean;
  dropRow: null;
  expireRow: null;
  markMempoolChecked: null;
}

export type LedgerAnswer<O extends LedgerOp> = LedgerAnswers[O['op']];

/** The parts the app reads from the engine today. The rest are still read from the app's own database. */
export const ENGINE_PARTS: WalletPart[] = ['contacts', 'scan', 'sync', 'utxos', 'blocks', 'history'];

/** One edit to a wallet's sealed log; the names are the engine's. */
export type WalletChange =
  | { op: 'putContact'; contact: ContactRecord }
  | { op: 'deleteContact'; id: string };

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

  /**
   * Load the account into memory. Replaces any previously unlocked one.
   * `contentKey` is the key the wallet's sealed log is derived from: a new
   * wallet's envelope is sealed on the page, so the page has it once, and
   * hands it over with the phrase. It is zeroed on the way.
   */
  unlock(phrase: string[], network: string, contentKey?: Uint8Array): Promise<void>;
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
  // The wallet's data in the engine. Optional while it arrives: a core
  // without these keeps every part in the app's own database, as before.

  /** Open the unlocked wallet's sealed log. Returns the parts that live in it. */
  storeOpen?(accountId: string): Promise<WalletPart[]>;
  /**
   * Move one part over from the app's database. `dump` is what that
   * database holds for this wallet. Checked record for record before a byte
   * is written; throws, having changed nothing, when it would not come
   * through unchanged.
   */
  storeMigrate?(accountId: string, parts: WalletPart[], dump: unknown): Promise<void>;
  /** The records of one part, in the app's own shape. */
  storeRead?(accountId: string, part: WalletPart): Promise<unknown[]>;
  /** Write a batch of changes: on disk by the time this resolves, whole or not at all. */
  storeCommit?(accountId: string, changes: WalletChange[]): Promise<void>;
  /**
   * When the chain would not move: start the engine's copy afresh from what
   * the wallet's record says, for the sync to rebuild from the chain. `dump`
   * is as for storeMigrate. Nothing is deleted from the app's database.
   */
  storeRebuild?(accountId: string, dump: unknown): Promise<void>;
  /** Forget a wallet's log entirely. Needs no key: works on a locked wallet. */
  storeRemove?(accountId: string): Promise<void>;
  /** One ledger operation on the unlocked wallet's data. */
  ledger?<O extends LedgerOp>(accountId: string, op: O): Promise<LedgerAnswer<O>>;

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
