import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type VaultDb } from '../storage/db';
import type { WalletCore } from '../wallet/core';
import { ContactsService } from './contacts';

const core = {
  async isValidAddress(encoded: string, network: string) {
    return encoded.startsWith(network === 'regtest' ? 'nolgar1' : 'nolgam1') || encoded.startsWith('nechr1');
  },
} as unknown as WalletCore;

let db: VaultDb;
afterEach(() => db?.close());

describe('contacts', () => {
  it('adds, lists sorted, renames, removes, and rejects duplicates and bad addresses', async () => {
    db = await openVaultDb();
    const svc = new ContactsService(db, core, () => 'regtest');
    const b = await svc.add('acc', 'Bob', 'NOLGAR1BOBADDRESS');
    await svc.add('acc', 'alice', 'nechr1alice');
    expect(b.address).toBe('nolgar1bobaddress');
    expect(b.kind).toBe('Standard (Generation)');
    expect((await svc.list('acc')).map((c) => c.name)).toEqual(['alice', 'Bob']);
    await expect(svc.add('acc', 'Bob again', 'nolgar1bobaddress')).rejects.toThrow('already saved');
    await expect(svc.add('acc', 'Wrong net', 'nolgam1main')).rejects.toThrow('Not a valid address');
    await expect(svc.add('acc', '   ', 'nolgar1x')).rejects.toThrow('Enter a name');
    await svc.rename(b.key, 'Robert');
    expect((await svc.findByAddress('acc', 'nolgar1bobaddress'))?.name).toBe('Robert');
    await svc.remove(b.key);
    expect((await svc.list('acc')).length).toBe(1);
    expect((await svc.list('other')).length).toBe(0);
  });
});
