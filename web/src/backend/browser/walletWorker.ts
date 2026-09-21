// Wallet worker: hosts the wasm wallet core so key derivation, scanning and
// witness building never block the UI thread, and so the decrypted seed
// lives in this worker's memory only. Terminating the worker locks.
//
// Unlocking happens in here too: the page hands over the stored envelope
// and the password, and this worker derives the key, decrypts the phrase
// and loads the account. The phrase is never on the page's own heap at an
// unlock. It reaches the page only when it has to be seen: once when a new
// wallet's words are written down, and when the person asks to see them.

import { openSeed, openSeedKeepingKey, openSeedWithSecretKeepingKey, WrongPasswordError, type DeriveKey } from '../../storage/envelope';
import type { SeedEnvelope } from '../../storage/db';
import { LogStore } from '../../storage/logStore';

// Served untransformed from the public dir, like the prover package.
type CoreModule = typeof import('../../../public/wasm/core/vault_core');
type Account = InstanceType<CoreModule['Account']>;
type WalletLog = InstanceType<CoreModule['WalletLog']>;


export interface WorkerRequest {
  id: number;
  op: string;
  args: unknown[];
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The error's class name, so the page can tell a wrong password from a failure. */
  errorName?: string;
  transfer?: Transferable[];
}

let ready: Promise<CoreModule> | null = null;
let account: Account | null = null;

// The unlocked wallet's data. The content key is what the seed envelope
// protects; the key of the wallet's sealed log is derived from it, inside
// the wasm core, and neither ever goes back to the page. Locking ends this
// worker, and all of this with it.
let contentKey: Uint8Array | null = null;
const logs = new Map<string, { log: WalletLog; sinceSnapshot: number }>();
let logStore: Promise<LogStore> | null = null;
/** Batches kept between snapshots; the engine's COMPACT_EVERY. */
const COMPACT_EVERY = 256;

function keep(key: Uint8Array | null): void {
  contentKey?.fill(0);
  contentKey = key;
  for (const held of logs.values()) held.log.free();
  logs.clear();
}

function storage(): Promise<LogStore> {
  logStore ??= LogStore.open();
  return logStore;
}

// Requests are handled as they arrive and each one waits on storage, so two
// writes to one log could both be prepared as entry n. One at a time, per log.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(accountId) ?? Promise.resolve()).then(run, run);
  queues.set(accountId, next.catch(() => undefined));
  return next;
}

function openLog(accountId: string): { log: WalletLog; sinceSnapshot: number } {
  const held = logs.get(accountId);
  if (!held) throw new Error('wallet is locked');
  return held;
}

/** Write the batch the log has prepared, and only then let it take effect. */
async function write(held: { log: WalletLog; sinceSnapshot: number }, bytes: Uint8Array): Promise<void> {
  const store = await storage();
  const seq = held.log.pending_seq();
  if (seq === undefined) throw new Error('no batch is waiting');
  try {
    await store.append(held.log.name(), seq, bytes);
  } catch (e) {
    held.log.abandon();
    throw e;
  }
  held.log.confirm();
  held.sinceSnapshot += 1;
  if (held.sinceSnapshot >= COMPACT_EVERY) {
    // Best effort: a log longer than it needs to be is still a correct log.
    try {
      await store.compact(held.log.name(), held.log.seq(), held.log.snapshot());
      held.sinceSnapshot = 0;
    } catch {
      // Tried again after the next write.
    }
  }
}

function ensureReady(): Promise<CoreModule> {
  const p =
    ready ??
    (async () => {
      const url = new URL('/wasm/core/vault_core.js', self.location.origin).href;
      const m = (await import(/* @vite-ignore */ url)) as CoreModule;
      await m.default();

      return m;
    })();
  ready = p;
  return p;
}

function requireAccount(): Account {
  if (!account) throw new Error('wallet is locked');
  return account;
}

