// An amount of NPT in an ordinary currency, for the optional line under the
// balance: which currencies are offered, and how a value is written.

import { NARROW_SPACE } from './format';

/** Offered where both price sources quote them. */
export const FIAT_CURRENCIES = ['usd', 'eur', 'gbp', 'chf', 'jpy', 'cny', 'krw', 'inr', 'cad', 'aud', 'sek', 'nok'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

export const FIAT_LABELS: Record<FiatCurrency, string> = {
  usd: 'US dollar (USD)',
  eur: 'Euro (EUR)',
  gbp: 'Pound sterling (GBP)',
  chf: 'Swiss franc (CHF)',
  jpy: 'Japanese yen (JPY)',
  cny: 'Chinese yuan (CNY)',
  krw: 'South Korean won (KRW)',
  inr: 'Indian rupee (INR)',
  cad: 'Canadian dollar (CAD)',
  aud: 'Australian dollar (AUD)',
  sek: 'Swedish krona (SEK)',
  nok: 'Norwegian krone (NOK)',
};

export function isFiatCurrency(value: unknown): value is FiatCurrency {
  return typeof value === 'string' && (FIAT_CURRENCIES as readonly string[]).includes(value);
}

/**
 * What an amount of NPT, as typed, is worth at `price`: only for a plain
 * decimal ("12", "1.5", "0.25"; spaces are grouping), else null, so an
 * amount that is not yet a number shows no estimate at all.
 */
export function fiatOfTyped(text: string, price: number): number | null {
  const plain = text.replace(/[\s\u202F\u00A0]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(plain)) return null;
  const npt = Number(plain);
  return Number.isFinite(npt) && npt > 0 ? npt * price : null;
}

/** What `nau` is worth at `price` per NPT. A float: this is for reading, never for arithmetic. */
export function fiatOf(nau: bigint, nauPerCoin: bigint, price: number): number {
  return (Number(nau) / Number(nauPerCoin)) * price;
}

/**
 * A value as people read it: the number, then the currency's ISO code, as
 * the app writes NPT ("8.2 NPT", "0.98 EUR"). Symbols would not do: "$"
 * stands for three of these currencies, "¥" and "kr" for two each. The
 * currency's usual decimals (cents, none for yen and won), digits grouped
 * by a narrow space as the app groups every number. It is an estimate, so
 * no more precise than that; a value below the smallest unit says so
 * rather than showing nothing.
 */
export function formatFiat(value: number, currency: FiatCurrency): string {
  const code = currency.toUpperCase();
  const decimals = new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  const number = new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const smallest = 10 ** -decimals;
  const text = value > 0 && value < smallest ? `< ${number.format(smallest)}` : number.format(value);
  return `${text.replace(/,/g, NARROW_SPACE)} ${code}`;
}
