import { describe, expect, it } from 'vitest';
import { SEED_WORD_COUNT, suggestWords } from './seedWords';

describe('suggestWords', () => {
  it('holds the whole list', () => {
    expect(SEED_WORD_COUNT).toBe(2048);
  });

  it('suggests nothing for a word on the list', () => {
    expect(suggestWords('abandon')).toEqual([]);
    expect(suggestWords(' Zoo ')).toEqual([]);
  });

  it('suggests the word sharing the first four letters first', () => {
    expect(suggestWords('abandom')).toEqual(['abandon']);
  });

  it('suggests words one letter apart: a change, an extra, a missing one, a swap', () => {
    expect(suggestWords('zoa')).toContain('zoo');
    expect(suggestWords('zooo')).toContain('zoo');
    expect(suggestWords('zo')).toContain('zoo');
    expect(suggestWords('ozo')).toContain('zoo');
  });

  it('suggests at most three', () => {
    expect(suggestWords('ace').length).toBeLessThanOrEqual(3);
  });
});
