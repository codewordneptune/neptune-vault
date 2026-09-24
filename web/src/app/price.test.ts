import { describe, expect, it } from 'vitest';

import { fetchQuote, fromCoinGecko, fromCoinPaprika, isFresh, QUOTE_MAX_AGE_MS } from './price';

/** A fetch that answers each host with the body given for it, or fails. */
function fakeFetch(answers: { gecko?: unknown; paprika?: unknown; status?: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('coingecko') ? answers.gecko : url.includes('coinpaprika') ? answers.paprika : undefined;
    if (body === undefined) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body), { status: answers.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const gecko = { 'neptune-cash': { eur: 0.105457, last_updated_at: 1790270470 } };
const paprika = { id: 'npt-neptune-cash', last_updated: '2026-09-24T17:22:18Z', quotes: { EUR: { price: 0.10544380797476426 } } };

describe('the NPT price', () => {
  it('reads CoinGecko', async () => {
    expect(await fromCoinGecko('eur', fakeFetch({ gecko }))).toEqual({ currency: 'eur', price: 0.105457, at: 1790270470000, source: 'CoinGecko' });
  });

  it('reads CoinPaprika', async () => {
    expect(await fromCoinPaprika('eur', fakeFetch({ paprika }))).toEqual({ currency: 'eur', price: 0.10544380797476426, at: Date.parse('2026-09-24T17:22:18Z'), source: 'CoinPaprika' });
  });

  it('falls back to CoinPaprika when CoinGecko does not answer, or answers without a price', async () => {
    expect((await fetchQuote('eur', fakeFetch({ paprika }))).source).toBe('CoinPaprika');
    expect((await fetchQuote('eur', fakeFetch({ gecko: { 'neptune-cash': {} }, paprika }))).source).toBe('CoinPaprika');
  });

  it('refuses a price that is not a positive number, and an error status', async () => {
    await expect(fromCoinGecko('eur', fakeFetch({ gecko: { 'neptune-cash': { eur: 0, last_updated_at: 1 } } }))).rejects.toThrow(/no price/);
    await expect(fromCoinGecko('eur', fakeFetch({ gecko: { 'neptune-cash': { eur: '0.1', last_updated_at: 1 } } }))).rejects.toThrow(/no price/);
    await expect(fromCoinPaprika('eur', fakeFetch({ paprika: { quotes: { EUR: { price: 0.1 } } } }))).rejects.toThrow(/no price/);
    await expect(fromCoinGecko('eur', fakeFetch({ gecko, status: 429 }))).rejects.toThrow(/429/);
    await expect(fetchQuote('eur', fakeFetch({}))).rejects.toThrow();
  });

  it('shows no price older than an hour', () => {
    const quote = { currency: 'eur' as const, price: 1, at: 1_000_000, source: 'CoinGecko' as const };
    expect(isFresh(quote, 1_000_000 + QUOTE_MAX_AGE_MS)).toBe(true);
    expect(isFresh(quote, 1_000_001 + QUOTE_MAX_AGE_MS)).toBe(false);
  });
});
