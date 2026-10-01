import { describe, expect, it } from 'vitest';

import { onPaymentLinks, type LinkSource } from './paymentLinks';

const LINK = 'neptunecash:nolgar1example?amount=1.5';

/** A stand-in for the deep-link plugin: the start links, and a way to send one while the app runs. */
function fakeSource(start: string[] | null) {
  let handler: ((urls: string[]) => void) | null = null;
  let stops = 0;
  const source: LinkSource = {
    current: async () => start,
    onNew: async (h) => {
      handler = h;
      return () => {
        stops += 1;
      };
    },
  };
  return { source, arrive: (urls: string[]) => handler?.(urls), stops: () => stops };
}

function fakeMemory() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('payment links', () => {
  it('opens the link the app started with, once, even when the page loads again', async () => {
    const memory = fakeMemory();
    const opened: string[] = [];
    onPaymentLinks((link) => opened.push(link), fakeSource([LINK]).source, memory);
    await settle();
    expect(opened).toEqual([LINK]);
    // The page again, in the same run of the app: the plugin still reports the start link.
    onPaymentLinks((link) => opened.push(link), fakeSource([LINK]).source, memory);
    await settle();
    expect(opened).toEqual([LINK]);
  });

  it('opens each payment link that arrives, and nothing else', async () => {
    const opened: string[] = [];
    const fake = fakeSource(null);
    onPaymentLinks((link) => opened.push(link), fake.source, fakeMemory());
    await settle();
    fake.arrive(['https://example.org/pay']);
    fake.arrive([LINK]);
    // The same link tapped again is asked for again.
    fake.arrive([LINK]);
    fake.arrive(['NEPTUNECASH:NOLGAR1EXAMPLE']);
    expect(opened).toEqual([LINK, LINK, 'NEPTUNECASH:NOLGAR1EXAMPLE']);
  });

  it('stops listening when told to', async () => {
    const opened: string[] = [];
    const fake = fakeSource(null);
    const stop = onPaymentLinks((link) => opened.push(link), fake.source, null);
    await settle();
    stop();
    fake.arrive([LINK]);
    expect(opened).toEqual([]);
    expect(fake.stops()).toBe(1);
  });
});
