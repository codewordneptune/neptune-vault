import { describe, expect, it } from 'vitest';

import { NAU_PER_COIN, showNau } from './AppContext';
import { decimalsOf, fixedNau } from './countUp';

const npt = (whole: bigint, tenths = 0n) => whole * NAU_PER_COIN + (tenths * NAU_PER_COIN) / 10n;

describe('a counting figure', () => {
  it('knows how many decimals a figure shows', () => {
    expect(decimalsOf(npt(25n, 7n))).toBe(1);
    expect(decimalsOf(npt(27n))).toBe(0);
    expect(decimalsOf(NAU_PER_COIN / 3n)).toBe(8);
  });

  it('keeps one width while it counts, cut as the figure is', () => {
    expect(fixedNau(npt(26n), 1)).toBe('26.0');
    expect(fixedNau(npt(26n, 4n) + NAU_PER_COIN / 100n, 1)).toBe('26.4');
    expect(fixedNau(NAU_PER_COIN / 3n, 3)).toBe('0.333');
    expect(fixedNau(npt(12_345n, 5n), 2)).toBe(`${showNau(npt(12_345n))}.50`);
    expect(fixedNau(npt(7n, 9n), 0)).toBe('7');
  });
});
