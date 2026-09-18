import { describe, expect, it } from 'vitest';

import { abbreviateAddress, addressKindLabel, parsePaymentText, paymentQrPayload, paymentUri, metaProblem } from './address';

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
    expect(parsePaymentText('neptunecash:nolgam1abc?amount=1.25')).toEqual({ address: 'nolgam1abc', amount: '1.25', label: undefined, message: undefined });
    expect(parsePaymentText('NEPTUNECASH:NOLGAM1ABC?amount=10&label=Dev%20Fund')).toEqual({ address: 'nolgam1abc', amount: '10', label: 'Dev Fund', message: undefined });
    expect(parsePaymentText('neptunecash:nolgam1abc?label=Caf%C3%A9&message=Invoice%2042')).toMatchObject({ label: 'Café', message: 'Invoice 42' });
    expect(parsePaymentText('neptunecash:nolgam1abc?label=a+b')).toMatchObject({ label: 'a+b' });
    expect(parsePaymentText('neptunecash:nolgam1abc?label=%ZZ').error).toMatch(/name in the link/);
    expect(parsePaymentText('  neptunecash:nolgam1abc?amount=1  ')).toMatchObject({ address: 'nolgam1abc', amount: '1' });
    expect(parsePaymentText('neptunecash:nolgam1abc?label=a?b')).toMatchObject({ address: 'nolgam1abc', label: 'a?b' });
    expect(parsePaymentText('neptunecash:nolgam1abc?shop-order=7')).toMatchObject({ address: 'nolgam1abc', amount: undefined });
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
    expect(paymentQrPayload('nolgam1abc', '2', 'lunch', 'Esa J')).toBe('NEPTUNECASH:NOLGAM1ABC?amount=2&label=Esa%20J&message=lunch');
  });
});

describe('addressKindLabel', () => {
  it('names the kind from the prefix', () => {
    expect(addressKindLabel('nolgam1abc')).toBe('Standard (Generation)');
    expect(addressKindLabel('NECHM1ABC')).toBe('Short (EC hybrid)');
    expect(addressKindLabel('nviewt1abc')).toBe('View-only (Viewing)');
    expect(addressKindLabel('hello')).toBe('Unknown kind');
  });
});

describe('label and message', () => {
  const addr = 'nolgar1' + 'q'.repeat(20);
  it('drops a label or message that is only whitespace', () => {
    const parsed = parsePaymentText(`neptunecash:${addr}?label=%20%20&message=%20Invoice%2042%20`);
    expect(parsed.error).toBeUndefined();
    expect(parsed.label).toBeUndefined();
    expect(parsed.message).toBe('Invoice 42');
  });
  it('puts a note into a link percent-encoded, with a space as %20', () => {
    expect(paymentUri(addr, '1.5', 'for the tickets & more')).toBe(`neptunecash:${addr}?amount=1.5&message=for%20the%20tickets%20%26%20more`);
    expect(paymentUri(addr, undefined, 'Café')).toBe(`neptunecash:${addr}?message=Caf%C3%A9`);
    expect(parsePaymentText(paymentUri(addr, '1.5', 'for the tickets & more')).message).toBe('for the tickets & more');
  });
  it('puts the label before the message, both percent-encoded', () => {
    expect(paymentUri(addr, '2', 'lunch', 'Esa J')).toBe(`neptunecash:${addr}?amount=2&label=Esa%20J&message=lunch`);
    const parsed = parsePaymentText(paymentUri(addr, undefined, undefined, 'Café'));
    expect(parsed.label).toBe('Café');
    expect(parsed.message).toBeUndefined();
  });

  it('refuses notes the spec forbids', () => {
    expect(metaProblem('Invoice 42')).toBeNull();
    expect(metaProblem('a'.repeat(255))).toBeNull();
    expect(metaProblem('a'.repeat(256))).toMatch(/255/);
    expect(metaProblem('line\nbreak')).toMatch(/not allowed/);
    expect(metaProblem('x\u202Ey')).toMatch(/not allowed/);
  });
});

describe('names and notes in a link', () => {
  it('refuses in a link what the link maker refuses: bidi overrides, line separators, C1 controls', () => {
    const address = 'nolgar1' + 'q'.repeat(20);
    for (const bad of ['\u202e', '\u2066', '\u2028', '\u0085', '\u0007']) {
      const link = 'neptunecash:' + address + '?label=' + encodeURIComponent('Shop' + bad + 'pohS');
      expect(parsePaymentText(link).error, JSON.stringify(bad)).toMatch(/name in the link is malformed/);
      expect(metaProblem('Shop' + bad)).not.toBeNull();
    }
    expect(parsePaymentText('neptunecash:' + address + '?label=' + encodeURIComponent('Café Ünïcode 店')).label).toBe('Café Ünïcode 店');
  });
});
