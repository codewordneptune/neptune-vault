// The notice every build ships for the third-party software in it: each
// Rust crate and npm package, its licence, and each licence text with its
// copyright lines, once per distinct text. MIT, BSD and Apache-2.0 require
// it in every copy handed out (README, Licence). Built from the lock files,
// for the platform the build is for, and from the packages' own licence
// files, so it names no crate only another platform uses and no path on the
// builder's machine. A licence file must lie inside its package: a crate's
// manifest can name any path, and whatever is read here is published.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Item {
  group: 'Rust crates' | 'JavaScript packages' | 'Other';
  name: string;
  version: string;
  licence: string;
  texts: string[];
  /** The package carries no licence text, so its licence's standard text stands in. */
  standard?: boolean;
}

interface CargoMetadata {
  packages: { id: string; name: string; version: string; license: string | null; license_file: string | null; manifest_path: string }[];
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
  workspace_members: string[];
}

const WEB = dirname(fileURLToPath(import.meta.url));
const REPO = join(WEB, '..');

// By code point, not by locale, so every machine sorts alike.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// LICENSE, LICENSE-MIT, COPYING.txt, NOTICE and the like; not code that happens to be named so.
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)(?![a-z])/i;
const NOT_A_TEXT = /\.(js|mjs|cjs|ts|json|rs|html|css|map)$/i;

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Far above the size of any licence text. */
const MAX_TEXT_BYTES = 256 * 1024;

/**
 * A package's licence texts: the files in its folder named like a licence,
 * and `named`, the one its manifest names. Each must resolve, links
 * followed, to a regular file inside the package and of a licence's size,
 * or the build stops and names the package.
 */
export function licenceTexts(dir: string, label: string, named?: string | null): string[] {
  const root = realpathSync.native(dir);
  const files = new Map<string, string>();
  const take = (name: string, fromManifest: boolean) => {
    let real: string;
    try {
      real = realpathSync.native(resolve(dir, name));
    } catch {
      // Named in the manifest but not in the package: nothing to read.
      return;
    }
    if (!real.startsWith(root + sep)) throw new Error(`third-party licences: ${label} names a licence file outside its package: ${name}`);
    const stat = statSync(real);
    if (!stat.isFile()) {
      if (fromManifest) throw new Error(`third-party licences: ${label} names a licence file that is not a file: ${name}`);
      return;
    }
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`third-party licences: ${label} has a licence file larger than ${MAX_TEXT_BYTES / 1024} KB: ${name}`);
    files.set(real, relative(root, real).split(sep).join('/'));
  };
  for (const name of readdirSync(dir)) if (LICENCE_FILE.test(name) && !NOT_A_TEXT.test(name)) take(name, false);
  if (named) take(named, true);
  return [...files]
    .sort(([, a], [, b]) => byCodePoint(a, b))
    .map(([real]) => normalise(readFileSync(real, 'utf8')));
}

/** The platform a build is for: wasm for the web app; for the apps, the one Tauri builds for, or else this machine's. */
export function targetOf(web: boolean): string {
  if (web) return 'wasm32-unknown-unknown';
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const host = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { cwd: REPO }).toString())?.[1];
  if (!host) throw new Error('third-party licences: rustc did not say which platform this is');
  return host;
}

/** The crates the given workspace members are built from on `target`, tests' own dependencies left out. */
function crates(roots: string[], target: string): Item[] {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', target, '--manifest-path', join(REPO, 'Cargo.toml')], {
      maxBuffer: 512 * 1024 * 1024,
    }).toString(),
  ) as CargoMetadata;
  const own = new Set(meta.workspace_members);
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const queue = meta.packages.filter((p) => own.has(p.id) && roots.includes(p.name)).map((p) => p.id);
  if (queue.length !== roots.length) throw new Error(`third-party licences: not every crate of ${roots.join(', ')} is in the workspace`);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((k) => k.kind !== 'dev')) queue.push(dep.pkg);
  }
  return [...seen]
    .filter((id) => !own.has(id))
    .map((id) => {
      const p = packages.get(id) as CargoMetadata['packages'][number];
      const texts = licenceTexts(dirname(p.manifest_path), `${p.name} ${p.version}`, p.license_file);
      return { group: 'Rust crates', name: p.name, version: p.version, licence: p.license ?? 'see its licence text', texts };
    });
}

function npmPackage(dir: string): Item {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string | { type?: string } };
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see its licence text');
  return { group: 'JavaScript packages', name: pkg.name, version: pkg.version, licence, texts: licenceTexts(dir, `${pkg.name} ${pkg.version}`) };
}

