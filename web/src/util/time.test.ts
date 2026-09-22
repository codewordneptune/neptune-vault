import { describe, expect, it } from 'vitest';

import { dayKey, dayLabel, formatTime, formatWhen } from './time';

// Sunday 13 September 2026, 16:30 on this machine's clock.
const now = new Date(2026, 8, 13, 16, 30).getTime();
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();

describe('formatWhen', () => {
  it('names today and yesterday, the weekday within a week, otherwise day and month, with the year only when it differs', () => {
    expect(formatWhen(at(2026, 8, 13, 9, 5), now)).toMatch(/^Today /);
    expect(formatWhen(at(2026, 8, 12, 23, 59), now)).toMatch(/^Yesterday /);
    expect(formatWhen(at(2026, 8, 9), now)).toMatch(new RegExp('^' + new Date(at(2026, 8, 9)).toLocaleDateString(undefined, { weekday: 'short' })));
    expect(formatWhen(at(2026, 7, 2), now)).toMatch(/Aug/);
    expect(formatWhen(at(2026, 7, 2), now)).not.toMatch(/2026|Today|Yesterday/);
    expect(formatWhen(at(2025, 11, 31), now)).toMatch(/2025/);
  });
});

describe('formatTime', () => {
  it('writes the hour without a leading zero', () => {
    expect(formatTime(at(2026, 8, 13, 8, 5))).not.toMatch(/^0/);
  });
});

describe('dayLabel', () => {
  it('says Today, Yesterday, a weekday for the rest of the week, then a date', () => {
    expect(dayLabel(at(2026, 8, 13, 0, 1), now)).toBe('Today');
    expect(dayLabel(at(2026, 8, 12, 23, 59), now)).toBe('Yesterday');
    const monday = at(2026, 8, 7);
    expect(dayLabel(monday, now)).toBe(new Date(monday).toLocaleDateString(undefined, { weekday: 'long' }));
    // A week ago today would share its weekday with today: from there on, the date.
    expect(dayLabel(at(2026, 8, 6), now)).toMatch(/Sep/);
    expect(dayLabel(at(2026, 7, 21), now)).not.toMatch(/2026/);
    expect(dayLabel(at(2025, 7, 3), now)).toMatch(/2025/);
  });
});

describe('dayKey', () => {
  it('is one key per calendar day on this device', () => {
    expect(dayKey(at(2026, 8, 13, 0, 1))).toBe(dayKey(at(2026, 8, 13, 23, 59)));
    expect(dayKey(at(2026, 8, 13, 0, 1))).not.toBe(dayKey(at(2026, 8, 12, 23, 59)));
  });
});
