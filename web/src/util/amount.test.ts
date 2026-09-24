import { describe, expect, it } from 'vitest';

import { decimalsProblem } from './amount';
import { NARROW_SPACE } from './format';

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
