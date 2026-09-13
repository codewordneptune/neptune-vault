// Saved recipients (contacts): a name for an address, per account. Addresses
// are validated for the account's network on entry, and stored in full so a
// contact can be pasted into Send without any lookup.

import type { ContactRecord, VaultDb } from '../storage/db';
import { addressKindLabel } from '../util/address';
import type { WalletCore } from '../wallet/core';

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
