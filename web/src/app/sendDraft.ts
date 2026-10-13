// A Send form left half filled, per wallet, for this session: going to
// Contacts to add the person being paid, or anywhere else, and coming back
// finds it as it was. In memory only; a reload starts afresh. A form whose
// send has started is no draft: it is gone once the send begins, so a
// payment made never comes back pre-filled to be made twice. That holds
// however the Send screen closes, a lock landing as the send ends included,
// because a draft that would pay what the wallet's last recorded send paid
// is refused here.

import type { Payment } from '../backend/types';

/** A recipient after the first: an address, an amount, and what is wrong with them. */
export interface ExtraPayee {
  id: number;
  recipient: string;
  amount: string;
  recipientError: string | null;
  amountError: string | null;
}

export interface SendDraft {
  recipient: string;
  amount: string;
  extras: ExtraPayee[];
  feePreset: string;
  fee: string;
  linkMeta: { label?: string; message?: string } | null;
  /** The note to self, as typed or as a request's message filled it in. */
  note: string;
}

/** A payment as the form states it: an address and an amount, as typed. */
type Typed = Pick<Payment, 'recipient' | 'amount'>;

const drafts = new Map<string, SendDraft>();
/** What each wallet's last recorded send paid, as `paid` spells it. */
const recorded = new Map<string, string>();

const paid = (payments: Typed[]) => JSON.stringify(payments.map((p) => [p.recipient.trim().toLowerCase(), p.amount.trim()]));
const paymentsOf = (draft: SendDraft): Typed[] => [{ recipient: draft.recipient, amount: draft.amount }, ...draft.extras];

export function sendDraft(accountId: string): SendDraft | undefined {
  return drafts.get(accountId);
}

export function keepSendDraft(accountId: string, draft: SendDraft): void {
  if (recorded.get(accountId) === paid(paymentsOf(draft))) drafts.delete(accountId);
  else drafts.set(accountId, draft);
}

/**
 * A send is recorded and about to reach the node: a form paying the same
 * is never kept as a draft, until the wallet's next send is recorded.
 */
export function sendRecorded(accountId: string, payments: Typed[]): void {
  recorded.set(accountId, paid(payments));
  drafts.delete(accountId);
}

/** Forget a wallet's draft: its send started, or the wallet was removed. */
export function clearSendDraft(accountId: string): void {
  drafts.delete(accountId);
}
