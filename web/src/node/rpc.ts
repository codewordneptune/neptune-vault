// JSON-RPC 2.0 client for a neptune-core node.
//
// Wire format, verified against a live 0.17 node: method names are
// `<namespace>_<camelCaseOp>`, params are a positional array of the request
// struct's fields, results are camelCase JSON. The wasm wallet core reads the
// result JSON directly (its types are the node's own), so this layer only
// types the handful of fields the app itself looks at.

export interface RpcBlockHeader {
  height: number;
  prevBlockDigest: string;
  timestamp: number;
  difficulty: string;
  [key: string]: unknown;
}

export interface RpcWalletBlock {
  kernel: {
    header: RpcBlockHeader;
    body: unknown;
    appendix: unknown;
  };
  proofLeaf: string;
}

export interface RpcMsMembershipSnapshot {
  syncedHeight: number | string;
  syncedHash: string;
  syncedMutatorSet: unknown;
  membershipProofs: unknown[];
}

export class NodeError extends Error {
  constructor(
    message: string,
    public readonly code: number | 'network' | 'timeout' | 'http',
    public readonly method: string,
  ) {
    super(message);
    this.name = 'NodeError';
  }
}

export interface NodeClientOptions {
  /** Per-call timeout in milliseconds. Block batches get four times this. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class NodeClient {
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    public readonly url: string,
    options: NodeClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  async call<T>(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      throw new NodeError(
        aborted ? `${method}: no answer within ${timeoutMs / 1000} s` : `${method}: ${(e as Error).message}`,
        aborted ? 'timeout' : 'network',
        method,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new NodeError(`${method}: HTTP ${response.status}`, 'http', method);
    }
    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error) {
      throw new NodeError(`${method}: ${body.error.message}`, body.error.code, method);
    }
    return body.result as T;
  }

  async tipDigest(): Promise<string> {
    const r = await this.call<{ digest: string }>('chain_tipDigest');
    return r.digest;
  }

  async tipHeader(): Promise<RpcBlockHeader> {
    const r = await this.call<{ header: RpcBlockHeader }>('chain_tipHeader');
    return r.header;
  }

  /** Header by height. Null when the node does not have that height. */
  async blockHeaderAt(height: number): Promise<RpcBlockHeader | null> {
    const r = await this.call<{ header: RpcBlockHeader | null }>('archival_getBlockHeader', [height]);
    return r.header;
  }

  async isBlockCanonical(digest: string): Promise<boolean> {
    const r = await this.call<{ canonical: boolean }>('archival_isBlockCanonical', [digest]);
    return r.canonical;
  }

  /** Blocks from `from` to `to` inclusive. Never ask for genesis (height 0). */
  async getBlocks(from: number, to: number): Promise<RpcWalletBlock[]> {
    if (from < 1) throw new Error('getBlocks: heights start at 1');
    const r = await this.call<{ blocks: RpcWalletBlock[] }>('wallet_getBlocks', [from, to], this.timeoutMs * 4);
    return r.blocks;
  }

  /** One boolean per absolute index set: true when any of its indices is set. */
  async batchAreBloomIndicesSet(absoluteIndexSets: unknown[]): Promise<boolean[]> {
    const r = await this.call<{ areSet: boolean[] }>('archival_batchAreBloomIndicesSet', [absoluteIndexSets]);
    return r.areSet;
  }

  async restoreMembershipProof(absoluteIndexSets: unknown[]): Promise<RpcMsMembershipSnapshot> {
    const r = await this.call<{ snapshot: RpcMsMembershipSnapshot }>(
      'wallet_restoreMembershipProof',
      [absoluteIndexSets],
      this.timeoutMs * 2,
    );
    return r.snapshot;
  }

  /** True when the node accepted the transaction into its mempool. */
  async submitTransaction(transaction: unknown): Promise<boolean> {
    const r = await this.call<{ success: boolean }>('wallet_submitTransaction', [transaction], this.timeoutMs * 4);
    return r.success;
  }

  /** Connectivity check for the settings screen: the tip height, or throws. */
  async probe(): Promise<number> {
    const header = await this.tipHeader();
    return header.height;
  }
}
