import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { licenceTexts } from './thirdPartyLicences';

const base = mkdtempSync(join(tmpdir(), 'vault-licences-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A package folder holding the given files. */
function pkg(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('the licence texts of a package', () => {
  it('reads the files named like a licence, and the one its manifest names', () => {
    const dir = pkg('plain', { 'LICENSE-MIT': 'mit\r\n', 'LICENSE-APACHE': 'apache', 'docs/TERMS.txt': 'terms', 'license.js': 'code' });
    expect(licenceTexts(dir, 'plain 1.0.0', 'docs/TERMS.txt')).toEqual(['apache', 'mit', 'terms']);
  });

  it('reads a file once, however the manifest spells its path', () => {
    const dir = pkg('once', { LICENSE: 'text' });
    expect(licenceTexts(dir, 'once 1.0.0', './LICENSE')).toEqual(['text']);
  });

  it('reads nothing more when the file the manifest names is not there', () => {
    const dir = pkg('missing', { LICENSE: 'text' });
    expect(licenceTexts(dir, 'missing 1.0.0', 'LICENSE-OTHER')).toEqual(['text']);
  });

  it('stops the build for a licence file outside the package', () => {
    pkg('elsewhere', { id_ed25519: 'a key' });
    const dir = pkg('outside', { LICENSE: 'text' });
    expect(() => licenceTexts(dir, 'outside 1.0.0', '../elsewhere/id_ed25519')).toThrow('outside 1.0.0 names a licence file outside its package');
  });

  it('stops the build when the manifest names a folder', () => {
    const dir = pkg('folder', { 'LICENSES/MIT': 'mit' });
    expect(() => licenceTexts(dir, 'folder 1.0.0', 'LICENSES')).toThrow('not a file');
  });

  it('stops the build for a licence file larger than a licence', () => {
    const dir = pkg('large', { LICENSE: 'x'.repeat(300 * 1024) });
    expect(() => licenceTexts(dir, 'large 1.0.0')).toThrow('larger than 256 KB');
  });
});
