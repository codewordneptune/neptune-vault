import { describe, expect, it } from 'vitest';

import { formatWhen } from './time';

describe('formatWhen', () => {
  const now = new Date(2026, 8, 13, 16, 30).getTime();
  it('names today and yesterday, otherwise day and month, with the year only when it differs', () => {
    expect(formatWhen(new Date(2026, 8, 13, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 8, 12, 23, 59).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatWhen(new Date(2026, 7, 2, 12, 0).getTime(), now)).toMatch(/^2 Aug /);
    expect(formatWhen(new Date(2025, 11, 31, 12, 0).getTime(), now)).toMatch(/2025/);
  });
});
