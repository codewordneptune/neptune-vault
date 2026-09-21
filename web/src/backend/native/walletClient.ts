// The wallet core, when the shell hosts it.
//
// Every method is one command. The shell holds the unlocked account in Rust
// memory exactly as the worker does in the browser, so the seed still never
// reaches this side of the boundary, and locking still means the account is
// dropped where it lives rather than where it is displayed.

import type { SeedEnvelope } from '../../storage/db';
import type {
  InputPlan,
  KeyKind,
  LedgerAnswer,
  LedgerOp,
  WalletChange,
  WalletPart,
  MempoolScan,
  NextKeyIndices,
  ScanExpectation,
  ScanResult,
  SendPlan,
  SendRequest,
  StoredUtxo,
  WalletCore,
} from '../types';
import { call, fromBase64, toBase64 } from './bridge';

/** A send plan as it comes over the wire, with its two byte fields encoded. */
interface WirePlan {
  witness: string;
  kernel: string;
  summary: SendPlan['summary'];
}

export class NativeWalletClient implements WalletCore {
  coreVersion(): Promise<string> {
    return call('wallet_core_version');
  }

  claimVersion(network: string, blockHeight: number): Promise<number> {
    return call('wallet_claim_version', { network, blockHeight });
  }

  generatePhrase(): Promise<string[]> {
    return call('wallet_generate_phrase');
  }

  async deriveKey(
    password: Uint8Array,
    salt: Uint8Array,
    mKib: number,
    tCost: number,
    pCost: number,
  ): Promise<Uint8Array> {
    const key = await call<string>('wallet_derive_key', {
      password: toBase64(password),
      salt: toBase64(salt),
      mKib,
      tCost,
      pCost,
    });
    return fromBase64(key);
  }

  parseAmount(text: string): Promise<string> {
    return call('wallet_parse_amount', { text });
  }

  formatAmount(nau: string): Promise<string> {
    return call('wallet_format_amount', { nau });
  }

  isValidAddress(encoded: string, network: string): Promise<boolean> {
    return call('wallet_is_valid_address', { encoded, network });
  }

  phraseProblem(words: string[]): Promise<string | null> {
    return call('wallet_phrase_problem', { words });
  }

  unlock(phrase: string[], network: string, contentKey?: Uint8Array): Promise<void> {
    const key = contentKey ? toBase64(contentKey) : null;
    contentKey?.fill(0);
    return call('wallet_unlock', { phrase, network, contentKey: key });
  }

  // The wallet's data: the engine's sealed logs, kept by the shell in files.

  storeOpen(accountId: string): Promise<WalletPart[]> {
    return call('store_open', { accountId });
  }

  storeMigrate(accountId: string, parts: WalletPart[], dump: unknown): Promise<void> {
    return call('store_migrate', { accountId, parts, dump });
  }

  storeRebuild(accountId: string, dump: unknown): Promise<void> {
    return call('store_rebuild', { accountId, dump });
  }

  storeRead(accountId: string, part: WalletPart): Promise<unknown[]> {
    return call('store_read', { accountId, part });
  }

  storeCommit(accountId: string, changes: WalletChange[]): Promise<void> {
    return call('store_commit', { accountId, changes });
  }

  storeRemove(accountId: string): Promise<void> {
    return call('store_remove', { accountId });
  }

  ledger<O extends LedgerOp>(accountId: string, op: O): Promise<LedgerAnswer<O>> {
    return call('wallet_ledger', { accountId, op });
  }

  unlockEnvelope(envelope: SeedEnvelope, password: string, network: string): Promise<void> {
    return call('wallet_unlock_envelope', { envelope, password, network });
  }

  unlockEnvelopeWithSecret(
    envelope: SeedEnvelope,
    wrapped: { iv: string; ciphertext: string },
    secret: Uint8Array,
    network: string,
  ): Promise<void> {
    return call('wallet_unlock_envelope_with_secret', {
      envelope,
      wrapped,
      secret: toBase64(secret),
      network,
    });
  }

  openEnvelope(envelope: SeedEnvelope, password: string, wantPhrase: boolean): Promise<string[] | null> {
    return call('wallet_open_envelope', { envelope, password, wantPhrase });
  }

  /**
   * There is no worker to end here. Dropping the account is what `terminate`
   * is for, and the shell does that on `lock`, so ask for it and do not wait:
   * the interface is synchronous because the browser's is.
   */
  terminate(): void {
    void call('wallet_lock').catch(() => {});
  }

  lock(): Promise<void> {
    return call('wallet_lock');
  }

  isUnlocked(): Promise<boolean> {
    return call('wallet_is_unlocked');
  }

  address(kind: KeyKind, index: number): Promise<string> {
    return call('wallet_address', { kind, index });
  }

  announcementFlags(nextKeyIndices: NextKeyIndices): Promise<string> {
    return call('wallet_announcement_flags', { nextKeyIndices });
  }

  absoluteIndexSets(unspent: StoredUtxo[]): Promise<string> {
    return call('wallet_absolute_index_sets', { unspent });
  }

  scanBlocks(
    blocksResponse: string,
    unspent: StoredUtxo[],
    nextKeyIndices: NextKeyIndices,
    expectation: ScanExpectation,
  ): Promise<ScanResult> {
    return call('wallet_scan_blocks', { blocksResponse, unspent, nextKeyIndices, expectation });
  }

  scanMempoolKernel(
    kernelResponse: string,
    unspent: StoredUtxo[],
    nextKeyIndices: NextKeyIndices,
    tipHeight: number,
  ): Promise<MempoolScan> {
    return call('wallet_scan_mempool_kernel', { kernelResponse, unspent, nextKeyIndices, tipHeight });
  }

  planInputs(unspent: StoredUtxo[], request: SendRequest, nowMs: number): Promise<InputPlan> {
    return call('wallet_plan_inputs', { unspent, request, nowMs });
  }

  async buildSend(
    inputs: StoredUtxo[],
    snapshotResponse: string,
    tipHeaderResponse: string,
    request: SendRequest,
    nowMs: number,
  ): Promise<SendPlan> {
    const plan = await call<WirePlan>('wallet_build_send', {
      inputs,
      snapshotResponse,
      tipHeaderResponse,
      request,
      nowMs,
    });
    return { witness: fromBase64(plan.witness), kernel: fromBase64(plan.kernel), summary: plan.summary };
  }

  async mockProofCollection(witness: Uint8Array): Promise<Uint8Array> {
    const proof = await call<string>('wallet_mock_proof_collection', { witness: toBase64(witness) });
    return fromBase64(proof);
  }

  assembleSubmission(kernel: Uint8Array, proofCollection: Uint8Array): Promise<unknown> {
    return call('wallet_assemble_submission', {
      kernel: toBase64(kernel),
      proofCollection: toBase64(proofCollection),
    });
  }
}
