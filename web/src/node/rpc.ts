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

/**
 * The most a node may answer with. A batch of 25 mainnet blocks is about
 * 5 MB; this leaves room for fuller blocks and stops a node from filling
 * the device's memory with one answer.
 */
export const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

/** The body as text, read piece by piece so it can be refused once it outgrows `limit`. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > limit) throw new NodeError('The node answered with more data than this wallet accepts.', 'http', '');
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      throw new NodeError('The node answered with more data than this wallet accepts.', 'http', '');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * What a node says about an error, made fit to show. The text is the
 * node's, and the node may be anyone's: it is cut short, stripped of control
 * and direction-changing characters, and always introduced as the node's
 * words, so it cannot pass for the wallet speaking.
 */
export function nodeSaid(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? clean.slice(0, 200) + '…' : clean;
}

/**
 * Why `text` cannot be a node URL for `network`, or null when it can.
 * https anywhere; plain http only to this machine, where nothing is on the
 * wire; a bare path only on regtest, for the development proxy. No user
 * name or password in the URL: it would be stored in clear and sent along.
 */
export function nodeUrlProblem(text: string, network: string): string | null {
  const t = text.trim();
  if (t === '') return 'Enter the node URL';
  if (t.startsWith('/') && !t.startsWith('//')) return network === 'regtest' ? null : 'A node URL starts with https://';
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return 'This is not a URL. A node URL starts with https://';
  }
  if (url.username !== '' || url.password !== '') return 'A node URL must not carry a user name or a password';
  if (url.protocol === 'https:') return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:') return local ? null : 'Plain http is only for a node on this device. Use https://';
  return 'A node URL starts with https://';
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
  /** The most a single answer may weigh; see MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
}

export class NodeClient {
  private nextId = 1;
  private readonly inFlight = new Set<AbortController>();
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(
    public readonly url: string,
    options: NodeClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
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
  /** Cut every request in flight: the caller is leaving and must not wait out a stalled connection. */
  abortInFlight(): void {
    for (const c of this.inFlight) c.abort();
  }

  async callRaw(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs, paramsText?: string): Promise<string> {
    const id = this.nextId++;
    const controller = new AbortController();
    this.inFlight.add(controller);
    // The timer covers the whole answer, body included. It used to stop
    // when the headers arrived, and a body that stalled after that (a dead
    // mobile connection, or a node that means to) hung the sync for good,
    // and with it every wallet switch, rescan and removal waiting on it.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.exchange(method, id, params, paramsText, controller, timeoutMs);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  private async exchange(method: string, id: number, params: unknown[], paramsText: string | undefined, controller: AbortController, timeoutMs: number): Promise<string> {
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
        // A node that answers with a redirect is sending the wallet's
        // questions somewhere the person did not choose.
        redirect: 'error',
      });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      // A browser reports a CORS rejection and an unreachable host the same
      // way, as a fetch failure with no status, so name both possibilities.
      throw new NodeError(
        aborted
          ? `No answer from the node at ${this.host()} within ${timeoutMs / 1000} s`
          : `Cannot reach the node at ${this.host()}. It may be offline, or not set up for browser wallets (CORS). Check the node URL in Settings.`,
        aborted ? 'timeout' : 'network',
        method,
      );
    }
    if (!response.ok) {
      throw new NodeError(`${method}: HTTP ${response.status}`, 'http', method);
    }
    let text: string;
    try {
      text = await readCapped(response, this.maxResponseBytes);
    } catch (e) {
      if (e instanceof NodeError) throw e;
      const aborted = controller.signal.aborted;
      throw new NodeError(aborted ? `The node at ${this.host()} stopped answering part way through (${timeoutMs / 1000} s)` : `The connection to the node at ${this.host()} broke part way through its answer`, aborted ? 'timeout' : 'network', method);
    }
    // An error answer is small; a block batch is megabytes and is parsed by
    // the core, so it is not parsed a second time here just to look for one.
    if (text.length < 65536 || text.slice(0, 256).includes('"error"')) {
      const body = JSON.parse(text) as { error?: { code: number; message: string; data?: unknown } };
      if (body.error) {
        const detail = body.error.data === undefined ? '' : ` (${JSON.stringify(body.error.data).slice(0, 300)})`;
        throw new NodeError(`${method} failed. The node said: "${nodeSaid(body.error.message)}"${nodeSaid(detail) ? ' ' + nodeSaid(detail) : ''}`, body.error.code, method);
      }
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
