import { describe, expect, it } from 'vitest';
import type { HistoryRecord, SendDetails } from '../storage/db';
import { groupHistory } from '../util/history';
import { MAX_PAYMENTS, SEND_NOTE_MAX } from './send';
import { sendDetailsForFile, sendDetailsFromFile, withSendDetails } from './sendDetails';

const row = (over: Partial<HistoryRecord>): HistoryRecord => ({
  key: 'w:sent:t1',
  accountId: 'w',
  kind: 'sent',
  status: 'confirmed',
  txid: 'ab01',
  amountNau: '5',
  feeNau: '1',
  timestampMs: 1,
  height: 9,
  inputHashes: ['c0ffee:3'],
  recipient: 'nolgar1bob',
  payments: [{ recipient: 'nolgar1bob', amountNau: '5' }],
  error: null,
  ...over,
});

// A send as a restore finds it: one row for the block, no id, no recipient, the fee inside the amount.
const found = (over: Partial<HistoryRecord> = {}): HistoryRecord =>
  row({ key: 'w:spent:9', txid: '', amountNau: '6', feeNau: null, recipient: null, payments: undefined, changeNau: '4', ...over });

describe("a backup file's sends", () => {
  it('takes each send built here that went out or still may, and each one a file brought, once', () => {
    const brought: SendDetails = { inputs: ['beef:1'], txid: 'ab09', payments: [{ recipient: 'nolgar1carol', amountNau: '2' }], feeNau: '1' };
    const out = sendDetailsForFile(
      [
        row({ note: 'Rent', outputs: [{ commitment: 'cc01', role: 'recipient' }] }),
        row({ key: 'w:sent:t2', txid: 'ab02', status: 'pending', inputHashes: ['d00d:4'], payments: undefined }),
        row({ key: 'w:sent:t3', txid: 'ab03', status: 'failed', inputHashes: ['e1:1'] }),
        row({ key: 'w:sent:t4', txid: 'ab04', givenUp: true, inputHashes: ['e2:1'] }),
        row({ key: 'w:sent:t5', txid: 'ab05', expired: true, inputHashes: ['e3:1'] }),
        found(),
        row({ key: 'w:recv:x', kind: 'received', recipient: null }),
      ],
      [brought, { ...brought, txid: 'ab0a' }],
    );
    expect(out).toEqual([
      { inputs: ['c0ffee:3'], txid: 'ab01', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], feeNau: '1', outputs: [{ commitment: 'cc01', role: 'recipient' }], note: 'Rent' },
      // A row from before several recipients: its one payment from the recipient and amount.
      { inputs: ['d00d:4'], txid: 'ab02', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], feeNau: '1' },
      brought,
    ]);
  });

  it('reads only well-formed sends from a file, and only what is well-formed in them', () => {
    expect(sendDetailsFromFile(undefined)).toEqual([]);
    expect(sendDetailsFromFile({ inputs: ['a:1'] })).toEqual([]);
    const many = Array.from({ length: MAX_PAYMENTS + 3 }, (_, i) => ({ recipient: `nolgar1r${i}`, amountNau: '1' }));
    const out = sendDetailsFromFile([
      { inputs: [], payments: [{ recipient: 'nolgar1bob', amountNau: '1' }] },
      { inputs: ['a:1'], payments: [] },
      {
        inputs: ['a:1', 'not a key', 7, 'b0'],
        txid: 'not hex',
        payments: [{ recipient: '  NOLGAR1BOB ', amountNau: '5' }, { recipient: 'nolgar1x', amountNau: '-1' }, { recipient: 9, amountNau: '1' }],
        feeNau: '1.5',
        outputs: [{ commitment: 'cc01', role: 'recipient' }, { commitment: 'cc02', role: 'other' }],
        note: 'x'.repeat(SEND_NOTE_MAX + 20),
      },
      { inputs: ['c:2'], txid: 'ab03', payments: many, feeNau: '2', note: '   ' },
    ]);
    expect(out).toEqual([
      { inputs: ['a:1', 'b0'], txid: '', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], feeNau: null, outputs: [{ commitment: 'cc01', role: 'recipient' }], note: 'x'.repeat(SEND_NOTE_MAX) },
      { inputs: ['c:2'], txid: 'ab03', payments: many.slice(0, MAX_PAYMENTS), feeNau: '2' },
    ]);
  });

  it('gives a send a restore found back its id, recipient, amounts, fee, coins and note, by the coins it spent', () => {
    const details: SendDetails[] = [{ inputs: ['c0ffee:3'], txid: 'ab01', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], feeNau: '1', outputs: [{ commitment: 'cc01', role: 'recipient' }], note: 'Rent' }];
    const elsewhere = found({ key: 'w:spent:10', height: 10, inputHashes: ['f00:7'] });
    const built = row({ key: 'w:sent:t9', txid: 'ab09', inputHashes: ['c0ffee:3'] });
    const [told, untouched, own] = withSendDetails([found(), elsewhere, built], details);
    expect(told).toMatchObject({ txid: 'ab01', recipient: 'nolgar1bob', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], amountNau: '5', feeNau: '1', changeNau: null, outputs: [{ commitment: 'cc01', role: 'recipient' }], note: 'Rent', key: 'w:spent:9', height: 9 });
    expect(untouched).toBe(elsewhere);
    expect(own).toBe(built);
    // What left the wallet reads as it did before: the amount and the fee.
    expect(groupHistory([told], [])[0].shownNau).toBe(groupHistory([found()], [])[0].shownNau);
  });

  it('tells both sends a block confirmed together, and finds a send recorded by coin hash alone', () => {
    const details: SendDetails[] = [
      { inputs: ['aa:1'], txid: 'ab01', payments: [{ recipient: 'nolgar1bob', amountNau: '5' }], feeNau: '1', note: 'Rent' },
      { inputs: ['bb'], txid: 'ab02', payments: [{ recipient: 'nolgar1carol', amountNau: '2' }], feeNau: '1', note: 'Tea' },
    ];
    const [told] = withSendDetails([found({ amountNau: '9', inputHashes: ['aa:1', 'bb:4'] })], details);
    expect(told).toMatchObject({ txid: 'ab01', recipient: 'nolgar1bob', amountNau: '7', feeNau: '2', note: 'Rent · Tea' });
    expect(told.payments).toHaveLength(2);
  });
});
