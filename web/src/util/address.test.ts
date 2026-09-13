import { describe, expect, it } from 'vitest';

import { abbreviateAddress, addressKindLabel, parsePaymentText } from './address';

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

describe('parsePaymentText', () => {
  it('strips the scheme, lower-cases, and reads the amount', () => {
    expect(parsePaymentText('NPT:NOLGAM1ABC?amount=1.5')).toEqual({ address: 'nolgam1abc', amount: '1.5' });
    expect(parsePaymentText('  nechm1xyz ')).toEqual({ address: 'nechm1xyz', amount: undefined });
  });
});

describe('addressKindLabel', () => {
  it('names the kind from the prefix', () => {
    expect(addressKindLabel('nolgam1abc')).toBe('Generation');
    expect(addressKindLabel('NECHM1ABC')).toBe('EC hybrid');
    expect(addressKindLabel('nviewt1abc')).toBe('Viewing');
    expect(addressKindLabel('hello')).toBe('Unknown kind');
  });
});
