// What pending sends do to the balance, worked out once for every screen.
// Each counts as gone: its amount and its fee, or only the fee when it pays
// this wallet's own addresses. The coins that pay for it cannot be spent
// until a block confirms it, and the change they bring back is "on hold".
// So what can be spent now plus what is on hold is the balance Home shows,
// on Home, on Send and wherever else the two figures appear.

import { useEffect, useState } from 'react';

import { useApp } from './AppContext';
import { ownAddresses } from './ownAddresses';
import type { HistoryRecord } from '../storage/db';

export interface PendingSends {
  /** This wallet's sends waiting for a block. */
  sends: HistoryRecord[];
  /** False while it is still being worked out which of them pay this wallet's own addresses. */
  ready: boolean;
  /** Whether an address is one of this wallet's own, as far as is known yet. */
  isOwn: (address: string) => boolean;
  /** Whether a send pays only this wallet's own addresses: a move, which loses only its fee. */
  toSelf: (h: HistoryRecord) => boolean;
  /** The balance, with the pending sends counted as gone. */
  balanceNau: bigint;
  /** The change the pending sends bring back once confirmed: the balance less what can be spent now. */
  onHoldNau: bigint;
}

export function usePendingSends(): PendingSends {
  const { services, account, history, balance } = useApp();
  const sends = history.filter((h) => h.kind === 'sent' && h.status === 'pending');
  // A send to one of this wallet's own addresses is known as one once its
  // coins come back in a block. Until then, its recipients are checked
  // against the addresses Receive offers, so it does not read as money out.
  const toCheck = sends.some((h) => h.recipient !== null);
  const [own, setOwn] = useState<{ accountId: string; set: Set<string> } | null>(null);
  useEffect(() => {
    if (!account || !toCheck) return;
    let live = true;
    void ownAddresses(services.core, account).then((set) => live && setOwn({ accountId: account.id, set }));
    return () => {
      live = false;
    };
  }, [services, account, toCheck]);
  // Until they are known for this wallet, the figures wait rather than count
  // a move to oneself as money out and then jump back.
  const ready = !toCheck || own?.accountId === account?.id;
  const isOwn = (address: string) => own?.accountId === account?.id && Boolean(own?.set.has(address.toLowerCase()));
  const toSelf = (h: HistoryRecord) => {
    const to = (h.payments?.length ? h.payments.map((p) => p.recipient) : h.recipient ? [h.recipient] : []).map((a) => a.toLowerCase());
    return to.length > 0 && to.every(isOwn);
  };
  const leavingNau = sends.reduce((sum, h) => sum + (toSelf(h) ? 0n : BigInt(h.amountNau)) + BigInt(h.feeNau ?? '0'), 0n);
  const balanceNau = balance.spendableNau + balance.reservedNau - leavingNau;
  const onHoldNau = balanceNau > balance.spendableNau ? balanceNau - balance.spendableNau : 0n;
  return { sends, ready, isOwn, toSelf, balanceNau, onHoldNau };
}
