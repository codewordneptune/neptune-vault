// Pick a saved recipient for the Send screen.

import { Button, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Sheet } from './Sheet';
import { useApp } from '../app/AppContext';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress, addressKindNote } from '../util/address';

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
    <Sheet opened={opened} onClose={onClose} title="Contacts">
      <Stack gap={0}>
        {contacts && contacts.length === 0 && (
          <Text size="sm" c="dimmed">
            No contacts yet. Save a recipient after you send, or add one in Contacts.
          </Text>
        )}
        {(contacts ?? []).map((c) => (
          <UnstyledButton key={c.key} className="vault-row vault-pick" onClick={() => onPick(c)}>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={600}>
                <bdi>{c.name}</bdi>
              </Text>
              <Text fz="var(--v-fs-mono)" c="dimmed" ff="monospace">
                {abbreviateAddress(c.address)}
              </Text>
            </div>
            {/* The kind only when it is not Standard. */}
            {addressKindNote(c.address) && (
              <Text size="xs" c="dimmed">
                {addressKindNote(c.address)}
              </Text>
            )}
          </UnstyledButton>
        ))}
        <Button
          variant="subtle"
          mt="sm"
          leftSection={<IconUsers size={16} />}
          onClick={() => {
            onClose();
            // In place of the sheet's own history entry, so Back from Contacts returns to Send.
            navigate('/settings/contacts', { replace: true, state: { from: 'send' } });
          }}
        >
          Manage contacts
        </Button>
      </Stack>
    </Sheet>
  );
}
