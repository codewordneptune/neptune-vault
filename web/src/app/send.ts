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
import { cleanText } from '../util/text';
import type { LedgerAnswer, LedgerOp, Prover, ProveOutcome, ProveProgress } from '../backend/types';
import type { HistoryRecord } from '../storage/db';
import type { InputPlan, SendPlan, SendRequest, StoredUtxo, WalletCore } from '../backend/types';

export type SendStage = 'planning' | 'membership-proofs' | 'building' | 'proving' | 'confirming' | 'submitting' | 'done';

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

/** How the core says a block arrived between the proofs and the tip it read (`TIP_MOVED` in send.rs). */
const TIP_MOVED = 'a new block arrived while the send was being built';

/** How long a note to self on a send may be: a short line. */
export const SEND_NOTE_MAX = 120;

/** A note to self as kept: no characters that change how text around it reads, and cut to length. */
export function cleanNote(text: string): string {
  return cleanText(text).slice(0, SEND_NOTE_MAX);
}

/** What a send is told besides what to pay. */
export interface SendOptions {
  /** The person's note to self, kept with the send in History on this device; never sent anywhere. */
  note?: string | null;
  /** The person's Cancel. */
  signal?: AbortSignal;
  /** The person's confirmation, asked while the proof runs; see `send`. */
  approved?: Promise<boolean>;
  /** Called once the pending row is written, just before the node hears of the send. */
  onRecorded?: (txid: string) => void | Promise<void>;
  /** Sends given up on that may still pay the same person (givenUpRivals): this send spends a coin of each. */
  rivals?: HistoryRecord[];
}

/** Everyone a send row pays. */
function recipientsOf(h: HistoryRecord): string[] {
  return (h.payments?.length ? h.payments.map((p) => p.recipient) : h.recipient ? [h.recipient] : []).map((a) => a.toLowerCase());
}

/**
 * Sends given up on that may still go through and pay one of `recipients`:
 * given up rather than expired, stamped recently enough for a block to take
 * them, and spending only coins that are still free here. Giving up frees a
 * send's coins but cannot call it back, so a new send to the same person
 * spends one of the same coins: two transactions that spend one coin cannot
 * both confirm, and the person is not paid twice.
 */
export function givenUpRivals(history: HistoryRecord[], freeCoins: ReadonlySet<string>, recipients: string[], nowMs = Date.now()): HistoryRecord[] {
  const to = new Set(recipients.map((a) => a.trim().toLowerCase()));
  return history.filter(
    (h) =>
      h.kind === 'sent' &&
      h.status === 'failed' &&
      h.givenUp === true &&
      !h.expired &&
      (h.stampMs ?? h.timestampMs) + SEND_LIFETIME_MS > nowMs &&
      h.inputHashes.length > 0 &&
      h.inputHashes.every((coin) => freeCoins.has(coin)) &&
      recipientsOf(h).some((a) => to.has(a)),
  );
}

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

/**
 * The note written, in the wallet's sealed log, when a send starts, and
 * cleared when it ends, however it ends. Found at the next unlock, it is a
 * send the app was closed during: the wallet can then say how it ended.
 */
export interface SendStarted {
  at: number;
  accountId: string;
  amountNau: string;
  feeNau: string;
  recipient: string;
  others: number;
}

/** The person cancelled before anything was handed to the node. Nothing was sent and nothing is held. */
export class SendCancelledError extends Error {
  constructor() {
    super('Stopped. Nothing was sent.');
    this.name = 'SendCancelledError';
  }
}

/**
 * How long a send can wait for a block: a block may not carry a transaction
 * stamped more than three days before it, plus an hour for a reorganisation
 * (the engine's SEND_LIFETIME_MS, after which it releases the send's coins).
 */
export const SEND_LIFETIME_MS = (3 * 24 + 1) * 60 * 60 * 1000;

/** How long nodes keep a send waiting for a block before dropping it (neptune-core's mempool). */
export const MEMPOOL_KEEPS_MS = 10 * 60 * 60 * 1000;

/** What to do about a send that may have gone out: said wherever one is. */
export const MAY_HAVE_GONE =
  'It may have gone out: it shows in History, waiting for a block. Before you send it again, wait until History shows it as Sent or Not sent.';

/**
 * The transaction was handed to the node and no answer from the node came
 * back: none at all, or a server's error, or something that is not the
 * node's. It may have been sent. It stays in History as pending, with its
 * coins held, so that nobody pays twice on the strength of a lost answer.
 */
