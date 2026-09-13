import { describe, expect, it } from 'vitest';

import { abbreviateAddress, addressKindLabel, parsePaymentText, paymentQrPayload, paymentUri } from './address';

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

describe('parsePaymentText (NIP-002)', () => {
  it('accepts payment URIs, case-insensitive scheme, upper-case address, amount', () => {
    expect(parsePaymentText('neptunecash:nolgam1abc?amount=1.25')).toEqual({ address: 'nolgam1abc', amount: '1.25' });
    expect(parsePaymentText('NEPTUNECASH:NOLGAM1ABC?amount=10&label=Dev%20Fund')).toEqual({ address: 'nolgam1abc', amount: '10' });
    expect(parsePaymentText('  neptunecash:nolgam1abc?amount=1  ')).toEqual({ address: 'nolgam1abc', amount: '1' });
    expect(parsePaymentText('neptunecash:nolgam1abc?label=a?b')).toEqual({ address: 'nolgam1abc', amount: undefined });
    expect(parsePaymentText('neptunecash:nolgam1abc?shop-order=7')).toEqual({ address: 'nolgam1abc', amount: undefined });
  });
  it('accepts the legacy address-only payload and bare addresses', () => {
    expect(parsePaymentText('NPT:NOLGAM1ABC')).toEqual({ address: 'nolgam1abc' });
    expect(parsePaymentText('  nechm1xyz ')).toEqual({ address: 'nechm1xyz' });
  });
  it('rejects what the NIP rejects', () => {
    expect(parsePaymentText('NPT:NOLGAM1ABC?amount=1').error).toMatch(/cannot carry/);
    expect(parsePaymentText('npt:nolgam1abc?amount=1').error).toBeTruthy();
    expect(parsePaymentText('neptune:nolgam1abc').error).toMatch(/Unknown link type/);
    expect(parsePaymentText('neptunecash:Nolgam1abc').error).toMatch(/mixes/);
    expect(parsePaymentText('neptunecash:nolgam1abc?amount=01').error).toMatch(/amount/);
    expect(parsePaymentText('neptunecash:nolgam1abc?amount=.5').error).toMatch(/amount/);
    expect(parsePaymentText('neptunecash:nolgam1abc?Amount=1').error).toMatch(/Invalid parameter/);
    expect(parsePaymentText('neptunecash:nolgam1abc?amount=1&amount=2').error).toMatch(/Repeated/);
    expect(parsePaymentText('neptunecash:nolgam1abc?address=x').error).toMatch(/Unsupported/);
    expect(parsePaymentText('neptunecash:nolgam1abc?req-x=1').error).toMatch(/required extension/);
    expect(parsePaymentText('neptunecash:nolgam1abc#frag').error).toMatch(/malformed/);
    expect(parsePaymentText('neptunecash:nolgam1 abc').error).toMatch(/whitespace/);
  });
});

describe('payment URI generation', () => {
  it('emits the lower-case URI and the upper-case QR payload', () => {
    expect(paymentUri('NOLGAM1ABC', '1.5')).toBe('neptunecash:nolgam1abc?amount=1.5');
    expect(paymentUri('nolgam1abc')).toBe('neptunecash:nolgam1abc');
    expect(paymentQrPayload('nolgam1abc')).toBe('NEPTUNECASH:NOLGAM1ABC');
    expect(paymentQrPayload('nolgam1abc', '2')).toBe('NEPTUNECASH:NOLGAM1ABC?amount=2');
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
