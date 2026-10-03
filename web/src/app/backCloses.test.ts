import { describe, expect, it } from 'vitest';

import { sheetHistory, type HistoryLike } from './backCloses';

// A session history as a browser keeps one: a list of entries and the
// current one, pushState dropping what was ahead, and go() raising popstate.
class FakeHistory implements HistoryLike {
  entries: unknown[] = [{ key: 'send' }];
  at = 0;
  onPop: () => void = () => undefined;
  get state(): unknown {
    return this.entries[this.at];
  }
  pushState(data: unknown): void {
    this.entries = this.entries.slice(0, this.at + 1);
    this.entries.push(data);
    this.at += 1;
  }
  replaceState(data: unknown): void {
    this.entries[this.at] = data;
  }
  go(delta: number): void {
    this.at = Math.max(0, Math.min(this.entries.length - 1, this.at + delta));
    this.onPop();
  }
}

const setup = () => {
  const history = new FakeHistory();
  const sheets = sheetHistory(history);
  history.onPop = () => sheets.popped();
  return { history, sheets };
};
const keyOf = (state: unknown) => (state as { key: string }).key;

describe('Back and sheets', () => {
  it('Back closes the open sheet and stays on the screen', () => {
    const { history, sheets } = setup();
    let closed = 0;
    sheets.open(() => (closed += 1));
    expect(history.entries).toHaveLength(2);
    expect(keyOf(history.state)).toBe('send');
    history.go(-1);
    expect(closed).toBe(1);
    expect(history.at).toBe(0);
  });

  it('a sheet closed some other way takes its entry out, and that step closes nothing', () => {
    const { history, sheets } = setup();
    let closed = 0;
    const id = sheets.open(() => (closed += 1));
    sheets.release(id);
    expect(history.at).toBe(0);
    expect(closed).toBe(0);
  });

  it('a sheet Back closed takes nothing more out when it goes', () => {
    const { history, sheets } = setup();
    const id = sheets.open(() => undefined);
    history.go(-1);
    sheets.release(id);
    expect(history.at).toBe(0);
  });

  it('Back closes only the sheet on top', () => {
    const { history, sheets } = setup();
    const closed: string[] = [];
    sheets.open(() => closed.push('outer'));
    sheets.open(() => closed.push('inner'));
    history.go(-1);
    expect(closed).toEqual(['inner']);
    history.go(-1);
    expect(closed).toEqual(['inner', 'outer']);
  });

  it('a sheet under another takes both entries out when it closes first', () => {
    const { history, sheets } = setup();
    const outer = sheets.open(() => undefined);
    const inner = sheets.open(() => undefined);
    sheets.release(outer);
    expect(history.at).toBe(0);
    sheets.release(inner);
    expect(history.at).toBe(0);
  });

  it('leaves an entry a navigation from the sheet replaced', () => {
    const { history, sheets } = setup();
    const id = sheets.open(() => undefined);
    history.replaceState({ key: 'contacts' });
    sheets.release(id);
    expect(history.at).toBe(1);
    expect(keyOf(history.state)).toBe('contacts');
  });

  it('steps back over an entry a reload left with no sheet open', () => {
    const { history, sheets } = setup();
    sheets.open(() => undefined);
    const reloaded = sheetHistory(history);
    history.onPop = () => reloaded.popped();
    reloaded.tidy();
    expect(history.at).toBe(0);
  });
});