export class SendUnconfirmedError extends Error {
  constructor(
    public readonly txid: string,
    /** Why it is not known, when there is more to say than silence. */
    why?: string,
  ) {
    super(why ? `${why} ${MAY_HAVE_GONE}` : MAY_HAVE_GONE);
    this.name = 'SendUnconfirmedError';
  }
}

/** The person did not confirm the send (the password or passkey check was cancelled). Nothing was sent. */
export class SendNotApprovedError extends Error {
  constructor() {
    super('Not confirmed, so nothing was sent.');
    this.name = 'SendNotApprovedError';
  }
}

/**
 * The newest block's time and this device's clock, as far as a send is
 * concerned. A transaction is stamped with the time it is built at, and a
 * node refuses one stamped over a minute ahead of its own clock or more
 * than ten hours behind it (neptune-core's mempool): after minutes of
 * proving, and again on every retry. So the stamp is never later than the
 * newest block, which no node's clock is behind; and a device clock so far
 * behind that no stamp could pass is caught before proving starts.
 */
export function sendStamp(nowMs: number, tipTimestampMs: number | null): { stampMs: number; clockProblem: string | null } {
  if (tipTimestampMs === null || !Number.isFinite(tipTimestampMs) || tipTimestampMs <= 0) return { stampMs: nowMs, clockProblem: null };
  const behindMs = tipTimestampMs - nowMs;
  if (behindMs > 9 * 60 * 60 * 1000) {
    const hours = Math.round(behindMs / (60 * 60 * 1000));
    const how = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
    return {
      stampMs: nowMs,
      clockProblem: `Nothing was sent: this device's clock is ${how} behind the network, and nodes refuse a send stamped that far back. Set the date and time to automatic, then send again.`,
    };
  }
  return { stampMs: Math.min(nowMs, tipTimestampMs), clockProblem: null };
}

