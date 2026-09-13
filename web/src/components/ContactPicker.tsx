// Pick a saved recipient for the Send screen.

import { Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress } from '../util/address';

export function ContactPicker({ opened, onClose, onPick }: { opened: boolean; onClose: () => void; onPick: (c: ContactRecord) => void }) {
  const { services, account } = useApp();
  const [contacts, setContacts] = useState<ContactRecord[]>([]);

  useEffect(() => {
    if (!opened || !account) return;
    void services.contacts.list(account.id).then(setContacts);
  }, [opened, services, account]);

  return (
    <Modal opened={opened} onClose={onClose} title="Saved recipients">
      <Stack gap={0}>
        {contacts.length === 0 && (
          <Text size="sm" c="dimmed">
            No saved recipients yet. You can save one after sending, or on the Contacts tab.
          </Text>
        )}
        {contacts.map((c) => (
          <UnstyledButton key={c.key} className="vault-row vault-pick" onClick={() => onPick(c)}>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500}>
                {c.name}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {abbreviateAddress(c.address)}
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              {c.kind}
            </Text>
          </UnstyledButton>
        ))}
      </Stack>
    </Modal>
  );
}
