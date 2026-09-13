// The send flow (F15 to F18): plan inputs, fetch membership proofs, build
// the witness, prove in the prover worker, assemble, submit, and record the
// pending transaction with its inputs reserved. On any failure before
// submission nothing stays reserved.

import type { NodeClient } from '../node/rpc';
import type { ProveOutcome, ProveProgress } from '../prover/client';
import type { HistoryRecord, VaultDb } from '../storage/db';
import type { SendRequest, StoredUtxo, WalletCore } from '../wallet/core';

export type SendStage = 'planning' | 'membership-proofs' | 'building' | 'proving' | 'submitting' | 'done';

export interface SendProgress {
  stage: SendStage;
  proving?: ProveProgress;
}

export interface SendOutcome {
  txid: string;
  proving: ProveOutcome;
}

/** The prover as the send flow needs it; the real one is ProverClient. */
export interface Prover {
  prove(
    request: { witness: Uint8Array; network: string; blockHeight: number; threads: number },
    onProgress: (p: ProveProgress) => void,
  ): Promise<ProveOutcome>;
}

export class RequiresLustrationError extends Error {
  constructor() {
    super('this send requires lustration announcements; confirm to proceed');
    this.name = 'RequiresLustrationError';
  }
}

export class SendService {
  constructor(
    private readonly db: VaultDb,
    private readonly node: NodeClient,
    private readonly core: WalletCore,
    private readonly prover: Prover,
    private readonly accountId: string,
    private readonly network: string,
    private readonly threads: number,
    /** Regtest nodes accept only mock proofs; the prover is bypassed there. */
    private readonly useMockProofs = false,
  ) {}

  /** Unspent, unreserved, unlocked UTXOs available to spend. */
  async spendable(nowMs = Date.now()): Promise<StoredUtxo[]> {
    const rows = await this.db.getAllFromIndex('utxos', 'byAccount', this.accountId);
    return rows
      .filter((r) => r.spentHeight === null && r.pendingTxid === null && (r.releaseDateMs === null || r.releaseDateMs <= nowMs))
      .map((r) => r.stored as StoredUtxo);
  }

  async send(request: SendRequest, onProgress: (p: SendProgress) => void): Promise<SendOutcome> {
    const now = Date.now();
    onProgress({ stage: 'planning' });
    const plan = await this.core.planInputs(await this.spendable(now), request, now);

    onProgress({ stage: 'membership-proofs' });
    // Read the proofs before the header so a tip moving in between fails the
    // height check inside build_send rather than yielding mismatched data.
    const snapshot = await this.node.restoreMembershipProof(plan.absolute_index_sets);
    const tipHeader = await this.node.tipHeader();

    onProgress({ stage: 'building' });
    let built;
    try {
      built = await this.core.buildSend(plan.inputs, snapshot, tipHeader, request, Date.now());
    } catch (e) {
      if (e instanceof Error && e.message.includes('lustration')) throw new RequiresLustrationError();
      throw e;
    }

    onProgress({ stage: 'proving' });
    const proving: ProveOutcome = this.useMockProofs
      ? { proofCollection: await this.core.mockProofCollection(built.witness), seconds: 0, memoryMb: 0, threads: 0 }
      : await this.prover.prove(
          { witness: built.witness, network: this.network, blockHeight: tipHeader.height, threads: this.threads },
          (p) => onProgress({ stage: 'proving', proving: p }),
        );

    onProgress({ stage: 'submitting' });
    const transaction = await this.core.assembleSubmission(built.kernel, proving.proofCollection);
    const accepted = await this.node.submitTransaction(transaction);
    if (!accepted) throw new Error('the node did not accept the transaction');

    await this.recordPending(built.summary.txid, request, built.summary.input_hashes, built.summary.amount_nau, built.summary.fee_nau);
    onProgress({ stage: 'done' });
    return { txid: built.summary.txid, proving };
  }

  /** Mark the inputs reserved and add the pending history entry (R18). */
  private async recordPending(txid: string, request: SendRequest, inputHashes: string[], amountNau: string, feeNau: string): Promise<void> {
    const tx = this.db.transaction(['utxos', 'history'], 'readwrite');
    for (const hash of inputHashes) {
      const key = `${this.accountId}:${hash}`;
      const row = await tx.objectStore('utxos').get(key);
      if (row) await tx.objectStore('utxos').put({ ...row, pendingTxid: txid });
    }
    const entry: HistoryRecord = {
      key: `${this.accountId}:sent:${txid}`,
      accountId: this.accountId,
      kind: 'sent',
      status: 'pending',
      txid,
      amountNau,
      feeNau,
      timestampMs: Date.now(),
      height: null,
      inputHashes,
      recipient: request.recipient,
      error: null,
    };
    await tx.objectStore('history').put(entry);
    await tx.done;
  }

  /** Give up on a pending send: release its inputs and mark it failed. */
  async forget(txid: string): Promise<void> {
    const tx = this.db.transaction(['utxos', 'history'], 'readwrite');
    const entry = await tx.objectStore('history').get(`${this.accountId}:sent:${txid}`);
    if (!entry) return;
    for (const hash of entry.inputHashes) {
      const key = `${this.accountId}:${hash}`;
      const row = await tx.objectStore('utxos').get(key);
      if (row && row.pendingTxid === txid && row.spentHeight === null) {
        await tx.objectStore('utxos').put({ ...row, pendingTxid: null });
      }
    }
    await tx.objectStore('history').put({ ...entry, status: 'failed', error: 'abandoned by the user' });
    await tx.done;
  }
}
