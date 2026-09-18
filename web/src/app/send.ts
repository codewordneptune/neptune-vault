// The send flow (F15 to F18): plan inputs, fetch membership proofs, build
// the witness, prove in the prover worker, assemble, submit, and record the
// pending transaction with its inputs reserved. On any failure before
// submission nothing stays reserved.

import { NodeError, type NodeClient } from '../node/rpc';
import type { Prover, ProveOutcome, ProveProgress } from '../backend/types';
import type { HistoryRecord, VaultDb } from '../storage/db';
import type { SendRequest, StoredUtxo, WalletCore } from '../backend/types';

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

/** A send is already running; this one was not started and changed nothing. */
export class SendBusyError extends Error {
  constructor() {
    super('A send is already running.');
    this.name = 'SendBusyError';
  }
}

/** The person cancelled before anything was handed to the node. Nothing was sent and nothing is held. */
export class SendCancelledError extends Error {
  constructor() {
    super('Cancelled. Nothing was sent.');
    this.name = 'SendCancelledError';
  }
}

/**
 * The transaction was handed to the node and no answer came back: it may
 * have been sent. It stays in History as pending, with its coins held, so
 * that nobody pays twice on the strength of a lost answer.
 */
export class SendUnconfirmedError extends Error {
  constructor(public readonly txid: string) {
    super('The node did not answer, so it is not known whether it took the transaction. It may have been sent. It is kept in History as pending with its coins held: it will show as confirmed if it went through, and you can give up on it there if it did not. Do not send it again before then.');
    this.name = 'SendUnconfirmedError';
  }
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

  /**
   * `signal` is the person's Cancel. It is honoured up to the moment the
   * transaction is handed to the node, and checked right before that
   * moment; after it, the send goes through and says so, because a screen
   * that says "cancelled" over a payment that went out invites a second one.
   */
  async send(request: SendRequest, onProgress: (p: SendProgress) => void, note: string | null = null, signal?: AbortSignal): Promise<SendOutcome> {
    const stopIfCancelled = () => {
      if (signal?.aborted) throw new SendCancelledError();
    };
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
      stopIfCancelled();
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
        // Locking by hand during a proof is fine as long as the proof can be
        // used. A block that arrives meanwhile means building again, and
        // building needs the keys, which a locked wallet does not have.
        if (attempt > 1 && e instanceof Error && /wallet is locked/i.test(e.message)) {
          throw new Error('A new block arrived during the proof, so the transaction had to be built again, and the wallet had been locked meanwhile. Nothing was sent. Unlock and send again.');
        }
        throw e;
      }

      // Before the delta fork the rules want claim version 5, produced by the
      // pre-fork prover package; after it, version 8 from the current one.
      const version = (await this.core.claimVersion?.(this.network, tipHeader.height)) ?? 8;
      onProgress({ stage: 'proving', claimVersion: version, note: again });
      if (version !== 5 && version !== 8) throw new Error(`This wallet cannot prove transactions for claim version ${version}`);
      stopIfCancelled();
      let proving: ProveOutcome;
      try {
        proving = this.useMockProofs
          ? { proofCollection: await this.core.mockProofCollection(built.witness), seconds: 0, memoryMb: 0, threads: 0 }
          : await this.prover.prove(
              { witness: built.witness, network: this.network, blockHeight: tipHeader.height, threads: this.threads, legacy: version === 5, inputs: plan.inputs.length },
              (p) => onProgress({ stage: 'proving', proving: p, note: again }),
            );
      } catch (e) {
        if (signal?.aborted) throw new SendCancelledError();
        throw e;
      }
      // The proof is made; what follows is quick and is not a time to offer
      // Cancel as if minutes of work were still ahead.
      onProgress({ stage: 'submitting', note: again });

      const moved = async () => (await this.node.tipHeaderRaw()).height !== tipHeader.height;
      if (await moved()) {
        if (attempt >= MAX_SEND_ATTEMPTS) throw new Error(`A new block arrived while each proof was being made, ${MAX_SEND_ATTEMPTS} times over. Nothing was sent; try again in a moment.`);
        again = `A block arrived while the proof was being made. Building and proving again (${attempt + 1} of ${MAX_SEND_ATTEMPTS}).`;
        continue;
      }

      const transaction = await this.core.assembleSubmission(built.kernel, proving.proofCollection);
      // The last moment Cancel means anything.
      stopIfCancelled();
      // The send is written down, and its coins held, before the node hears
      // of it. If the answer is lost on the way back (a phone changing
      // networks, a tab killed), the wallet still knows a payment may be out
      // there, and a second attempt cannot quietly pick the same coins or,
      // after the first confirms, different ones.
      const txid = built.summary.txid;
      await this.recordPending(txid, request, built.summary.input_hashes, built.summary.amount_nau, built.summary.fee_nau, built.summary.change_nau, built.summary.output_commitments ?? [], note);
      let accepted: boolean;
      try {
        accepted = await this.node.submitTransaction(transaction);
      } catch (e) {
        // No answer at all: it may have been taken. Everything stays held.
        if (e instanceof NodeError && (e.code === 'timeout' || e.code === 'network')) throw new SendUnconfirmedError(txid);
        // The node answered, and the answer was no: nothing is out there.
        await this.discardPending(txid);
        if (!isNotConfirmable(e)) throw e;
        if ((await moved()) && attempt < MAX_SEND_ATTEMPTS) {
          again = `A block arrived just before the transaction reached the node. Building and proving again (${attempt + 1} of ${MAX_SEND_ATTEMPTS}).`;
          continue;
        }
        throw new Error("The node rejected the transaction: one of its coins seems to be spent already. Nothing was sent. Rescan in Settings to refresh this wallet's view of its coins, then try again.");
      }
      if (!accepted) {
        await this.discardPending(txid);
        throw new Error('The node did not accept the transaction. Nothing was sent.');
      }

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

  /** The node refused it: release the inputs and drop the row, as if it had never been written. */
  private async discardPending(txid: string): Promise<void> {
    const tx = this.db.transaction(['utxos', 'history'], 'readwrite');
    const entry = await tx.objectStore('history').get(`${this.accountId}:sent:${txid}`);
    if (entry) {
      for (const hash of entry.inputHashes) {
        const row = await tx.objectStore('utxos').get(`${this.accountId}:${hash}`);
        if (row && row.pendingTxid === txid && row.spentHeight === null) await tx.objectStore('utxos').put({ ...row, pendingTxid: null });
      }
      await tx.objectStore('history').delete(entry.key);
    }
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
    await tx.objectStore('history').put({ ...entry, status: 'failed', error: 'You gave up on this send.' });
    await tx.done;
  }
}