async function handle(op: string, args: unknown[]): Promise<{ result: unknown; transfer?: Transferable[] }> {
  const m = await ensureReady();
  switch (op) {
    case 'ping':
      return { result: true };
    case 'coreVersion':
      return { result: m.core_version() };
    case 'claimVersion':
      return { result: m.claim_version(args[0] as string, BigInt(args[1] as number)) };
    case 'generatePhrase':
      return { result: m.generate_phrase() };
    case 'deriveKey': {
      const [password, salt, mKib, tCost, pCost] = args as [Uint8Array, Uint8Array, number, number, number];
      const key = m.derive_key(password, salt, mKib, tCost, pCost);
      return { result: key, transfer: [key.buffer] };
    }
    case 'parseAmount':
      return { result: m.parse_amount(args[0] as string) };
    case 'formatAmount':
      return { result: m.format_amount(args[0] as string) };
    case 'isValidAddress':
      return { result: m.is_valid_address(args[0] as string, args[1] as string) };
    case 'phraseProblem':
      return { result: m.phrase_problem(args[0] as string[]) ?? null };
    case 'unlock': {
      account?.free();
      account = new m.Account(args[0] as string[], args[1] as string);
      keep((args[2] as Uint8Array | undefined) ?? null);
      return { result: null };
    }
    case 'unlockEnvelope': {
      const [envelope, password, network] = args as [SeedEnvelope, string, string];
      const derive: DeriveKey = (pw, salt, mKib, tCost, pCost) => m.derive_key(pw, salt, mKib, tCost, pCost);
      const opened = await openSeedKeepingKey(envelope, password, derive);
      account?.free();
      account = new m.Account(opened.phrase, network);
      keep(opened.contentKey);
      return { result: null };
    }
    case 'unlockEnvelopeWithSecret': {
      const [envelope, wrapped, secret, network] = args as [SeedEnvelope, { iv: string; ciphertext: string }, Uint8Array, string];
      try {
        const opened = await openSeedWithSecretKeepingKey(envelope, wrapped, secret);
        account?.free();
        account = new m.Account(opened.phrase, network);
        keep(opened.contentKey);
      } finally {
        secret.fill(0);
      }
      return { result: null };
    }
    case 'storeOpen': {
      const accountId = args[0] as string;
      return inTurn(accountId, async () => {
        if (!logs.has(accountId)) {
          if (!contentKey) throw new Error('wallet is locked');
          const entries = await (await storage()).load(`wallet:${accountId}`);
          logs.set(accountId, { log: new m.WalletLog(accountId, contentKey, entries), sinceSnapshot: entries.length });
        }
        return { result: openLog(accountId).log.migrated() };
      });
    }
    case 'storeMigrate': {
      const [accountId, part, dump] = args as [string, string, unknown];
      return inTurn(accountId, async () => {
        const held = openLog(accountId);
        if (!held.log.migrated().includes(part)) await write(held, held.log.prepare_migration(JSON.stringify(dump), part));
        return { result: null };
      });
    }
    case 'storeRead': {
      const [accountId, part] = args as [string, string];
      return inTurn(accountId, async () => ({ result: JSON.parse(openLog(accountId).log.read(part)) as unknown[] }));
    }
    case 'storeCommit': {
      const [accountId, changes] = args as [string, unknown[]];
      return inTurn(accountId, async () => {
        const held = openLog(accountId);
        await write(held, held.log.prepare(JSON.stringify(changes)));
        return { result: null };
      });
    }
    case 'storeRemove': {
      const accountId = args[0] as string;
      return inTurn(accountId, async () => {
        logs.get(accountId)?.log.free();
        logs.delete(accountId);
        await (await storage()).remove(`wallet:${accountId}`);
        return { result: null };
      });
    }
    case 'openEnvelope': {
      // For showing the words, and for proving a password: the one place the phrase goes back to the page.
      const [envelope, password, wantPhrase] = args as [SeedEnvelope, string, boolean];
      const derive: DeriveKey = (pw, salt, mKib, tCost, pCost) => m.derive_key(pw, salt, mKib, tCost, pCost);
      const phrase = await openSeed(envelope, password, derive);
      return { result: wantPhrase ? phrase : null };
    }
    case 'lock':
      account?.free();
      account = null;
      keep(null);
      return { result: null };
    case 'isUnlocked':
      return { result: account !== null };
    case 'address':
      return { result: requireAccount().address(args[0] as string, BigInt(args[1] as number)) };
    case 'announcementFlags':
      return { result: requireAccount().announcement_flags(JSON.stringify(args[0])) };
    case 'absoluteIndexSets':
      return { result: requireAccount().absolute_index_sets(JSON.stringify(args[0])) };
    case 'scanBlocks': {
      // The blocks arrive as the node's raw response text: big integers survive.
      const [blocksResponse, unspent, nextKeyIndices, expectation] = args as [string, unknown[], unknown, unknown];
      const json = requireAccount().scan_blocks(blocksResponse, JSON.stringify(unspent), JSON.stringify(nextKeyIndices), JSON.stringify(expectation));
      return { result: JSON.parse(json) };
    }
    case 'scanMempoolKernel': {
      const [kernelResponse, unspent, nextKeyIndices, tipHeight] = args as [string, unknown[], unknown, number];
      const json = requireAccount().scan_mempool_kernel(kernelResponse, JSON.stringify(unspent), JSON.stringify(nextKeyIndices), tipHeight);
      return { result: JSON.parse(json) };
    }
    case 'planInputs': {
      const [unspent, request, nowMs] = args as [unknown[], unknown, number];
      const json = requireAccount().plan_inputs(JSON.stringify(unspent), JSON.stringify(request), nowMs);
      return { result: JSON.parse(json) };
    }
    case 'buildSend': {
      const [inputs, snapshotResponse, tipHeaderResponse, request, nowMs] = args as [unknown[], string, string, unknown, number];
      const plan = requireAccount().build_send(JSON.stringify(inputs), snapshotResponse, tipHeaderResponse, JSON.stringify(request), nowMs);
      const witness = plan.witness();
      const kernel = plan.kernel();
      const summary = JSON.parse(plan.summary());
      plan.free();
      return { result: { witness, kernel, summary }, transfer: [witness.buffer, kernel.buffer] };
    }
    case 'mockProofCollection': {
      const pc = m.mock_proof_collection(args[0] as Uint8Array);
      return { result: pc, transfer: [pc.buffer] };
    }
    case 'assembleSubmission': {
      const [kernel, proof] = args as [Uint8Array, Uint8Array];
      return { result: JSON.parse(m.assemble_submission(kernel, proof)) };
    }
    default:
      throw new Error(`unknown wallet operation ${op}`);
  }
}

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, op, args } = data;
  try {
    const { result, transfer } = await handle(op, args);
    const response: WorkerResponse = { id, ok: true, result };
    (self as unknown as Worker).postMessage(response, transfer ?? []);
  } catch (e) {
    const response: WorkerResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e), errorName: e instanceof WrongPasswordError ? 'WrongPasswordError' : undefined };
    (self as unknown as Worker).postMessage(response);
  }
};
