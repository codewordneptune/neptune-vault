import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type VaultDb } from '../storage/db';
import type { WalletCore } from '../backend/types';
import { ContactsService, distinctNames, nameKey } from './contacts';

const core = {
  async isValidAddress(encoded: string, network: string) {
    return encoded.startsWith(network === 'regtest' ? 'nolgar1' : 'nolgam1') || encoded.startsWith('nechr1');
  },
} as unknown as WalletCore;

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

describe('contact names', () => {
  it('no two contacts of a wallet go by the same name, however it is typed', async () => {
    db = await openVaultDb();
    const svc = new ContactsService(db, core, () => 'regtest');
    const alice = await svc.add('acc', 'Alice', 'nolgar1alice');
    for (const same of ['Alice', 'alice', '  ALICE ', 'Ali\uFF43e']) {
      await expect(svc.add('acc', same, 'nolgar1someoneelse'), JSON.stringify(same)).rejects.toThrow(/already have a contact called "Alice"/);
    }
    const bob = await svc.add('acc', 'Bob', 'nolgar1bob');
    await expect(svc.rename(bob.key, 'alice')).rejects.toThrow(/already have a contact called/);
    // A contact may keep its own name, or change only its spelling.
    await svc.rename(alice.key, 'ALICE');
    // Another wallet's contacts are another matter.
    await svc.add('other', 'Alice', 'nolgar1alice2');
  });

  it('gives namesakes from an older backup file distinct names, and drops none', () => {
    const out = distinctNames([{ name: 'Alice', address: 'a1' }, { name: 'alice', address: 'a2' }, { name: 'Bob', address: 'b' }, { name: 'Alice', address: 'a3' }]);
    expect(out.map((c) => c.name)).toEqual(['Alice', 'alice (2)', 'Bob', 'Alice (3)']);
    expect(new Set(out.map((c) => nameKey(c.name))).size).toBe(4);
  });
});

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
