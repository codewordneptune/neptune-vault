import { describe, expect, it } from 'vitest';

import { groupDigits, NARROW_SPACE, showInt } from './format';

const S = NARROW_SPACE;

describe('digit grouping', () => {
  it('groups the whole part in threes and leaves the fraction alone', () => {
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe(`1${S}000`);
    expect(groupDigits('53547')).toBe(`53${S}547`);
    expect(groupDigits('3086419.74999999')).toBe(`3${S}086${S}419.74999999`);
    expect(groupDigits('0.5')).toBe('0.5');
  });
  it('rounds and groups whole numbers', () => {
    expect(showInt(1025.6)).toBe(`1${S}026`);
    expect(showInt(15)).toBe('15');
  });
});
