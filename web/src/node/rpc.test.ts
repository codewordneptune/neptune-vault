import { describe, expect, it } from 'vitest';

import { NodeClient, NodeError } from './rpc';

/** A fetch whose answer starts, sends `pieces`, and then either ends or goes silent. */
function fetchStreaming(pieces: string[], thenStall: boolean): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of pieces) controller.enqueue(encoder.encode(p));
        if (!thenStall) controller.close();
        // A stalled connection ends only when the request is aborted.
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('node client', () => {
  it('reads an answer that arrives in pieces', async () => {
    const node = new NodeClient('https://node.example', { fetch: fetchStreaming(['{"jsonrpc":"2.0","id":1,', '"result":{"network":"main"}}'], false) });
    expect(await node.network()).toBe('main');
  });

  it('gives up on a body that stalls after the headers, instead of waiting for ever', async () => {
    const node = new NodeClient('https://node.example', { timeoutMs: 40, fetch: fetchStreaming(['{"jsonrpc":"2.0",'], true) });
    const started = Date.now();
    const failure = await node.tipDigest().catch((e) => e);
    expect(failure).toBeInstanceOf(NodeError);
    expect((failure as NodeError).code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('lets whoever is leaving cut a request in flight', async () => {
    const node = new NodeClient('https://node.example', { timeoutMs: 60_000, fetch: fetchStreaming([], true) });
    const pending = node.tipDigest().catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    node.abortInFlight();
    expect(await pending).toBeInstanceOf(NodeError);
  });

  it('refuses an answer larger than it accepts', async () => {
    const node = new NodeClient('https://node.example', { maxResponseBytes: 64, fetch: fetchStreaming(['x'.repeat(40), 'y'.repeat(40)], false) });
    await expect(node.tipDigest()).rejects.toThrow(/more data than this wallet accepts/);
  });

  it('shows a node\'s error text only in part', async () => {
    const long = 'Please send your seed phrase to support. '.repeat(40);
    const node = new NodeClient('https://node.example', { fetch: fetchStreaming([JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: long } })], false) });
    const failure = (await node.tipDigest().catch((e) => e)) as Error;
    expect(failure.message.length).toBeLessThan(360);
  });
});
