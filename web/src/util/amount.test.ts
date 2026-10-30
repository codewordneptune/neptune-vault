import { describe, expect, it } from 'vitest';

import { decimalsProblem, typedTotalNau } from './amount';
import { NARROW_SPACE } from './format';

describe('typedTotalNau', () => {
  const COIN = 4n * 10n ** 30n;

  it('adds exactly, where floating point would not', () => {
    expect(typedTotalNau(['0.1', '0.2'], COIN)).toBe((3n * COIN) / 10n);
    expect(typedTotalNau(['0.12345678', '1', '.5', '7.'], COIN)).toBe(8n * COIN + (62345678n * COIN) / 10n ** 8n);
  });

  it('counts an empty amount as nothing and reads grouped ones', () => {
    expect(typedTotalNau(['', '  ', `12${NARROW_SPACE}345.5`], COIN)).toBe((24691n * COIN) / 2n);
    expect(typedTotalNau([], COIN)).toBe(0n);
  });

  it('gives no figure for an amount that does not read', () => {
    for (const text of ['abc', '1.2.3', '-1', '.', '0.123456789']) expect(typedTotalNau(['1', text], COIN)).toBeNull();
  });
});

describe('decimalsProblem', () => {
  it('accepts up to eight decimals, grouped or not', () => {
    for (const text of ['1', '1.5', '0.12345678', `12${NARROW_SPACE}345.1`, '.5', '7.']) expect(decimalsProblem(text)).toBeNull();
  });

  it('refuses a ninth decimal, however small the amount', () => {
    expect(decimalsProblem('0.123456789')).toMatch(/at most 8 decimals/);
    expect(decimalsProblem('0.000000001')).not.toBeNull();
    expect(decimalsProblem('10.123456789012345678901234567890123')).not.toBeNull();
  });
});