// Licences whose text names the copyright holder: as a standard text for
// another package, that line is dropped (the package's own authors hold it).
const NAMES_HOLDER = new Set(['MIT', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib']);

function withoutHolder(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^copyright\b/i.test(line.trim()) && !/^all rights reserved\.?$/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The standard texts, for packages that name a licence but carry no text of
 * it: MIT and Apache-2.0 from this repository, any other from the
 * first package in `items` that carries that licence alone.
 */
function standardTexts(items: Item[]): Map<string, string> {
  const texts = new Map([
    ['MIT', withoutHolder(normalise(readFileSync(join(REPO, 'LICENSE-MIT'), 'utf8')))],
    ['Apache-2.0', normalise(readFileSync(join(REPO, 'LICENSE-APACHE'), 'utf8'))],
  ]);
  for (const item of items) {
    if (texts.has(item.licence) || item.texts.length !== 1 || /[\s/()]/.test(item.licence)) continue;
    texts.set(item.licence, NAMES_HOLDER.has(item.licence) ? withoutHolder(item.texts[0]) : item.texts[0]);
  }
  return texts;
}

/** The standard texts that cover a licence expression: one choice for OR, every part for AND. */
function standardFor(expression: string, standard: Map<string, string>): string[] {
  const ids = expression.split(/\s+(?:OR|AND)\s+|\/|[()]/).map((id) => id.trim()).filter((id) => standard.has(id));
  if (ids.length === 0) return [];
  return /\bAND\b/.test(expression) ? ids.map((id) => standard.get(id) as string) : [standard.get(ids[0]) as string];
}

/** Code that reaches the build without a package of its own. */
function others(packages: Item[]): Item[] {
  const items: Item[] = [{ group: 'Other', name: 'Inter typeface', version: '', licence: 'OFL-1.1', texts: [normalise(readFileSync(join(WEB, 'src/assets/fonts/Inter-LICENSE.txt'), 'utf8'))] }];
  if (packages.some((p) => p.name === 'zxing-wasm')) {
    // The QR reader's WebAssembly is zxing-cpp's C++ compiled by zxing-wasm,
    // whose package carries only its own MIT licence.
    items.push({
      group: 'Other',
      name: 'zxing-cpp, in the zxing-wasm reader (https://github.com/zxing-cpp/zxing-cpp)',
      version: '',
      licence: 'Apache-2.0',
      texts: [normalise(readFileSync(join(REPO, 'LICENSE-APACHE'), 'utf8'))],
    });
  }
  return items;
}

/**
 * The notice for one build: `roots` are the workspace crates it compiles
 * (the wasm packages, or the native shell), `target` the platform it
 * compiles them for, and `npmDirs` the npm packages whose code went into
 * its bundles.
 */
export function thirdPartyLicences(roots: string[], target: string, npmDirs: Iterable<string>): string {
  const packages = [...new Set(npmDirs)].map(npmPackage);
  const items = [...crates(roots, target), ...packages, ...others(packages)];
  const order = ['Rust crates', 'JavaScript packages', 'Other'];
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || byCodePoint(a.name, b.name) || byCodePoint(a.version, b.version));
  const standard = standardTexts(items);
  for (const item of items) {
    if (item.texts.length > 0) continue;
    item.texts = standardFor(item.licence, standard);
    item.standard = item.texts.length > 0;
  }

  // Each distinct text once, numbered in the order the sorted list first uses it.
  const textNumber = new Map<string, number>();
  const users: string[][] = [];
  const label = (item: Item) => (item.version ? `${item.name} ${item.version}` : item.name);
  for (const item of items) {
    for (const text of item.texts) {
      if (!textNumber.has(text)) {
        textNumber.set(text, textNumber.size + 1);
        users.push([]);
      }
      users[(textNumber.get(text) as number) - 1].push(label(item));
    }
  }

  const out: string[] = [
    'Third-party software in Neptune Vault',
    '',
    'Neptune Vault is licensed under MIT OR Apache-2.0 (LICENSE-MIT and',
    'LICENSE-APACHE in its source repository). It contains the software',
    'listed below, each under its own licence. The licence texts follow the',
    'lists, each text once, with the software it applies to; [n] marks which.',
  ];
  for (const group of order) {
    const members = items.filter((i) => i.group === group);
    if (members.length === 0) continue;
    out.push('', '', `${group} (${members.length})`, '');
    for (const item of members) {
      const refs = item.texts.map((t) => `[${textNumber.get(t)}]`).join(' ') || '(no licence text in the package: the standard text of its licence applies)';
      out.push(`${label(item)}: ${item.licence} ${refs}${item.standard ? ' (standard text; the package carries none)' : ''}`);
    }
  }
  out.push('', '', 'Licence texts');
  [...textNumber.keys()].forEach((text, i) => {
    out.push('', '', `[${i + 1}] Applies to: ${users[i].join(', ')}`, '', text);
  });
  return out.join('\n') + '\n';
}

/** The package folder a bundled module comes from, or null for the app's own code. */
export function packageDir(moduleId: string): string | null {
  const path = moduleId.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return existsSync(join(path.slice(0, at), 'node_modules', name, 'package.json')) ? join(path.slice(0, at), 'node_modules', name) : null;
}
