// The NPT price in an ordinary currency, for the optional line under the
// balance. Off unless the person turns it on in Settings: asking a price
// site tells it this device's network address and that it runs a Neptune
// Cash wallet, and the privacy statement says so.
//
// Two public sources that list Neptune Cash, need no key and answer a web
// page directly: CoinGecko first, CoinPaprika when it does not answer. Each
// device asks for itself, a few times an hour at most, far inside both
// sites' limits per address. They take the price from the same few markets,
// so the second is a fallback, not a second opinion.

import { useEffect, useState } from 'react';

import type { FiatCurrency } from '../util/fiat';

export interface Quote {
  currency: FiatCurrency;
  /** Per NPT. */
  price: number;
  /** When the source last updated it, in milliseconds. */
  at: number;
  source: 'CoinGecko' | 'CoinPaprika';
}

/** How often an open app asks again. */
export const QUOTE_REFRESH_MS = 10 * 60 * 1000;
/** After a failed ask, how long before the next. */
const QUOTE_RETRY_MS = 2 * 60 * 1000;
/** A price older than this is not shown at all: no figure is better than a stale one. */
export const QUOTE_MAX_AGE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

async function getJson(url: string, fetchImpl: Fetch): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    // Nothing of this app goes with the request: no cookies, no referrer.
    const response = await fetchImpl(url, { signal: abort.signal, headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export async function fromCoinGecko(currency: FiatCurrency, fetchImpl: Fetch = fetch): Promise<Quote> {
  const body = (await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=neptune-cash&vs_currencies=${currency}&include_last_updated_at=true`, fetchImpl)) as {
    'neptune-cash'?: Record<string, unknown>;
  } | null;
  const row = body?.['neptune-cash'];
  const price = row?.[currency];
  const at = row?.last_updated_at;
  if (!positive(price) || !positive(at)) throw new Error('CoinGecko sent no price');
  return { currency, price, at: at * 1000, source: 'CoinGecko' };
}

export async function fromCoinPaprika(currency: FiatCurrency, fetchImpl: Fetch = fetch): Promise<Quote> {
  const code = currency.toUpperCase();
  const body = (await getJson(`https://api.coinpaprika.com/v1/tickers/npt-neptune-cash?quotes=${code}`, fetchImpl)) as {
    last_updated?: string;
    quotes?: Record<string, { price?: unknown }>;
  } | null;
  const price = body?.quotes?.[code]?.price;
  const at = Date.parse(body?.last_updated ?? '');
  if (!positive(price) || !Number.isFinite(at)) throw new Error('CoinPaprika sent no price');
  return { currency, price, at, source: 'CoinPaprika' };
}

/** The price from the first source that gives one. */
export async function fetchQuote(currency: FiatCurrency, fetchImpl: Fetch = fetch): Promise<Quote> {
  try {
    return await fromCoinGecko(currency, fetchImpl);
  } catch {
    return fromCoinPaprika(currency, fetchImpl);
  }
}

export function isFresh(quote: Quote, now = Date.now()): boolean {
  return now - quote.at <= QUOTE_MAX_AGE_MS;
}

// One price for the app, kept between visits to Home, so opening a screen
// never asks again sooner than the refresh allows.
let cached: Quote | null = null;
let nextAskAt = 0;

/**
 * The current price in `currency`, or null: when the setting is off, before
 * the first answer, when no source answers, or when the last price is too
 * old. Asks only while the app is in view and online.
 */
export function useQuote(currency: FiatCurrency | undefined): Quote | null {
  const [quote, setQuote] = useState<Quote | null>(cached);
  useEffect(() => {
    if (!currency) return;
    let live = true;
    const load = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (cached?.currency === currency && Date.now() < nextAskAt) {
        setQuote(cached);
        return;
      }
      if (cached?.currency !== currency) nextAskAt = 0;
      if (Date.now() < nextAskAt) return;
      try {
        const fresh = await fetchQuote(currency);
        cached = fresh;
        nextAskAt = Date.now() + QUOTE_REFRESH_MS;
        if (live) setQuote(fresh);
      } catch {
        nextAskAt = Date.now() + QUOTE_RETRY_MS;
      }
    };
    void load();
    const timer = setInterval(() => void load(), QUOTE_RETRY_MS);
    const onShow = () => void load();
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('online', onShow);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('online', onShow);
    };
  }, [currency]);
  return currency && quote && quote.currency === currency && isFresh(quote) ? quote : null;
}
