import { describe, expect, it } from 'vitest';

import { CSV_HEADER, csvDate, historyCsv, type CsvRow } from './historyCsv';

const row = (over: Partial<CsvRow> = {}): CsvRow => ({
  date: '2026-10-30 01:22',
  type: 'Sent',
  state: 'Confirmed',
  who: 'Bob',
  address: 'nolgar1abc',
  amount: '0.1',
  fee: '0.3',
  total: '-0.4',
  block: 48,
  note: '',
  transaction: 'tx1',
  ...over,
});

describe('History as a spreadsheet', () => {
  it('has a header, one line per payment and CRLF line ends, after a byte order mark', () => {
    const csv = historyCsv([row(), row({ type: 'Received', amount: '3.75', fee: null, total: '3.75', who: '', address: '' })]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines[1]).toBe('2026-10-30 01:22,Sent,Confirmed,Bob,nolgar1abc,0.1,0.3,-0.4,48,,tx1');
    expect(lines[2]).toBe('2026-10-30 01:22,Received,Confirmed,,,3.75,,3.75,48,,tx1');
    expect(lines[3]).toBe('');
  });

  it('quotes text with commas, quotes or line breaks', () => {
    const csv = historyCsv([row({ note: 'Rent, "October"\nflat 2' })]);
    expect(csv).toContain('"Rent, ""October""\nflat 2"');
  });

  it('writes text that starts like a formula as text, and figures as figures', () => {
    const csv = historyCsv([row({ note: '=HYPERLINK("x")', who: '@bob', total: '-0.4' })]);
    expect(csv).toContain(`'@bob`);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(',-0.4,');
  });

  it('writes a date by the local clock, to the minute', () => {
    expect(csvDate(new Date(2026, 9, 30, 1, 22, 59).getTime())).toBe('2026-10-30 01:22');
  });
});
