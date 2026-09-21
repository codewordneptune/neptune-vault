// Which parts of which wallet live in the engine's sealed log.
//
// The app moves its data into the engine one part at a time, and a part
// moves when a wallet is unlocked, because that is when the key to its log
// exists. So a given part of a given wallet is in one of two places: the
// engine, once the move has happened and checked out, or the app's own
// database, where it always was. This is where the services ask which.
//
// The answer is never a guess. After a part has moved, the rows it left
// behind in the database are a copy that is going stale, and reading them,
// or worse writing to them, would quietly fork the wallet. So the database
// is the answer only when it is known to be the truth: the core has no
// store at all, or this part tried to move in this session and would not
// come through unchanged. A wallet whose log is not open is locked, and
// asking about it is an error, not a reason to fall back.

import type { WalletPart } from '../backend/types';

export class EngineParts {
  private readonly moved = new Map<string, Set<WalletPart>>();
  private readonly stayed = new Map<string, Map<WalletPart, string>>();

  /** `available` is whether the core has a store at all. */
  constructor(private readonly available: boolean) {}

  where(accountId: string, part: WalletPart): 'engine' | 'database' {
    if (!this.available) return 'database';
    if (this.moved.get(accountId)?.has(part)) return 'engine';
    if (this.stayed.get(accountId)?.has(part)) return 'database';
    throw new Error('wallet is locked');
  }

  /** The parts of this wallet that the engine holds, as of this unlock. */
  opened(accountId: string, parts: WalletPart[]): void {
    this.moved.set(accountId, new Set(parts));
  }

  /** This part would not move; the database stays the truth for it, and this is why. */
  stays(accountId: string, part: WalletPart, why: string): void {
    const parts = this.stayed.get(accountId) ?? new Map<WalletPart, string>();
    parts.set(part, why);
    this.stayed.set(accountId, parts);
  }

  /** Why parts of this wallet stayed behind, for Diagnostics. */
  problems(accountId: string): string[] {
    return [...(this.stayed.get(accountId) ?? [])].map(([part, why]) => `${part}: ${why}`);
  }

  /** Locking ends the worker that held the logs: nothing is open until the next unlock. */
  forgetAll(): void {
    this.moved.clear();
    this.stayed.clear();
  }
}
