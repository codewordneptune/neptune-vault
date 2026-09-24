// A Send form left half filled, per wallet, for this session: going to
// Contacts to add the person being paid, or anywhere else, and coming back
// finds it as it was. In memory only; a reload starts afresh. A form whose
// send has started is no draft: it is gone once the send begins, so a
// payment made never comes back pre-filled to be made twice.

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
}

const drafts = new Map<string, SendDraft>();

export function sendDraft(accountId: string): SendDraft | undefined {
  return drafts.get(accountId);
}

export function keepSendDraft(accountId: string, draft: SendDraft): void {
  drafts.set(accountId, draft);
}

/** Forget a wallet's draft: its send started, or the wallet was removed. */
export function clearSendDraft(accountId: string): void {
  drafts.delete(accountId);
}
