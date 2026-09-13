import { describe, expect, it } from 'vitest';

import { abbreviateAddress } from './address';

describe('abbreviateAddress', () => {
  it('keeps the prefix plus eight characters and the last eight', () => {
    const address = 'nolgam1' + 'a'.repeat(2900) + 'zyxwvuts';
    expect(abbreviateAddress(address)).toBe('nolgam1aaaaaaa...zyxwvuts');
  });

  it('applies the same rule to the other prefixes', () => {
    const ech = 'nechm1' + 'b'.repeat(150) + '12345678';
    expect(abbreviateAddress(ech)).toBe('nechm1bbbbbbb...12345678');
  });

  it('leaves short strings alone', () => {
    expect(abbreviateAddress('nolgam1abc')).toBe('nolgam1abc');
    expect(abbreviateAddress('')).toBe('');
  });
});
