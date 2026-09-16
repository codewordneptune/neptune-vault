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
  /** With the first proving report: which prover the chain asked for. */
  claimVersion?: number;
  /** Why the flow started over, when it did: shown on the strip. */
  note?: string;
}

/** How many times a send is rebuilt and proved again after a block arrived during proving. */
export const MAX_SEND_ATTEMPTS = 3;

/** The node's answer when a transaction no longer fits the chain: a stale snapshot, or an input already spent. */
function isNotConfirmable(e: unknown): boolean {
  return e instanceof Error && /NotConfirmable/.test(e.message);
}

export interface SendOutcome {
  txid: string;
  proving: ProveOutcome;
  claimVersion: number;
}

/** The prover as the send flow needs it; the real one is ProverClient. */
export interface Prover {
  prove(
    request: { witness: Uint8Array; network: string; blockHeight: number; threads: number; legacy?: boolean },
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

  async send(request: SendRequest, onProgress: (p: SendProgress) => void, note: string | null = null): Promise<SendOutcome> {
    const now = Date.now();
    onProgress({ stage: 'planning' });
    const plan = await this.core.planInputs(await this.spendable(now), request, now);

    // The proof commits to the inputs as of one snapshot of the chain. A
    // block mined during the minutes of proving makes that snapshot stale
    // and the node refuses the transaction, so the flow checks the tip
    // before submitting and starts over, a few times, rather than spending
    // the proof on a submission that cannot succeed.
    let again: string | undefined;
    for (let attempt = 1; ; attempt++) {
      onProgress({ stage: 'membership-proofs', note: again });
      // Read the proofs before the header so a tip moving in between fails the
      // height check inside build_send rather than yielding mismatched data.
      const snapshotResponse = await this.node.restoreMembershipProofRaw(plan.absolute_index_sets);
      const tipHeader = await this.node.tipHeaderRaw();

      onProgress({ stage: 'building', note: again });
      let built;
      try {
        built = await this.core.buildSend(plan.inputs, snapshotResponse, tipHeader.raw, request, Date.now());
      } catch (e) {
        if (e instanceof Error && e.message.includes('lustration')) throw new RequiresLustrationError();
        throw e;
      }

      // Before the delta fork the rules want claim version 5, produced by the
      // pre-fork prover package; after it, version 8 from the current one.
      const version = (await this.core.claimVersion?.(this.network, tipHeader.height)) ?? 8;
      onProgress({ stage: 'proving', claimVersion: version, note: again });
      if (version !== 5 && version !== 8) throw new Error(`This wallet cannot prove transactions for claim version ${version}`);
      const proving: ProveOutcome = this.useMockProofs
        ? { proofCollection: await this.core.mockProofCollection(built.witness), seconds: 0, memoryMb: 0, threads: 0 }
        : await this.prover.prove(
            { witness: built.witness, network: this.network, blockHeight: tipHeader.height, threads: this.threads, legacy: version === 5 },
            (p) => onProgress({ stage: 'proving', proving: p, note: again }),
          );

      const moved = async () => (await this.node.tipHeaderRaw()).height !== tipHeader.height;
      if (await moved()) {
        if (attempt >= MAX_SEND_ATTEMPTS) throw new Error(`A new block arrived while each proof was being made, ${MAX_SEND_ATTEMPTS} times over. Nothing was sent; try again in a moment.`);
        again = `A block arrived while the proof was being made. Building and proving again (${attempt + 1} of ${MAX_SEND_ATTEMPTS}).`;
        continue;
      }

      onProgress({ stage: 'submitting', note: again });
      const transaction = await this.core.assembleSubmission(built.kernel, proving.proofCollection);
      let accepted: boolean;
      try {
        accepted = await this.node.submitTransaction(transaction);
      } catch (e) {
        if (!isNotConfirmable(e)) throw e;
        if ((await moved()) && attempt < MAX_SEND_ATTEMPTS) {
          again = `A block arrived just before the transaction reached the node. Building and proving again (${attempt + 1} of ${MAX_SEND_ATTEMPTS}).`;
          continue;
        }
        throw new Error("The node rejected the transaction: one of its coins seems to be spent already. Nothing was sent. Rescan in Settings to refresh this wallet's view of its coins, then try again.");
      }
      if (!accepted) throw new Error('the node did not accept the transaction');

      await this.recordPending(built.summary.txid, request, built.summary.input_hashes, built.summary.amount_nau, built.summary.fee_nau, built.summary.change_nau, built.summary.output_commitments ?? [], note);
      onProgress({ stage: 'done' });
      return { txid: built.summary.txid, proving, claimVersion: version };
    }
  }

  /** Mark the inputs reserved and add the pending history entry (R18). */
  private async recordPending(txid: string, request: SendRequest, inputHashes: string[], amountNau: string, feeNau: string, changeNau: string | null, commitments: string[], note: string | null): Promise<void> {
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
      changeNau,
      // Kernel order: the recipient's output first, the change last.
      outputs: commitments.map((commitment, i) => ({ commitment, role: i === 0 ? 'recipient' : 'change' })),
      note,
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
