// Pick a saved recipient for the Send screen.

import { Button, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAddressBook } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress, addressKind } from '../util/address';

export function ContactPicker({ opened, onClose, onPick }: { opened: boolean; onClose: () => void; onPick: (c: ContactRecord) => void }) {
  const { services, account } = useApp();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);

  useEffect(() => {
    if (!opened || !account) return;
    setContacts(null);
    void services.contacts.list(account.id).then(setContacts);
  }, [opened, services, account]);

  return (
    <Modal opened={opened} onClose={onClose} title="Saved recipients">
      <Stack gap={0}>
        {contacts && contacts.length === 0 && (
          <Text size="sm" c="dimmed">
            No contacts yet. Save a recipient after you send, or add one in Contacts.
          </Text>
        )}
        {(contacts ?? []).map((c) => (
          <UnstyledButton key={c.key} className="vault-row vault-pick" onClick={() => onPick(c)}>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500}>
                {c.name}
              </Text>
              <Text fz="var(--v-fs-mono)" c="dimmed" ff="monospace">
                {abbreviateAddress(c.address)}
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              {addressKind(c.address).intent}
            </Text>
          </UnstyledButton>
        ))}
        <Button
          variant="subtle"
          mt="sm"
          leftSection={<IconAddressBook size={16} stroke={1.8} />}
          onClick={() => {
            onClose();
            navigate('/contacts');
          }}
        >
          Manage contacts
        </Button>
      </Stack>
    </Modal>
  );
}
