import { describe, expect, it } from 'vitest';

import { fiatOf, fiatOfTyped, formatFiat, isFiatCurrency } from './fiat';
import { NARROW_SPACE } from './format';

const NAU_PER_COIN = 4n * 10n ** 30n;

describe('values in another currency', () => {
  it('converts nau at a price per NPT', () => {
    expect(fiatOf(15n * NAU_PER_COIN, NAU_PER_COIN, 0.12)).toBeCloseTo(1.8, 10);
    expect(fiatOf(NAU_PER_COIN / 2n, NAU_PER_COIN, 0.12)).toBeCloseTo(0.06, 10);
    expect(fiatOf(0n, NAU_PER_COIN, 0.12)).toBe(0);
  });

  it('writes the number, then the ISO code, with digits grouped as the app groups them', () => {
    expect(formatFiat(1234.5, 'usd')).toBe(`1${NARROW_SPACE}234.50 USD`);
    expect(formatFiat(1.8, 'eur')).toBe('1.80 EUR');
    expect(formatFiat(1234, 'jpy')).toBe(`1${NARROW_SPACE}234 JPY`);
    // Where symbols would have been the same, the codes are not.
    expect([formatFiat(5, 'usd'), formatFiat(5, 'cad'), formatFiat(5, 'aud')]).toEqual(['5.00 USD', '5.00 CAD', '5.00 AUD']);
  });

  it('shows no more decimals than the currency uses, and a value below its smallest unit as such', () => {
    expect(formatFiat(0.9844, 'eur')).toBe('0.98 EUR');
    expect(formatFiat(0.0036, 'usd')).toBe('< 0.01 USD');
    expect(formatFiat(0.4, 'jpy')).toBe('< 1 JPY');
    expect(formatFiat(0, 'eur')).toBe('0.00 EUR');
  });

  it('estimates an amount as typed only when it is a plain decimal', () => {
    expect(fiatOfTyped('12', 0.12)).toBeCloseTo(1.44, 10);
    expect(fiatOfTyped(`1${NARROW_SPACE}000.5`, 0.1)).toBeCloseTo(100.05, 10);
    expect(fiatOfTyped('.5', 0.1)).toBeCloseTo(0.05, 10);
    for (const text of ['', '0', '1,5', '1.2.3', '-1', 'abc', '1e3']) expect(fiatOfTyped(text, 0.1)).toBeNull();
  });

  it('knows the currencies it offers', () => {
    expect(isFiatCurrency('eur')).toBe(true);
    expect(isFiatCurrency('btc')).toBe(false);
    expect(isFiatCurrency(undefined)).toBe(false);
  });
});
