// Talking to the Rust that a native shell hosts.
//
// The same crates the browser runs as wasm are compiled for the device and
// reached through the shell's command channel. Two things need saying about
// how values travel.
//
// Bytes go as base64. Tauri turns a Uint8Array inside a JSON payload into an
// array of numbers, which for a witness of a megabyte is four megabytes of
// text to write and parse. Base64 is a third of that and needs no special
// handling on either side. Passing the whole body raw is faster still, and
// worth doing if this ever shows up in a measurement, but it allows only one
// argument per command, which most of these need more than.
//
// Errors keep their name. The app distinguishes a wrong password from a
// broken one, and a call cut off by locking from a call that failed, so the
// Rust side names its errors and this file turns them back into the classes
// the app already catches.

import { invoke } from '@tauri-apps/api/core';

import { WrongPasswordError } from '../../storage/envelope';
import { WalletLockedError } from '../browser/walletClient';

/** What a failing command sends back. */
interface NamedError {
  name?: string;
  message?: string;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  // In chunks: one spread of a megabyte-long array overflows the call stack.
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Invoke a command, with the app's own errors coming back as themselves. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    const named = (typeof e === 'object' && e !== null ? e : {}) as NamedError;
    const message = named.message ?? String(e);
    if (named.name === 'WrongPasswordError') throw new WrongPasswordError();
    if (named.name === 'WalletLockedError') throw new WalletLockedError();
    throw new Error(message);
  }
}
