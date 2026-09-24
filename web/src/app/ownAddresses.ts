// This wallet's own addresses as Receive offers them (each kind up to the
// first unused one and the few after it), per wallet, for this session:
// enough to tell a pending send to oneself from one that leaves. Kept by
// the key counters too, so an address added since is known; forgotten with
// the wallet.

import { KEY_LOOKAHEAD, type KeyKind, type WalletCore } from '../backend/types';
import { nextKeyIndicesOf, type AccountRecord } from '../storage/db';

const known = new Map<string, Promise<Set<string>>>();

export function ownAddresses(core: Pick<WalletCore, 'address'>, account: AccountRecord): Promise<Set<string>> {
  const next = nextKeyIndicesOf(account);
  const key = `${account.id}:${next.generation}:${next.ec_hybrid}:${next.viewing}`;
  let set = known.get(key);
  if (!set) {
    set = (async () => {
      const all = new Set<string>();
      for (const kind of ['generation', 'ec_hybrid', 'viewing'] as KeyKind[]) {
        for (let i = 0; i <= next[kind] + KEY_LOOKAHEAD; i++) {
          try {
            all.add((await core.address(kind, i)).toLowerCase());
          } catch {
            break;
          }
        }
      }
      return all;
    })();
    known.set(key, set);
  }
  return set;
}

/** Forget a wallet's addresses, as the rest of it is forgotten on removal. */
export function forgetOwnAddresses(accountId: string): void {
  for (const key of [...known.keys()]) if (key.startsWith(`${accountId}:`)) known.delete(key);
}
