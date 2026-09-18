// Wallet worker: hosts the wasm wallet core so key derivation, scanning and
// witness building never block the UI thread, and so the decrypted seed
// lives in this worker's memory only. Terminating the worker locks.
//
// Unlocking happens in here too: the page hands over the stored envelope
// and the password, and this worker derives the key, decrypts the phrase
// and loads the account. The phrase is never on the page's own heap at an
// unlock. It reaches the page only when it has to be seen: once when a new
// wallet's words are written down, and when the person asks to see them.

import { openSeed, openSeedWithSecret, WrongPasswordError, type DeriveKey } from '../../storage/envelope';
import type { SeedEnvelope } from '../../storage/db';

// Served untransformed from the public dir, like the prover package.
type CoreModule = typeof import('../../../public/wasm/core/vault_core');
type Account = InstanceType<CoreModule['Account']>;


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
      return { result: null };
    }
    case 'unlockEnvelope': {
      const [envelope, password, network] = args as [SeedEnvelope, string, string];
      const derive: DeriveKey = (pw, salt, mKib, tCost, pCost) => m.derive_key(pw, salt, mKib, tCost, pCost);
      const phrase = await openSeed(envelope, password, derive);
      account?.free();
      account = new m.Account(phrase, network);
      return { result: null };
    }
    case 'unlockEnvelopeWithSecret': {
      const [envelope, wrapped, secret, network] = args as [SeedEnvelope, { iv: string; ciphertext: string }, Uint8Array, string];
      try {
        const phrase = await openSeedWithSecret(envelope, wrapped, secret);
        account?.free();
        account = new m.Account(phrase, network);
      } finally {
        secret.fill(0);
      }
      return { result: null };
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
