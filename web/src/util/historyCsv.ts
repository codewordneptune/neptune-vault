// History as a spreadsheet (CSV), for bookkeeping: one row per payment as
// History lists it. RFC 4180 quoting, CRLF line ends, and a byte order mark
// so that spreadsheet apps read names and notes in UTF-8. A text cell that
// starts like a formula (=, +, -, @) is written with a leading apostrophe:
// a note or a name is the person's own text, and a spreadsheet must show it,
// never run it. Figures are written as plain numbers.

export interface CsvRow {
  /** When, as the person's clock shows it: YYYY-MM-DD HH:MM. */
  date: string;
  type: string;
  state: string;
  who: string;
  address: string;
  /** NPT, as plain decimal text; null where there is no figure. */
  amount: string | null;
  fee: string | null;
  /** What it did to the balance, negative for what left it. */
  total: string;
  block: number | null;
  note: string;
  transaction: string;
}

export const CSV_HEADER = ['Date', 'Type', 'State', 'To or from', 'Address', 'Amount (NPT)', 'Fee (NPT)', 'Total (NPT)', 'Block', 'Note', 'Transaction'];

function cell(value: string | number | null, figure = false): string {
  if (value === null) return '';
  let text = String(value);
  if (!figure && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function historyCsv(rows: CsvRow[]): string {
  const lines = [CSV_HEADER.map((h) => cell(h)).join(',')];
  for (const r of rows) {
    lines.push(
      [cell(r.date), cell(r.type), cell(r.state), cell(r.who), cell(r.address), cell(r.amount, true), cell(r.fee, true), cell(r.total, true), cell(r.block, true), cell(r.note), cell(r.transaction)].join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A local date and time as the CSV writes it. */
export function csvDate(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
