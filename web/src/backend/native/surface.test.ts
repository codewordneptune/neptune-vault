// The native clients and the shell are written in different languages and
// nothing compiles them together, so a renamed command or a dropped
// argument would show up only on a device, as a call that fails or a flag
// silently ignored. This reads both sides and holds them to each other.
//
// It checks names and argument names, which is what drifts. Types it cannot
// check, and does not pretend to.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(new URL('../../../../shells/tauri/src/lib.rs', import.meta.url), 'utf8');
const clients = ['walletClient.ts', 'proverClient.ts', 'appClient.ts']
  .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
  .join('\n');

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Split on commas at depth zero, so generics and tuples stay whole. */
function topLevel(text: string, open = '<([{', close = '>)]}'): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (open.includes(ch)) depth += 1;
    else if (close.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Command name to the argument names it accepts, as the web side spells them. */
function commands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /#\[tauri::command\]\s*(?:async\s+)?fn\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  for (const m of shell.matchAll(re)) {
    const args = topLevel(m[2])
      // Tauri injects the managed state and the app handle; neither is sent from the page.
      .filter((p) => !/State<|AppHandle/.test(p))
      .map((p) => camel(p.split(':')[0].trim()));
    found.set(m[1], args);
  }
  return found;
}

/** Every command the shell actually registers. */
function registered(): Set<string> {
  const list = shell.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!list) throw new Error('the shell registers no commands');
  return new Set(topLevel(list[1]));
}

/** Command name to the argument names the web side sends. */
function calls(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /\bcall\s*(?:<[^>]*>)?\s*\(\s*'(\w+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clients)) !== null) {
    let i = re.lastIndex;
    while (i < clients.length && /[\s,]/.test(clients[i])) i += 1;
    if (clients[i] !== '{') {
      found.set(m[1], []);
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < clients.length; end += 1) {
      if (clients[end] === '{') depth += 1;
      else if (clients[end] === '}' && --depth === 0) break;
    }
    const keys = topLevel(clients.slice(i + 1, end))
      .map((s) => s.split(':')[0].trim())
      .filter((k) => /^\w+$/.test(k));
    found.set(m[1], keys);
  }
  return found;
}

describe('the native clients and the shell', () => {
  const accepted = commands();
  const known = registered();
  const sent = calls();

  it('has commands to call', () => {
    expect(sent.size).toBeGreaterThan(20);
  });

  it('calls only commands the shell registers', () => {
    const missing = [...sent.keys()].filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });

  it('registers only commands that exist', () => {
    const phantom = [...known].filter((name) => !accepted.has(name));
    expect(phantom).toEqual([]);
  });

  it('sends exactly the arguments each command takes', () => {
    const wrong: string[] = [];
    for (const [name, keys] of sent) {
      const takes = accepted.get(name) ?? [];
      for (const key of keys) if (!takes.includes(key)) wrong.push(`${name} is sent ${key}, which it does not take`);
      for (const key of takes) if (!keys.includes(key)) wrong.push(`${name} takes ${key}, which is never sent`);
    }
    expect(wrong).toEqual([]);
  });

  it('registers nothing the web side never calls', () => {
    const unused = [...known].filter((name) => !sent.has(name));
    expect(unused).toEqual([]);
  });
});
