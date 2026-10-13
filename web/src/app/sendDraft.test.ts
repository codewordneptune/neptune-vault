import { describe, expect, it } from 'vitest';

import { keepSendDraft, sendDraft, sendRecorded, type SendDraft } from './sendDraft';

const BOB = 'nolgam1bob';
const CAROL = 'nolgam1carol';

/** A filled form: the first recipient, then any more. */
function form(recipient: string, amount: string, more: [string, string][] = []): SendDraft {
  return {
    recipient,
    amount,
    extras: more.map(([r, a], i) => ({ id: i + 1, recipient: r, amount: a, recipientError: null, amountError: null })),
    feePreset: 'normal',
    fee: '0.02',
    linkMeta: null,
    note: '',
  };
}

// Each test has a wallet of its own, as drafts are kept per wallet for the session.
describe('the Send draft', () => {
  it('keeps a half-filled form for its wallet', () => {
    keepSendDraft('w1', form(BOB, '5'));
    expect(sendDraft('w1')).toEqual(form(BOB, '5'));
  });

  it('never keeps the form of a send that was recorded, however it is spaced or cased', () => {
    keepSendDraft('w2', form(BOB, '50'));
    sendRecorded('w2', [{ recipient: BOB, amount: '50' }]);
    expect(sendDraft('w2')).toBeUndefined();
    keepSendDraft('w2', form(` ${BOB.toUpperCase()} `, '50 '));
    expect(sendDraft('w2')).toBeUndefined();
  });

  it('keeps a form that pays someone else, or another amount', () => {
    sendRecorded('w3', [{ recipient: BOB, amount: '50' }]);
    keepSendDraft('w3', form(BOB, '5'));
    expect(sendDraft('w3')?.amount).toBe('5');
    keepSendDraft('w3', form(CAROL, '50'));
    expect(sendDraft('w3')?.recipient).toBe(CAROL);
  });

  it('keeps the form of a send that failed before it was recorded', () => {
    keepSendDraft('w4', form(BOB, '50'));
    expect(sendDraft('w4')).toEqual(form(BOB, '50'));
  });

  it('compares every recipient of a send to several', () => {
    sendRecorded('w5', [
      { recipient: BOB, amount: '50' },
      { recipient: CAROL, amount: '5' },
    ]);
    keepSendDraft('w5', form(BOB, '50', [[CAROL, '5']]));
    expect(sendDraft('w5')).toBeUndefined();
    keepSendDraft('w5', form(BOB, '50', [[CAROL, '6']]));
    expect(sendDraft('w5')?.extras[0].amount).toBe('6');
    keepSendDraft('w5', form(BOB, '50'));
    expect(sendDraft('w5')?.extras).toEqual([]);
  });

  it('remembers only the last recorded send', () => {
    sendRecorded('w6', [{ recipient: BOB, amount: '50' }]);
    sendRecorded('w6', [{ recipient: CAROL, amount: '5' }]);
    keepSendDraft('w6', form(BOB, '50'));
    expect(sendDraft('w6')?.recipient).toBe(BOB);
    keepSendDraft('w6', form(CAROL, '5'));
    expect(sendDraft('w6')).toBeUndefined();
  });

  it('does not let one wallet\'s send block another wallet\'s draft', () => {
    sendRecorded('w7', [{ recipient: BOB, amount: '50' }]);
    keepSendDraft('w8', form(BOB, '50'));
    expect(sendDraft('w8')).toEqual(form(BOB, '50'));
  });
});
