// Contacts: saved recipients for this account. Add by paste or scan, rename,
// delete, and start a send to one.

import { ActionIcon, Alert, Badge, Button, Group, Menu, Modal, Paper, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconChevronLeft, IconDotsVertical, IconPencil, IconScan, IconSend, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { QrScanner } from '../components/QrScanner';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress, addressKindLabel, parsePaymentText } from '../util/address';
import { networkLabel } from '../util/network';

export function Contacts() {
  const { services, account } = useApp();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ContactRecord | null>(null);
  const [removing, setRemoving] = useState<ContactRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    setContacts(await services.contacts.list(account.id));
  }, [services, account]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    try {
      await services.contacts.remove(removing.key);
    } catch (e) {
      setError((e as Error).message);
    }
    setRemoving(null);
    await load();
  };

  return (
    <Stack gap="md">
      <Paper>
        <Stack>
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center" wrap="nowrap">
              <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Back" onClick={() => navigate(-1)}>
                <IconChevronLeft size={22} stroke={1.8} />
              </ActionIcon>
              <Title order={2}>Contacts</Title>
            </Group>
            <Button size="compact-md" variant="light" className="vault-tap" leftSection={<IconUserPlus size={16} stroke={1.8} />} onClick={() => setAdding(true)}>
              Add
            </Button>
          </Group>
          {error && <Alert color="red" withCloseButton onClose={() => setError(null)}>{error}</Alert>}
          {contacts === null ? null : contacts.length === 0 ? (
            <Text size="sm" c="dimmed">
              No saved recipients yet. Add one here, or save a recipient after sending. Contacts are also offered when you choose a recipient on Send.
            </Text>
          ) : (
            <div>
              {contacts.map((c) => (
                <div className="vault-row" key={c.key}>
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500} className="vault-row-title">
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {abbreviateAddress(c.address)}
                    </Text>
                    <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                      {addressKindLabel(c.address)}
                    </Badge>
                  </div>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Send to this contact">
                      <ActionIcon variant="light" size="lg" className="vault-tap" aria-label={`Send to ${c.name}`} onClick={() => navigate('/send', { state: { recipient: c.address } })}>
                        <IconSend size={18} stroke={1.8} />
                      </ActionIcon>
                    </Tooltip>
                    <Menu position="bottom-end">
                      <Menu.Target>
                        <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label={`More for ${c.name}`}>
                          <IconDotsVertical size={18} stroke={1.8} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setRenaming(c)}>
                          Rename
                        </Menu.Item>
                        <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={() => setRemoving(c)}>
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </div>
              ))}
            </div>
          )}
        </Stack>
      </Paper>

      <ContactForm
        opened={adding}
        onClose={() => setAdding(false)}
        onSave={async (name, address) => {
          if (!account) return;
          await services.contacts.add(account.id, name, address);
          setAdding(false);
          await load();
        }}
      />

      <Modal opened={renaming !== null} onClose={() => setRenaming(null)} title="Rename contact">
        {renaming && (
          <RenameForm
            initial={renaming.name}
            onSave={async (name) => {
              await services.contacts.rename(renaming.key, name);
              setRenaming(null);
              await load();
            }}
          />
        )}
      </Modal>

      <Modal opened={removing !== null} onClose={() => setRemoving(null)} title="Delete contact">
        <Stack>
          <Text size="sm">
            Delete {removing?.name}? The address is not affected; only the saved name is removed.
          </Text>
          <Group grow>
            <Button variant="default" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button color="red" onClick={() => void remove()}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** Add-contact dialog; also used from the Send screen to save a recipient. */
export function ContactForm({
  opened,
  onClose,
  onSave,
  fixedAddress,
}: {
  opened: boolean;
  onClose: () => void;
  onSave: (name: string, address: string) => Promise<void>;
  /** When set, the address is given and only a name is asked for. */
  fixedAddress?: string;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState(fixedAddress ?? '');
  const [error, setError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const { services } = useApp();

  useEffect(() => {
    if (opened) {
      setName('');
      setAddress(fixedAddress ?? '');
      setError(null);
      setAddressError(null);
    }
  }, [opened, fixedAddress]);

  // Same check as the Send screen: required, valid for the current network.
  const checkAddress = async (): Promise<boolean> => {
    const text = address.trim();
    if (text === '') {
      setAddressError('Enter the address');
      return false;
    }
    const ok = await services.core.isValidAddress(text, services.networkName());
    setAddressError(ok ? null : `Not a valid ${networkLabel(services.settings.network)} address`);
    return ok;
  };

  const save = async () => {
    if (!fixedAddress && !(await checkAddress())) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name, address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={fixedAddress ? 'Save recipient' : 'Add contact'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
          {fixedAddress ? (
            <Text size="xs" c="dimmed" ff="monospace">
              {abbreviateAddress(fixedAddress)}
            </Text>
          ) : (
            <TextInput
              label="Address"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              value={address}
              onChange={(e) => {
                setAddress(e.currentTarget.value);
                setAddressError(null);
              }}
              onBlur={() => void checkAddress()}
              error={addressError}
              rightSectionWidth={44}
              rightSection={
                <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Scan a QR code" onClick={() => setScanning(true)}>
                  <IconScan size={18} stroke={1.8} />
                </ActionIcon>
              }
            />
          )}
          <Group grow>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim() || !address.trim() || addressError !== null}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
      <QrScanner
        opened={scanning}
        onClose={() => setScanning(false)}
        onResult={(text) => {
          setScanning(false);
          const parsed = parsePaymentText(text);
          if (parsed.error) setAddressError(parsed.error);
          else setAddress(parsed.address);
        }}
      />
    </Modal>
  );
}

function RenameForm({ initial, onSave }: { initial: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name).catch((err: Error) => setError(err.message));
      }}
    >
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Button type="submit" disabled={!name.trim()}>
          Save
        </Button>
      </Stack>
    </form>
  );
}
