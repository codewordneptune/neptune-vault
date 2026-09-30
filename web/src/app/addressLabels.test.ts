import { describe, expect, it } from 'vitest';

import { addressKey, cleanLabel, coinAddressKey, givenFromFile, labelsFromFile, ADDRESS_LABEL_MAX } from './addressLabels';

describe('who each address was given to', () => {
  it('keeps a label clean and short', () => {
    expect(cleanLabel(`  the market ${String.fromCharCode(0x202e)}stall `)).toBe('the market stall');
    expect(cleanLabel('x'.repeat(200))).toHaveLength(ADDRESS_LABEL_MAX);
  });

  it('knows an address by its kind and number, as its coins do', () => {
    expect(addressKey('ec_hybrid', 3)).toBe('ec_hybrid:3');
    expect(coinAddressKey({ key_kind: 'viewing', key_index: 2 })).toBe('viewing:2');
    expect(coinAddressKey({ key_index: 0 })).toBe('generation:0');
    expect(coinAddressKey(undefined)).toBeNull();
  });

  it('takes from a backup file only well-formed keys and clean text', () => {
    expect(labelsFromFile({ 'generation:1': ' Alice ', 'ec_hybrid:2': 'Bob', 'other:1': 'x', 'generation:': 'y', 'viewing:3': 42 })).toEqual({ 'generation:1': 'Alice', 'ec_hybrid:2': 'Bob' });
    expect(labelsFromFile(null)).toEqual({});
    expect(labelsFromFile('labels')).toEqual({});
  });

  it('takes the addresses given out from a backup file by well-formed keys only', () => {
    expect([...givenFromFile(['generation:3', 'ec_hybrid:1', 'other:2', 'viewing:', 7, 'generation:3'])].sort()).toEqual(['ec_hybrid:1', 'generation:3']);
    expect(givenFromFile(undefined).size).toBe(0);
    expect(givenFromFile({ 'generation:1': true }).size).toBe(0);
  });
});
