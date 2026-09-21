import { describe, expect, it } from 'vitest';

import { WindowOwner, type ChannelLike, type LocksLike } from './windowOwner';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** One lock manager shared by every window of a test, as the browser's is. */
class FakeLocks implements LocksLike {
  private holder: object | null = null;
  private rejectHolder: ((e: Error) => void) | null = null;
  private readonly queue: Array<() => void> = [];

  request(_name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, callback: (lock: unknown | null) => Promise<void> | void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const me = {};
        this.holder = me;
        this.rejectHolder = reject;
        void Promise.resolve(callback({})).then(() => {
          if (this.holder !== me) return;
          this.holder = null;
          this.rejectHolder = null;
          resolve(undefined);
          this.queue.shift()?.();
        });
      };
      if (options.steal) {
        const robbed = this.rejectHolder;
        this.holder = null;
        robbed?.(abortError());
        run();
      } else if (this.holder === null) {
        run();
      } else if (options.ifAvailable) {
        void Promise.resolve(callback(null)).then(() => resolve(undefined));
      } else {
        this.queue.push(run);
        options.signal?.addEventListener('abort', () => {
          const at = this.queue.indexOf(run);
          if (at < 0) return;
          this.queue.splice(at, 1);
          reject(abortError());
        });
      }
    });
  }
}

/** Channels that deliver to every window but the sender, a moment later. */
class Hub {
  private readonly all: ChannelLike[] = [];
  channel(): ChannelLike {
    const mine: ChannelLike = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of this.all) if (other !== mine) queueMicrotask(() => other.onmessage?.({ data }));
      },
    };
    this.all.push(mine);
    return mine;
  }
}

function windows() {
  const locks = new FakeLocks();
  const hub = new Hub();
  const open = (answerWithinMs = 50) => new WindowOwner(locks, hub.channel(), answerWithinMs);
  return { locks, hub, open };
}

describe('one window owns the wallet', () => {
  it('gives the wallet to the first window and tells the second where it is', async () => {
    const { open } = windows();
    const first = open();
    const second = open();
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(first.isOwner).toBe(true);
    expect(second.isOwner).toBe(false);
  });

  it('asking twice is asking once, so a second render does not lock a window out of itself', async () => {
    const { open } = windows();
    const only = open();
    expect(await Promise.all([only.acquire(), only.acquire()])).toEqual([true, true]);
  });

  it('hands over when asked: the wallet is locked first, then let go', async () => {
    const { open } = windows();
    const first = open();
    const second = open();
    await first.acquire();
    await second.acquire();
    const order: string[] = [];
    first.beforeRelease = () => {
      order.push(first.isOwner ? 'locked while still the owner' : 'locked too late');
    };
    first.afterRelease = () => order.push('gone');

    expect(await second.takeOver()).toBe('owner');
    expect(order).toEqual(['locked while still the owner', 'gone']);
    expect(first.isOwner).toBe(false);
    expect(second.isOwner).toBe(true);
  });

  it('the window that let go reloads and finds the wallet elsewhere', async () => {
    const { open } = windows();
    const first = open();
    const second = open();
    await first.acquire();
    await second.acquire();
    await second.takeOver();
    const reloaded = open();
    expect(await reloaded.acquire()).toBe(false);
  });

  it('refuses during a send, and the asking window gives up its place in line', async () => {
    const { open } = windows();
    const first = open();
    const second = open();
    await first.acquire();
    await second.acquire();
    first.busy = true;
    let lost = false;
    first.afterRelease = () => (lost = true);

    expect(await second.takeOver()).toBe('busy');
    expect(first.isOwner).toBe(true);
    expect(second.isOwner).toBe(false);
    expect(lost).toBe(false);

    // The send ends; asking again works.
    first.busy = false;
    expect(await second.takeOver()).toBe('owner');
  });

  it('takes the wallet from a window that does not answer', async () => {
    const { locks, hub } = windows();
    // A window that holds the lock and hears nothing.
    const stuck = new WindowOwner(locks, undefined);
    await stuck.acquire();
    const lost: string[] = [];
    stuck.beforeRelease = () => void lost.push('locked');
    stuck.afterRelease = () => void lost.push('gone');

    const second = new WindowOwner(locks, hub.channel(), 20);
    await second.acquire();
    expect(await second.takeOver()).toBe('owner');
    await new Promise((r) => setTimeout(r, 0));
    expect(stuck.isOwner).toBe(false);
    expect(lost).toEqual(['locked', 'gone']);
  });

  it('owns everything where the browser has no locks, as before', async () => {
    const lone = new WindowOwner(undefined, undefined);
    expect(await lone.acquire()).toBe(true);
    expect(lone.isOwner).toBe(true);
    expect(await lone.takeOver()).toBe('owner');
  });
});
