// JSON-RPC 2.0 client for a neptune-core node.
//
// Wire format, verified against a live 0.17 node: method names are
// `<namespace>_<camelCaseOp>`, params are a positional array of the request
// struct's fields, results are camelCase JSON. The wasm wallet core reads the
// result JSON directly (its types are the node's own), so this layer only
// types the handful of fields the app itself looks at.

import { findHeightForDate } from '../util/blockdate';

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

  /** The node's host for messages; a relative dev-proxy path is shown as is. */
  private host(): string {
    try {
      return new URL(this.url, globalThis.location?.origin ?? 'http://localhost').host;
    } catch {
      return this.url;
    }
  }

  /**
   * The raw JSON-RPC response text. Node payloads carry u64 and u128
   * values that JavaScript numbers cannot hold exactly (anything above
   * 2^53), so whatever the wasm core will read must stay as text and never
   * pass through JSON.parse and JSON.stringify.
   */
  async callRaw(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs, paramsText?: string): Promise<string> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // `paramsText` is a parameter already serialised by the core, spliced in
    // as the single positional parameter so its big integers survive.
    const requestBody =
      paramsText === undefined
        ? JSON.stringify({ jsonrpc: '2.0', method, params, id })
        : '{"jsonrpc":"2.0","method":' + JSON.stringify(method) + ',"params":[' + paramsText + '],"id":' + id + '}';
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      // A browser reports a CORS rejection and an unreachable host the same
      // way, as a fetch failure with no status, so name both possibilities.
      throw new NodeError(
        aborted
          ? `No answer from the node at ${this.host()} within ${timeoutMs / 1000} s`
          : `Could not reach the node at ${this.host()}. Either it is offline, or it does not send the CORS headers a browser needs. Check the node URL in Settings.`,
        aborted ? 'timeout' : 'network',
        method,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new NodeError(`${method}: HTTP ${response.status}`, 'http', method);
    }
    const text = await response.text();
    // Parsed only to detect an error; the parsed result is not returned.
    const body = JSON.parse(text) as { error?: { code: number; message: string; data?: unknown } };
    if (body.error) {
      const detail = body.error.data === undefined ? '' : ` (${JSON.stringify(body.error.data).slice(0, 300)})`;
      throw new NodeError(`${method}: ${body.error.message}${detail}`, body.error.code, method);
    }
    return text;
  }

  /** The parsed result, for values the app itself reads (heights, flags). */
  async call<T>(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    const text = await this.callRaw(method, params, timeoutMs);
    return (JSON.parse(text) as { result: T }).result;
  }

  /**
   * The network the node says it runs: "main", "regtest", "testnet-0".
   * Null when the node is too old to say.
   */
  async network(): Promise<string | null> {
    try {
      const r = await this.call<{ network: string }>('node_network');
      return typeof r.network === 'string' ? r.network : null;
    } catch (e) {
      if (/method not found|-32601/i.test(e instanceof Error ? e.message : String(e))) return null;
      throw e;
    }
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

  /**
   * Blocks from `from` to `to` inclusive, as the raw response text for the
   * wasm core. Never ask for genesis (height 0).
   */
  async getBlocksRaw(from: number, to: number): Promise<string> {
    if (from < 1) throw new Error('getBlocks: heights start at 1');
    return this.callRaw('wallet_getBlocks', [from, to], this.timeoutMs * 4);
  }

  /**
   * Heights of the blocks whose announcements carry any of the flags,
   * from the node's UTXO index. `flagsJson` is the core's text (the
   * identifiers are 64-bit). May include orphaned blocks. Fails with
   * "Method not found" on a node without the index.
   */
  async blockHeightsByFlags(flagsJson: string): Promise<number[]> {
    const text = await this.callRaw('utxoindex_blockHeightsByFlags', [], this.timeoutMs, flagsJson);
    return (JSON.parse(text) as { result: { blockHeights: number[] } }).result.blockHeights;
  }

  /** Canonical heights of the blocks that spent any of the index sets (the core's text). */
  async blockHeightsBySpends(indexSetsJson: string): Promise<number[]> {
    const text = await this.callRaw('utxoindex_blockHeightsByAbsoluteIndexSets', [], this.timeoutMs, indexSetsJson);
    return (JSON.parse(text) as { result: { blockHeights: number[] } }).result.blockHeights;
  }

  /** The tip header as raw response text, plus its height for the app. */
  async tipHeaderRaw(): Promise<{ raw: string; height: number }> {
    const raw = await this.callRaw('chain_tipHeader');
    const height = (JSON.parse(raw) as { result: { header: { height: number } } }).result.header.height;
    return { raw, height };
  }

  /** One boolean per absolute index set: true when any of its indices is set. */
  async batchAreBloomIndicesSet(absoluteIndexSets: unknown[]): Promise<boolean[]> {
    const r = await this.call<{ areSet: boolean[] }>('archival_batchAreBloomIndicesSet', [absoluteIndexSets]);
    return r.areSet;
  }

  /** Membership-proof snapshot as raw response text for the wasm core. */
  async restoreMembershipProofRaw(absoluteIndexSets: unknown[]): Promise<string> {
    return this.callRaw('wallet_restoreMembershipProof', [absoluteIndexSets], this.timeoutMs * 2);
  }

  /** True when the node accepted the transaction into its mempool. */
  /** The first block timestamped at or after `dateMs`, by binary search over headers. */
  async heightForDate(dateMs: number): Promise<number> {
    const tip = await this.probe();
    return findHeightForDate(async (h) => (await this.blockHeaderAt(h))?.timestamp ?? null, tip, dateMs);
  }

  /** Ids of the transactions in the node's mempool, fee-density order. */
  async mempoolTransactions(): Promise<string[]> {
    const r = await this.call<{ transactions: string[] }>('mempool_transactions');
    return r.transactions;
  }

  /** Raw response text for one mempool kernel (kept as text for the wasm core). */
  async mempoolKernelRaw(id: string): Promise<string> {
    return this.callRaw('mempool_getTransactionKernel', [id]);
  }

  /** Which of these output commitments the mempool currently carries. */
  async mempoolHasOutputs(commitments: string[]): Promise<Set<string>> {
    if (commitments.length === 0) return new Set();
    const r = await this.call<{ transactions: { kernel: { outputs: string[] } }[] }>('mempool_getTransactionsByAdditionRecords', [commitments]);
    const wanted = new Set(commitments);
    const present = new Set<string>();
    for (const t of r.transactions) for (const o of t.kernel.outputs) if (wanted.has(o)) present.add(o);
    return present;
  }

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
