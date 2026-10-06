import { describe, expect, it } from 'vitest';

import { balanceLine, type LineEntry } from './balanceLine';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 12);
const e = (netNau: bigint, daysAgo: number, counts = true): LineEntry => ({ netNau, timestampMs: NOW - daysAgo * DAY, counts });

describe('balanceLine', () => {
  it('is flat without entries in the window, and ends at today', () => {
    const line = balanceLine(50n, [e(50n, 40)], NOW);
    expect(line).toHaveLength(31);
    expect(new Set(line)).toEqual(new Set([50n]));
  });

  it('walks back through a payment received and a send', () => {
    const line = balanceLine(70n, [e(100n, 10.5), e(-30n, 2.5)], NOW, 30);
    expect(line[0]).toBe(0n);
    expect(line[19]).toBe(0n); // 11 days ago: before the payment
    expect(line[20]).toBe(100n); // 10 days ago: after it
    expect(line[27]).toBe(100n); // 3 days ago: before the send
    expect(line[28]).toBe(70n);
    expect(line[30]).toBe(70n);
  });

  it('leaves out entries the balance does not include', () => {
    const line = balanceLine(10n, [e(5n, 1, false)], NOW, 3);
    expect(line).toEqual([10n, 10n, 10n, 10n]);
  });
});
