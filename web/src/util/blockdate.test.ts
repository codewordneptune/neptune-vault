import { describe, expect, it } from 'vitest';

import { findHeightForDate, startOfDayMs } from './blockdate';

// A chain of 1000 blocks, one every ten minutes from t0.
const T0 = 1_700_000_000_000;
const STEP = 600_000;
const stampAt = (h: number) => Promise.resolve(h >= 1 && h <= 1000 ? T0 + (h - 1) * STEP : null);

describe('findHeightForDate', () => {
  it('finds the first block at or after the date', async () => {
    let calls = 0;
    const counting = (h: number) => {
      calls += 1;
      return stampAt(h);
    };
    expect(await findHeightForDate(counting, 1000, T0 + 499 * STEP)).toBe(500);
    expect(calls).toBeLessThan(14);
    expect(await findHeightForDate(stampAt, 1000, T0 + 499 * STEP + 1)).toBe(501);
    expect(await findHeightForDate(stampAt, 1000, T0)).toBe(1);
  });
  it('clamps to the chain', async () => {
    expect(await findHeightForDate(stampAt, 1000, T0 - 1)).toBe(1);
    expect(await findHeightForDate(stampAt, 1000, T0 + 5000 * STEP)).toBe(1000);
    expect(await findHeightForDate(stampAt, 0, T0)).toBe(1);
  });
});

describe('startOfDayMs', () => {
  it('reads a calendar day and rejects anything else', () => {
    const t = startOfDayMs('2026-09-15');
    expect(t).not.toBeNull();
    expect(new Date(t as number).getDate()).toBe(15);
    expect(new Date(t as number).getHours()).toBe(0);
    expect(startOfDayMs('15/09/2026')).toBeNull();
    expect(startOfDayMs('')).toBeNull();
  });
});
