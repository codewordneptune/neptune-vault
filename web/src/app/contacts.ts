// Saved recipients (contacts): a name for an address, per account. Addresses
// are validated for the account's network on entry, and stored in full so a
// contact can be pasted into Send without any lookup.

import type { ContactRecord, VaultDb } from '../storage/db';
import { addressKindLabel } from '../util/address';
import type { WalletCore } from '../wallet/core';

/**
 * What makes two contact names the same name. A contact is picked by its
 * name and paid at its address, so two that read alike are a way to pay the
 * wrong one: "Alice" and "alice ", or a name spelt with look-alike
 * compatibility characters. Case, surrounding and repeated spaces, and
 * Unicode compatibility forms are ignored when comparing.
 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Names for contacts arriving together, from a backup file, so that no two
 * are the same: a later namesake gets " (2)", " (3)". Older versions
 * allowed namesakes, and a restore must not drop an address for it.
 */
export function distinctNames<T extends { name: string }>(contacts: T[]): T[] {
  const taken = new Set<string>();
  return contacts.map((c) => {
    let name = c.name;
    for (let n = 2; taken.has(nameKey(name)); n++) name = `${c.name} (${n})`;
    taken.add(nameKey(name));
    return { ...c, name };
  });
}

export class ContactsService {
  constructor(
    private readonly db: VaultDb,
    private readonly core: WalletCore,
    /** The wallet core's spelling of the current network. */
    private readonly networkName: () => string,
  ) {}

  async list(accountId: string): Promise<ContactRecord[]> {
    const rows = await this.db.getAllFromIndex('contacts', 'byAccount', accountId);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Another contact of this wallet that already goes by `name`, if any. */
  private async findByName(accountId: string, name: string, exceptKey?: string): Promise<ContactRecord | undefined> {
    const wanted = nameKey(name);
    return (await this.list(accountId)).find((c) => c.key !== exceptKey && nameKey(c.name) === wanted);
  }

  async findByAddress(accountId: string, address: string): Promise<ContactRecord | undefined> {
    const wanted = address.trim().toLowerCase();
    return (await this.list(accountId)).find((c) => c.address === wanted);
  }

  async add(accountId: string, name: string, address: string): Promise<ContactRecord> {
    const cleanName = name.trim();
    const cleanAddress = address.trim().toLowerCase();
    if (!cleanName) throw new Error('Enter a name');
    if (!(await this.core.isValidAddress(cleanAddress, this.networkName()))) throw new Error('Not a valid address for this network');
    if (await this.findByAddress(accountId, cleanAddress)) throw new Error('This address is already saved');
    const namesake = await this.findByName(accountId, cleanName);
    if (namesake) throw new Error(`You already have a contact called "${namesake.name}". Give this one another name.`);
    const id = crypto.randomUUID();
    const now = Date.now();
    const record: ContactRecord = {
      key: `${accountId}:${id}`,
      id,
      accountId,
      name: cleanName,
      address: cleanAddress,
      kind: addressKindLabel(cleanAddress),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.put('contacts', record);
    return record;
  }

  async rename(key: string, name: string): Promise<void> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Enter a name');
    const record = await this.db.get('contacts', key);
    if (!record) throw new Error('contact not found');
    const namesake = await this.findByName(record.accountId, cleanName, key);
    if (namesake) throw new Error(`You already have a contact called "${namesake.name}". Give this one another name.`);
    await this.db.put('contacts', { ...record, name: cleanName, updatedAt: Date.now() });
  }

  async remove(key: string): Promise<void> {
    await this.db.delete('contacts', key);
  }

  /** Restore contacts from a backup file; duplicates by address are skipped. */
  async restore(accountId: string, contacts: { name: string; address: string }[]): Promise<number> {
    let added = 0;
    for (const c of contacts) {
      try {
        await this.add(accountId, c.name, c.address);
        added++;
      } catch {
        // Invalid for this network or already present: skip, keep the rest.
      }
    }
    return added;
  }
}
