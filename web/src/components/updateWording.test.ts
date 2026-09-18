import { describe, expect, it } from 'vitest';

import { updateWording } from './updateWording';

const running = { version: '0.2.0', commit: '6248f7d' };

describe('updateWording', () => {
  it('names the waiting version and links the commit range', () => {
    const w = updateWording(running, { version: '0.2.1', commit: 'a1b2c3d' });
    expect(w.headline).toBe('Version 0.2.1 is ready');
    expect(w.current).toBe('You are on 0.2.0');
    expect(w.compare).toBe('6248f7d...a1b2c3d');
  });
  it('tells two builds of one version apart by commit', () => {
    const w = updateWording(running, { version: '0.2.0', commit: 'a1b2c3d' });
    expect(w.headline).toBe('Version 0.2.0 (a1b2c3d) is ready');
    expect(w.current).toBe('You are on 0.2.0 (6248f7d)');
    expect(w.compare).toBe('6248f7d...a1b2c3d');
  });
  it('falls back to the plain wording when the waiting build is unknown', () => {
    const w = updateWording(running, null);
    expect(w.headline).toBe('A new version of Neptune Vault is ready');
    expect(w.current).toBe('You are on 0.2.0 (6248f7d)');
    expect(w.compare).toBeNull();
  });
  it('offers no compare link without both commits', () => {
    expect(updateWording({ version: '0.2.0', commit: 'unknown' }, { version: '0.2.1', commit: 'a1b2c3d' }).compare).toBeNull();
    expect(updateWording(running, { version: '0.2.1', commit: '6248f7d' }).compare).toBeNull();
  });
});

describe('a commit that is not one', () => {
  it("never reaches the compare link: the waiting commit is the host's word", () => {
    const running = { version: '0.2.0', commit: 'abc1234' };
    expect(updateWording(running, { version: '0.2.0', commit: 'def5678' }).compare).toBe('abc1234...def5678');
    for (const odd of ['../../evil', 'def5678?x=1', 'DEF5678', 'unknown', '']) {
      expect(updateWording(running, { version: '0.2.0', commit: odd }).compare, odd).toBeNull();
    }
  });
});
