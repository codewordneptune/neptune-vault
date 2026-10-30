import { describe, expect, it } from 'vitest';

import { fromPayLink, paymentTextIn, requestInFragment } from './sharedLinks';

const ADDRESS = 'nolgar1' + 'q'.repeat(60);
const REQUEST = `neptunecash:${ADDRESS}?amount=2.5&label=Alice%20B`;

describe('links that reach the app from elsewhere', () => {
  it('reads the request a /pay link carries', () => {
    expect(fromPayLink(`https://vault.example.org/pay#${REQUEST}`)).toBe(REQUEST);
  });

  it('takes a request whose colon an app encoded, and nothing that is not a request', () => {
    expect(requestInFragment(`#neptunecash%3A${ADDRESS}`)).toBe(`neptunecash:${ADDRESS}`);
    expect(requestInFragment('#somewhere')).toBeNull();
    expect(fromPayLink(`https://vault.example.org/send#${REQUEST}`)).toBeNull();
    expect(fromPayLink('not a link')).toBeNull();
  });

  it('finds the address or the request in shared text with other words around it', () => {
    expect(paymentTextIn(`Here is my address: ${ADDRESS} thanks!`)).toBe(ADDRESS);
    expect(paymentTextIn(`Pay me\n${REQUEST}`)).toBe(REQUEST);
    expect(paymentTextIn(`Open https://vault.example.org/pay#${REQUEST}`)).toBe(REQUEST);
  });

  it('leaves text with nothing to pay as it is, for Send to say why', () => {
    expect(paymentTextIn('  hello there  ')).toBe('hello there');
  });
});
