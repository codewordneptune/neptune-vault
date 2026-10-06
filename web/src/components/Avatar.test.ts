import { describe, expect, it } from 'vitest';

import { hueOf, initialOf } from './Avatar';

describe('initialOf', () => {
  it('takes the first letter in upper case', () => {
    expect(initialOf('bob')).toBe('B');
    expect(initialOf('  alice')).toBe('A');
    expect(initialOf('Öljy')).toBe('Ö');
  });

  it('skips invisible and directional marks before the name', () => {
    expect(initialOf('​bob')).toBe('B');
    expect(initialOf('‮carol')).toBe('C');
  });

  it('keeps an emoji whole', () => {
    expect(initialOf('👩‍💻 Dana')).toBe('👩‍💻');
  });

  it('falls back to a question mark when there is nothing to show', () => {
    expect(initialOf('')).toBe('?');
    expect(initialOf('​ ')).toBe('?');
  });
});

describe('hueOf', () => {
  it('is stable, ignores case and surrounding space, and stays in range', () => {
    const a = 'nolgam1qqexample';
    expect(hueOf(a)).toBe(hueOf(` ${a.toUpperCase()} `));
    for (const s of ['a', 'b', 'nolgam1abc', 'nolgam1abd', 'x'.repeat(3500)]) {
      expect(hueOf(s)).toBeGreaterThanOrEqual(0);
      expect(hueOf(s)).toBeLessThan(5);
    }
  });

  it('spreads addresses over the colours', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => hueOf(`nolgam1${i}`)));
    expect(seen.size).toBe(5);
  });
});
