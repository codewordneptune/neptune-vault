// The send flow: plan inputs, fetch membership proofs, build
// the witness, prove in the prover worker, assemble, submit, and record the
// pending transaction with its inputs reserved. On any failure before
// submission nothing stays reserved.
//
// The coins and the pending row are the engine's to write. Holding a
// send's inputs, releasing them, and recording what became of it are each
// one operation, decided against the wallet as it is: a sync that marked a
// coin spent a moment earlier is not undone by a send that read it before.

import { NodeError, type NodeClient } from '../node/rpc';
import type { LedgerAnswer, LedgerOp, Prover, ProveOutcome, ProveProgress } from '../backend/types';
import type { HistoryRecord } from '../storage/db';
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

/** The most recipients one send pays: the core refuses more (`MAX_PAYMENTS` in send.rs). */
export const MAX_PAYMENTS = 10;

/** What the recipients of a send get together, in nau. */
export function paymentsTotalNau(request: SendRequest): bigint {
  return request.payments.reduce((sum, p) => sum + BigInt(p.amount_nau), 0n);
}

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

/**
 * The note kept about a wallet's last send that reached the node, in its
 * sealed log: what it paid and to whom, and whether the node answered.
 * Home shows it until it is dismissed or its row confirms, so a send that
 * ended while the app was locked, or closed, still says how it ended.
 */
export interface LastSend {
  at: number;
  accountId: string;
  txid: string;
  /** What the recipients get together, and the fee, in nau. */
  amountNau: string;
  feeNau: string;
  /** The first recipient; `others` counts the rest. */
  recipient: string;
  others: number;
  /** 'submitted': the node took it. 'unconfirmed': handed over, no answer. */
  state: 'submitted' | 'unconfirmed';
}

/** The person cancelled before anything was handed to the node. Nothing was sent and nothing is held. */
export class SendCancelledError extends Error {
  constructor() {
    super('Stopped. Nothing was sent.');
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
    super('This send may already be on its way. It is in History as pending, with its coins held. Do not send it again until it confirms or you give up on it.');
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
    private readonly node: NodeClient,
    private readonly core: WalletCore,
    private readonly prover: Prover,
    private readonly accountId: string,
    private readonly network: string,
    private readonly threads: number,
    /** Regtest nodes accept only mock proofs; the prover is bypassed there. */
    private readonly useMockProofs = false,
  ) {}

  private ledger<O extends LedgerOp>(op: O): Promise<LedgerAnswer<O>> {
    if (!this.core.ledger) return Promise.reject(new Error('This build of the wallet core keeps no wallet data.'));
    return this.core.ledger(this.accountId, op);
  }

  /** Unspent, unreserved, unlocked UTXOs available to spend. */
  spendable(nowMs = Date.now()): Promise<StoredUtxo[]> {
    return this.ledger({ op: 'spendable', now: nowMs });
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

    // The proof commits to the inputs as of one snapshot of the chain, and
    // blocks may be mined during the minutes of proving. Nodes from
    // neptune-core 0.18 on take a transaction built against any of the tip's
    // last three blocks and carry it forward; older nodes often take one a
    // block behind when that block left its coins alone. So a finished proof
    // is always offered to the node, and only when the node refuses it and
    // blocks have arrived meanwhile does the flow build on the new tip and
    // prove again, a few times at most.
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
          throw new Error('Nothing was sent. A new block arrived during the proof, and the wallet locked before the send could be rebuilt. Unlock and send again.');
        }
        throw e;
      }

      // A proof is made for the rules of the block that can confirm the
      // transaction: not the tip, which already exists, but the next one.
      // Every network is past the delta fork, whose proofs carry claim
      // version 8; any other version means rules this app does not know.
      const confirmationHeight = tipHeader.height + 1;
      const version = (await this.core.claimVersion?.(this.network, confirmationHeight)) ?? 8;
      onProgress({ stage: 'proving', claimVersion: version, note: again });
      if (version !== 8) throw new Error(`This version of the app cannot send under the network's current rules. Update the app.`);
      stopIfCancelled();
      let proving: ProveOutcome;
      try {
        proving = this.useMockProofs
          ? { proofCollection: await this.core.mockProofCollection(built.witness), seconds: 0, memoryMb: 0, threads: 0 }
          : await this.prover.prove(
              { witness: built.witness, network: this.network, blockHeight: confirmationHeight, threads: this.threads, inputs: plan.inputs.length },
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
        // Refused as unconfirmable. With blocks mined since the snapshot, the
        // proof was built too far behind the tip, or a new block touched its
        // coins: build on the new tip and prove again. With none, a coin it
        // spends is gone.
        if (await moved()) {
          if (attempt >= MAX_SEND_ATTEMPTS) throw new Error(`Nothing was sent: new blocks kept arriving during the proof. Try again in a moment.`);
          again = `A new block arrived, so the proof is being made again (attempt ${attempt + 1} of ${MAX_SEND_ATTEMPTS}). Nothing has been sent yet.`;
          continue;
        }
        throw new Error("Nothing was sent: the node says one of the coins is already spent. Rescan in Settings to refresh your coins, then try again.");
      }
      if (!accepted) {
        await this.discardPending(txid);
        throw new Error('Nothing was sent: the node did not accept the transaction.');
      }

      onProgress({ stage: 'done' });
      return { txid: built.summary.txid, proving, claimVersion: version };
    }
  }

  /** Mark the inputs reserved and add the pending history entry. */
  private async recordPending(txid: string, request: SendRequest, inputHashes: string[], amountNau: string, feeNau: string, changeNau: string | null, commitments: string[], note: string | null): Promise<void> {
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
      recipient: request.payments[0]?.recipient ?? null,
      payments: request.payments.map((p) => ({ recipient: p.recipient, amountNau: p.amount_nau })),
      error: null,
      changeNau,
      // Kernel order: one output per payment, in the request's order, then the change.
      outputs: commitments.map((commitment, i) => ({ commitment, role: i < request.payments.length ? 'recipient' : 'change' })),
      note,
    };
    // The inputs held and the row written, together.
    await this.ledger({ op: 'recordPending', entry });
  }

  /** The node refused it: release the inputs and drop the row, as if it had never been written. */
  private async discardPending(txid: string): Promise<void> {
    await this.ledger({ op: 'discardPending', txid });
  }

  /** Give up on a pending send: release its inputs and mark it failed. */
  async forget(txid: string): Promise<void> {
    await this.ledger({ op: 'forgetSend', txid });
  }
}
