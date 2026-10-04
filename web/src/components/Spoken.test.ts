import { describe, expect, it } from 'vitest';

import { spokenText } from './Spoken';
import { showInt } from '../util/format';
import { formatAbout, formatDuration } from '../util/time';

describe('a text said aloud', () => {
  it('says a grouped figure as one number', () => {
    expect(spokenText(`${showInt(12345)}.5 NPT to Alice`)).toBe('12345.5 NPT to Alice');
    expect(spokenText(`Up to date · block ${showInt(55123)}`)).toBe('Up to date · block 55123');
    expect(spokenText(`≈ ${showInt(1234567)}.89 EUR`)).toBe('≈ 1234567.89 EUR');
  });

  it('says a hidden amount as hidden', () => {
    expect(spokenText('•••• NPT to Alice, plus a •••• NPT fee.')).toBe('hidden NPT to Alice, plus a hidden NPT fee.');
  });

  it('says short units of time as words', () => {
    expect(spokenText(formatDuration(45))).toBe('45 seconds');
    expect(spokenText(formatDuration(143))).toBe('2 minutes 23 seconds');
    expect(spokenText(formatDuration(3900))).toBe('1 hour 5 minutes');
    expect(spokenText(`${showInt(1234)} s, peak ${showInt(2345)} MB`)).toBe('1234 seconds, peak 2345 MB');
    expect(spokenText(`${formatAbout(40)} left`)).toBe('about 40 seconds left');
    expect(spokenText('price from 1 min ago')).toBe('price from 1 minute ago');
  });

  it('leaves everything else as it is', () => {
    expect(spokenText('3 sends you gave up on, 2 inputs, 5 minimum')).toBe('3 sends you gave up on, 2 inputs, 5 minimum');
    expect(spokenText('12.5 NPT at 8:55 PM, 0.05 NPT fee')).toBe('12.5 NPT at 8:55 PM, 0.05 NPT fee');
    expect(spokenText('')).toBe('');
  });
});