/** What a node's refusal of a send means, in words, for the refusals the app knows. */
function refusalText(e: Error): string | null {
  if (/FutureDated/.test(e.message)) return "Nothing was sent: the node says this send is dated in the future. This device's clock may be ahead; set the date and time to automatic, then send again.";
  if (/TooOld/.test(e.message)) return "Nothing was sent: the node says this send is dated too far in the past. Either this device's clock is behind, or the node is behind the network. Check the date and time, then try again, or choose another node in Settings.";
  return null;
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
   * The inputs for `request`, with a coin of each send in `rivals` among
   * them (see givenUpRivals). The core picks largest first; a rival's coin
   * it did not pick is added, or, when that one coin pays for the send by
   * itself, taken alone, which leaves less to prove.
   */
  private async planWith(spendable: StoredUtxo[], request: SendRequest, nowMs: number, rivals: HistoryRecord[]): Promise<InputPlan> {
    const plan = await this.core.planInputs(spendable, request, nowMs);
    const largest = (coins: StoredUtxo[]) => coins.reduce<StoredUtxo | undefined>((big, u) => (!big || BigInt(u.amount_nau) > BigInt(big.amount_nau) ? u : big), undefined);
    const added: StoredUtxo[] = [];
    for (const rival of rivals) {
      const theirs = spendable.filter((u) => rival.inputHashes.includes(u.hash));
      const covered = theirs.some((u) => plan.inputs.some((i) => i.hash === u.hash) || added.includes(u));
      const coin = covered ? undefined : largest(theirs);
      if (coin) added.push(coin);
    }
    if (added.length === 0) return plan;
    if (added.length === 1) {
      try {
        return await this.core.planInputs(added, request, nowMs);
      } catch {
        // Not enough by itself: added to the plan below.
      }
    }
    const inputs = [...plan.inputs, ...added];
    return {
      inputs,
      absolute_index_sets: JSON.parse(await this.core.absoluteIndexSets(inputs)) as unknown[],
      total_in_nau: inputs.reduce((sum, u) => sum + BigInt(u.amount_nau), 0n).toString(),
    };
  }

  /**
   * `signal` is the person's Cancel. It is honoured up to the moment the
   * transaction is handed to the node, and checked right before that
   * moment; after it, the send goes through and says so, because a screen
   * that says "cancelled" over a payment that went out invites a second one.
   *
   * `approved`, when given, is the person's confirmation (a password or a
   * passkey), asked while the proof runs: nothing is handed to the node
   * until it resolves true, and false ends the send with nothing sent.
   */
  async send(request: SendRequest, onProgress: (p: SendProgress) => void, options: SendOptions = {}): Promise<SendOutcome> {
    const { note = null, signal, approved, onRecorded, rivals = [] } = options;
    const stopIfCancelled = () => {
      if (signal?.aborted) throw new SendCancelledError();
    };
    onProgress({ stage: 'planning' });
    // The stamp and the time-lock check both go by the newest block's time
    // when the device's clock is ahead of it (see sendStamp).
    const tip = await this.node.tipHeader();
    const first = sendStamp(Date.now(), tip.timestamp);
    if (first.clockProblem) throw new Error(first.clockProblem);
    const plan = await this.planWith(await this.spendable(first.stampMs), request, first.stampMs, rivals);

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
      const stamp = sendStamp(Date.now(), tipHeader.timestampMs).stampMs;
      try {
        built = await this.core.buildSend(plan.inputs, snapshotResponse, tipHeader.raw, request, stamp);
      } catch (e) {
        if (e instanceof Error && e.message.includes('lustration')) throw new RequiresLustrationError();
        // A block between the two questions above: nothing is proved yet, so
        // ask again, as a block during proving would. Nothing to tell.
        if (e instanceof Error && e.message.includes(TIP_MOVED)) {
          if (attempt >= MAX_SEND_ATTEMPTS) throw new Error('Nothing was sent: new blocks kept arriving while the send was being built. Try again in a moment.');
          continue;
        }
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
      // The person's confirmation, asked while the proof ran, is awaited
      // before anything reaches the node: said as what it is, not as a send
      // already on its way.
      if (approved) {
        onProgress({ stage: 'confirming', note: again });
        if (!(await approved)) throw new SendNotApprovedError();
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
      await this.recordPending(txid, request, built.summary, note);
      await onRecorded?.(txid);
      let accepted: boolean | null;
      try {
        accepted = await this.node.submitTransaction(transaction);
      } catch (e) {
        // Only the node's own answer says what it did. No answer, a server's
        // error (a gateway in front of a slow node answers 504 whether or not
        // the node took it), or something that is not the node's: it may
        // have been taken, and everything stays held.
        if (!(e instanceof NodeError) || typeof e.code !== 'number') {
          const why =
            e instanceof NodeError && e.code === 'http'
              ? `The node's server answered with an error (HTTP ${e.status}), so it is not known whether this send went out.`
              : e instanceof NodeError && e.code === 'garbled'
                ? "The node's answer could not be read, so it is not known whether this send went out."
                : undefined;
          throw new SendUnconfirmedError(txid, why);
        }
        // The node answered, and the answer was no: nothing is out there.
        await this.discardPending(txid);
        const known = refusalText(e);
        if (known) throw new Error(known);
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
        throw new Error('Nothing was sent: the node says one of the coins is already spent. Wait for the next block, then try again; if it keeps happening, rescan in Settings to refresh your coins.');
      }
      if (accepted === null) throw new SendUnconfirmedError(txid, "The node's answer did not say whether it took this send.");
      if (!accepted) {
        await this.discardPending(txid);
        throw new Error('Nothing was sent: the node did not accept it.');
      }

      onProgress({ stage: 'done' });
      return { txid: built.summary.txid, proving, claimVersion: version };
    }
  }

  /** Mark the inputs reserved and add the pending history entry. */
  private async recordPending(txid: string, request: SendRequest, summary: SendPlan['summary'], note: string | null): Promise<void> {
    const commitments = summary.output_commitments ?? [];
    const entry: HistoryRecord = {
      key: `${this.accountId}:sent:${txid}`,
      accountId: this.accountId,
      kind: 'sent',
      status: 'pending',
      txid,
      amountNau: summary.amount_nau,
      feeNau: summary.fee_nau,
      timestampMs: Date.now(),
      height: null,
      inputHashes: summary.input_hashes,
      recipient: request.payments[0]?.recipient ?? null,
      payments: request.payments.map((p) => ({ recipient: p.recipient, amountNau: p.amount_nau })),
      error: null,
      changeNau: summary.change_nau,
      // Kernel order: one output per payment, in the request's order, then the change.
      outputs: commitments.map((commitment, i) => ({ commitment, role: i < request.payments.length ? 'recipient' : 'change' })),
      note,
      // The transaction's own timestamp: three days of the chain's time
      // after it, no block can take the send (see the engine's expire_sends).
      stampMs: summary.timestamp_ms,
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
