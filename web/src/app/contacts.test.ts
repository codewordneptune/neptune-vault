import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { openVaultDb, type ContactRecord, type VaultDb } from '../storage/db';
import type { WalletChange, WalletCore, WalletPart } from '../backend/types';
import { ContactsService, distinctNames, nameKey } from './contacts';
import { EngineParts } from './engineParts';

const validity = {
  async isValidAddress(encoded: string, network: string) {
    return encoded.startsWith(network === 'regtest' ? 'nolgar1' : 'nolgam1') || encoded.startsWith('nechr1');
  },
};

/** A core whose store keeps contacts as the engine's log does: by wallet, by contact id. */
function coreWithStore() {
  const held = new Map<string, Map<string, ContactRecord>>();
  const of = (accountId: string) => held.get(accountId) ?? held.set(accountId, new Map()).get(accountId)!;
  return {
    ...validity,
    held,
    async storeOpen() {
      return ['contacts'] as WalletPart[];
    },
    async storeRead(accountId: string) {
      return [...of(accountId).values()];
    },
    async storeCommit(accountId: string, changes: WalletChange[]) {
      for (const change of changes) {
        if (change.op === 'putContact') of(accountId).set(change.contact.id, change.contact);
        else of(accountId).delete(change.id);
      }
    },
  };
}

let db: VaultDb;
afterEach(() => {
  db?.close();
  indexedDB.deleteDatabase('neptune-vault');
});

/** The service over the app's database, or over the engine with both test wallets open in it. */
async function service(place: 'database' | 'engine') {
  db = await openVaultDb();
  if (place === 'database') return { svc: new ContactsService(db, validity as unknown as WalletCore, () => 'regtest', new EngineParts(false)), core: null };
  const core = coreWithStore();
  const engine = new EngineParts(true);
  engine.opened('acc', ['contacts']);
  engine.opened('other', ['contacts']);
  return { svc: new ContactsService(db, core as unknown as WalletCore, () => 'regtest', engine), core };
}

describe.each(['database', 'engine'] as const)('contacts kept in the %s', (place) => {
  it('no two contacts of a wallet go by the same name, however it is typed', async () => {
    const { svc } = await service(place);
    const alice = await svc.add('acc', 'Alice', 'nolgar1alice');
    for (const same of ['Alice', 'alice', '  ALICE ', 'Aliｃe']) {
      await expect(svc.add('acc', same, 'nolgar1someoneelse'), JSON.stringify(same)).rejects.toThrow(/already have a contact called "Alice"/);
    }
    const bob = await svc.add('acc', 'Bob', 'nolgar1bob');
    await expect(svc.rename(bob.key, 'alice')).rejects.toThrow(/already have a contact called/);
    // A contact may keep its own name, or change only its spelling.
    await svc.rename(alice.key, 'ALICE');
    // Another wallet's contacts are another matter.
    await svc.add('other', 'Alice', 'nolgar1alice2');
  });

  it('adds, lists sorted, renames, removes, and rejects duplicates and bad addresses', async () => {
    const { svc } = await service(place);
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

describe('where contacts are kept', () => {
  it('a wallet whose contacts moved to the engine leaves nothing new in the database', async () => {
    const { svc, core } = await service('engine');
    await svc.add('acc', 'Alice', 'nolgar1alice');
    expect(await db.getAllFromIndex('contacts', 'byAccount', 'acc')).toEqual([]);
    expect(core!.held.get('acc')!.size).toBe(1);
  });

  it('never falls back to the rows a moved wallet left behind: a locked wallet is an error', async () => {
    db = await openVaultDb();
    const stale: ContactRecord = { key: 'acc:1', id: '1', accountId: 'acc', name: 'Stale', address: 'nolgar1stale', kind: 'Standard (Generation)', createdAt: 1, updatedAt: 1 };
    await db.put('contacts', stale);
    // The core has a store, and this wallet's log is not open.
    const svc = new ContactsService(db, coreWithStore() as unknown as WalletCore, () => 'regtest', new EngineParts(true));
    await expect(svc.list('acc')).rejects.toThrow('wallet is locked');
    await expect(svc.add('acc', 'New', 'nolgar1new')).rejects.toThrow('wallet is locked');
  });

  it('stays with the database for a wallet whose contacts would not move, and says why', async () => {
    db = await openVaultDb();
    const engine = new EngineParts(true);
    engine.opened('acc', []);
    engine.stays('acc', 'contacts', 'contact acc:9 is not in a shape this build knows');
    const svc = new ContactsService(db, coreWithStore() as unknown as WalletCore, () => 'regtest', engine);
    await svc.add('acc', 'Alice', 'nolgar1alice');
    expect((await db.getAllFromIndex('contacts', 'byAccount', 'acc')).length).toBe(1);
    expect(engine.problems('acc')).toEqual(['contacts: contact acc:9 is not in a shape this build knows']);
  });
});

describe('contact names', () => {
  it('gives namesakes from an older backup file distinct names, and drops none', () => {
    const out = distinctNames([{ name: 'Alice', address: 'a1' }, { name: 'alice', address: 'a2' }, { name: 'Bob', address: 'b' }, { name: 'Alice', address: 'a3' }]);
    expect(out.map((c) => c.name)).toEqual(['Alice', 'alice (2)', 'Bob', 'Alice (3)']);
    expect(new Set(out.map((c) => nameKey(c.name))).size).toBe(4);
  });
});
