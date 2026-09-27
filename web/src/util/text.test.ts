import { describe, expect, it } from 'vitest';

import { cleanText } from './text';

describe('text a person typed', () => {
  it('loses the characters that could reorder the text around it, and keeps the rest', () => {
    const rlo = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2067);
    const lineSeparator = String.fromCharCode(0x2028);
    expect(cleanText(`  Ali${rlo}ce ${isolate}Bob${lineSeparator}\n `)).toBe('Ali ce Bob');
    expect(cleanText('Jürgen  Ørsted')).toBe('Jürgen Ørsted');
  });
});
