// Wallet worker: hosts the wasm wallet core so key derivation, scanning and
// witness building never block the UI thread, and so the decrypted seed
// lives in this worker's memory only. Terminating the worker locks.

import init, {
  Account,
  assemble_submission,
  derive_key,
  format_amount,
  generate_phrase,
  is_valid_address,
  parse_amount,
} from '../wasm/core/vault_core.js';

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
  transfer?: Transferable[];
}

let ready: Promise<void> | null = null;
let account: Account | null = null;

function ensureReady(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

function requireAccount(): Account {
  if (!account) throw new Error('wallet is locked');
  return account;
}

async function handle(op: string, args: unknown[]): Promise<{ result: unknown; transfer?: Transferable[] }> {
  await ensureReady();
  switch (op) {
    case 'generatePhrase':
      return { result: generate_phrase() };
    case 'deriveKey': {
      const [password, salt, mKib, tCost, pCost] = args as [Uint8Array, Uint8Array, number, number, number];
      const key = derive_key(password, salt, mKib, tCost, pCost);
      return { result: key, transfer: [key.buffer] };
    }
    case 'parseAmount':
      return { result: parse_amount(args[0] as string) };
    case 'formatAmount':
      return { result: format_amount(args[0] as string) };
    case 'isValidAddress':
      return { result: is_valid_address(args[0] as string, args[1] as string) };
    case 'unlock': {
      account?.free();
      account = new Account(args[0] as string[], args[1] as string);
      return { result: null };
    }
    case 'lock':
      account?.free();
      account = null;
      return { result: null };
    case 'isUnlocked':
      return { result: account !== null };
    case 'address':
      return { result: requireAccount().address(BigInt(args[0] as number)) };
    case 'scanBlocks': {
      const [blocks, unspent, nextKeyIndex] = args as [unknown[], unknown[], number];
      const json = requireAccount().scan_blocks(JSON.stringify(blocks), JSON.stringify(unspent), BigInt(nextKeyIndex));
      return { result: JSON.parse(json) };
    }
    case 'planInputs': {
      const [unspent, request, nowMs] = args as [unknown[], unknown, number];
      const json = requireAccount().plan_inputs(JSON.stringify(unspent), JSON.stringify(request), nowMs);
      return { result: JSON.parse(json) };
    }
    case 'buildSend': {
      const [inputs, snapshot, tipHeader, request, nowMs] = args as [unknown[], unknown, unknown, unknown, number];
      const plan = requireAccount().build_send(
        JSON.stringify(inputs),
        JSON.stringify(snapshot),
        JSON.stringify(tipHeader),
        JSON.stringify(request),
        nowMs,
      );
      const witness = plan.witness();
      const kernel = plan.kernel();
      const summary = JSON.parse(plan.summary());
      plan.free();
      return { result: { witness, kernel, summary }, transfer: [witness.buffer, kernel.buffer] };
    }
    case 'assembleSubmission': {
      const [kernel, proof] = args as [Uint8Array, Uint8Array];
      return { result: JSON.parse(assemble_submission(kernel, proof)) };
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
    const response: WorkerResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(response);
  }
};
