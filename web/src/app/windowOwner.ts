// One window owns the wallet.
//
// The wallet's state is moving into the engine's memory, and two windows
// would each hold a copy and write over one another. So the first window to
// open holds a Web Lock for as long as it lives, and any other shows a short
// screen saying where the wallet is, with a button to bring it here instead.
//
// "Use here" asks the owning window to hand over. It locks its wallet, lets
// go, and says so; the asking window was already waiting in line for the
// lock and gets it. A window in the middle of a send refuses, because
// nothing should interrupt a transaction half way. A window that does not
// answer at all is not doing anything that healthy, and the lock is taken
// from it.
//
// Where the browser has no Web Locks every window is an owner, as before.

const LOCK = 'neptune-vault-window';

type Message =
  | { type: 'request'; id: string }
  | { type: 'refused'; id: string }
  | { type: 'granted'; id: string };

interface LockOptions {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

/** The part of `navigator.locks` this uses. */
export interface LocksLike {
  request(name: string, options: LockOptions, callback: (lock: unknown | null) => Promise<void> | void): Promise<unknown>;
}

/** The part of BroadcastChannel this uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type TakeOver = 'owner' | 'busy';

export class WindowOwner {
  /** Something is under way that must not be interrupted: a send. */
  busy = false;
  /** Runs before the wallet is handed to another window: lock it. */
  beforeRelease: () => Promise<void> | void = () => {};
  /** Runs once this window no longer owns the wallet, however that came about. */
  afterRelease: () => void = () => {};

  private release: (() => void) | null = null;
  private acquiring: Promise<boolean> | null = null;
  private readonly waiting = new Map<string, (answer: 'granted' | 'refused') => void>();

  constructor(
    private readonly locks: LocksLike | undefined,
    private readonly channel: ChannelLike | undefined,
    private readonly answerWithinMs = 3000,
  ) {
    if (this.channel) this.channel.onmessage = (event) => void this.receive(event.data as Message);
  }

  get isOwner(): boolean {
    return !this.locks || this.release !== null;
  }

  /** Take the wallet if no window has it. Asking twice is asking once. */
  acquire(): Promise<boolean> {
    if (!this.locks) return Promise.resolve(true);
    this.acquiring ??= this.hold({ ifAvailable: true });
    return this.acquiring;
  }

  /** Bring the wallet to this window. */
  async takeOver(): Promise<TakeOver> {
    if (!this.locks || this.isOwner) return 'owner';
    // In line first, asking second: when the owner lets go, the lock comes
    // here and not to whoever happens to ask next, the owner's own reload
    // included.
    const abort = new AbortController();
    const inLine = this.hold({ signal: abort.signal });
    const id = crypto.randomUUID();
    const answer = await new Promise<'granted' | 'refused' | 'silence'>((resolve) => {
      this.waiting.set(id, resolve);
      setTimeout(() => resolve('silence'), this.answerWithinMs);
      this.channel?.postMessage({ type: 'request', id } satisfies Message);
    });
    this.waiting.delete(id);

    if (answer === 'granted') return (await inLine) ? 'owner' : 'busy';
    abort.abort();
    await inLine;
    if (answer === 'refused') return 'busy';
    return (await this.hold({ steal: true })) ? 'owner' : 'busy';
  }

  private async receive(message: Message): Promise<void> {
    if (message.type !== 'request') {
      this.waiting.get(message.id)?.(message.type);
      return;
    }
    if (this.release === null) return;
    if (this.busy) {
      this.channel?.postMessage({ type: 'refused', id: message.id } satisfies Message);
      return;
    }
    await this.beforeRelease();
    const release = this.release;
    this.release = null;
    release?.();
    this.channel?.postMessage({ type: 'granted', id: message.id } satisfies Message);
    this.afterRelease();
  }

  /** Request the lock and keep it until released. Resolves once it is known whether it was got. */
  private hold(options: LockOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.locks!
        .request(LOCK, options, (lock) => {
          if (lock === null) {
            resolve(false);
            return;
          }
          return new Promise<void>((release) => {
            this.release = release;
            resolve(true);
          });
        })
        .catch(async () => {
          // Either this window's place in line was given up, or the lock it
          // held was taken by another window that got no answer from it.
          if (this.release !== null) {
            this.release = null;
            await this.beforeRelease();
            this.afterRelease();
          }
          resolve(false);
        });
    });
  }
}

/** The real thing, or an owner of everything where the browser has no Web Locks. */
export function browserWindowOwner(): WindowOwner {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator.locks as unknown as LocksLike | undefined);
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : (new BroadcastChannel(LOCK) as unknown as ChannelLike);
  return new WindowOwner(locks, channel);
}
