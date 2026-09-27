// Contacts: saved recipients for this account. Add by paste or scan, rename,
// remove, and start a send to one.

import { ActionIcon, Badge, Button, Group, Menu, Modal, Paper, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconArrowUpRight, IconChevronLeft, IconCopy, IconDotsVertical, IconPencil, IconPlus, IconScan, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { ownAddresses } from '../app/ownAddresses';
import { ErrorLine } from '../components/Notice';
import { QrScanner } from '../components/QrScanner';
import type { ContactRecord } from '../storage/db';
import { abbreviateAddress, addressKindLabel, parsePaymentText } from '../util/address';
import { copyText } from '../util/clipboard';
import { networkLabel } from '../util/network';

export function Contacts() {
  const { services, account } = useApp();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<ContactRecord[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ContactRecord | null>(null);
  const [removing, setRemoving] = useState<ContactRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // After a dialog opened from a row's menu closes, the menu is gone: focus
  // goes back to that row's button by hand, or after a removal to the next
  // row's, and what happened is said.
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [said, setSaid] = useState('');
  const refocus = (key: string | null) => {
    setTimeout(() => (key ? moreButtons.current.get(key) : null)?.focus() ?? headingRef.current?.focus(), 0);
  };

  const load = useCallback(async () => {
    if (!account) return;
    setContacts(await services.contacts.list(account.id));
  }, [services, account]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    const list = contacts ?? [];
    const at = list.findIndex((c) => c.key === removing.key);
    const next = list[at + 1] ?? list[at - 1] ?? null;
    try {
      await services.contacts.remove(removing.key);
      setSaid(`${removing.name} removed.`);
    } catch (e) {
      setError((e as Error).message);
    }
    setRemoving(null);
    await load();
    refocus(next?.key ?? null);
  };

  return (
    <Stack gap="md">
      <Paper>
        <Stack>
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center" wrap="nowrap">
              <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Back" onClick={() => navigate(-1)}>
                <IconChevronLeft size={20} stroke={1.8} />
              </ActionIcon>
              <Title order={2} tabIndex={-1} ref={headingRef}>
                Contacts
              </Title>
            </Group>
            <Button size="compact-md" variant="light" className="vault-tap" leftSection={<IconPlus size={16} stroke={1.8} />} onClick={() => setAdding(true)}>
              Add
            </Button>
          </Group>
          <div className="sr-only" role="status">
            {said}
          </div>
          {error && <ErrorLine onClose={() => setError(null)}>{error}</ErrorLine>}
          {contacts === null ? null : contacts.length === 0 ? (
            <Text size="sm" c="dimmed">
              No contacts yet. Add one here, or save a recipient after you send.
            </Text>
          ) : (
            <div>
              {contacts.map((c) => (
                <div className="vault-row" key={c.key}>
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600} className="vault-row-title">
                      <bdi>{c.name}</bdi>
                    </Text>
                    <Text fz="var(--v-fs-mono)" c="dimmed" ff="monospace">
                      {abbreviateAddress(c.address)}
                    </Text>
                    <Badge size="sm" variant="outline" color="gray" mt={6} className="vault-kind">
                      {addressKindLabel(c.address)}
                    </Badge>
                  </div>
                  <Group gap={4} wrap="nowrap">
                    {/* Stays while the pointer moves onto it, so it can be read. */}
                    <Tooltip label="Send to this contact" interactive>
                      <ActionIcon variant="light" size="lg" className="vault-tap" aria-label={`Send to ${c.name}`} onClick={() => navigate('/send', { state: { recipient: c.address } })}>
                        <IconArrowUpRight size={20} stroke={1.8} />
                      </ActionIcon>
                    </Tooltip>
                    <Menu position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          size="lg"
                          className="vault-tap"
                          aria-label={`More for ${c.name}`}
                          ref={(el: HTMLButtonElement | null) => {
                            if (el) moreButtons.current.set(c.key, el);
                            else moreButtons.current.delete(c.key);
                          }}
                        >
                          <IconDotsVertical size={20} stroke={1.8} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {/* The row shows the address shortened; this copies it whole, to hand on or paste into another wallet. */}
                        <Menu.Item leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(c.address, 'Address copied')}>
                          Copy address
                        </Menu.Item>
                        <Menu.Item leftSection={<IconPencil size={16} stroke={1.8} />} onClick={() => setRenaming(c)}>
                          Rename
                        </Menu.Item>
                        <Menu.Item leftSection={<IconTrash size={16} stroke={1.8} />} c="var(--v-danger-text)" onClick={() => setRemoving(c)}>
                          Remove
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

      <Modal
        opened={renaming !== null}
        onClose={() => {
          refocus(renaming?.key ?? null);
          setRenaming(null);
        }}
        title="Rename contact"
        returnFocus={false}
      >
        {renaming && (
          <RenameForm
            initial={renaming.name}
            onCancel={() => {
              refocus(renaming.key);
              setRenaming(null);
            }}
            onSave={async (name) => {
              await services.contacts.rename(renaming.key, name);
              setSaid('Contact renamed.');
              refocus(renaming.key);
              setRenaming(null);
              await load();
            }}
          />
        )}
      </Modal>

      <Modal
        opened={removing !== null}
        onClose={() => {
          refocus(removing?.key ?? null);
          setRemoving(null);
        }}
        title="Remove contact"
        returnFocus={false}
      >
        <Stack>
          <Text size="sm">
            Remove <bdi>{removing?.name}</bdi>? Only this saved contact is removed from this device. Past payments are not affected.
          </Text>
          <Group grow>
            <Button
              variant="default"
              onClick={() => {
                refocus(removing?.key ?? null);
                setRemoving(null);
              }}
            >
              Cancel
            </Button>
            <Button color="red" onClick={() => void remove()}>
              Remove
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
  // A name already taken is said at the name, like every other problem with a field.
  const [nameError, setNameError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const { services, account } = useApp();
  // Whether the address is one of this wallet's own: allowed, and said.
  const [own, setOwn] = useState(false);
  useEffect(() => {
    const text = address.trim().toLowerCase();
    if (!account || !text) {
      setOwn(false);
      return;
    }
    let live = true;
    void ownAddresses(services.core, account).then((set) => live && setOwn(set.has(text)), () => undefined);
    return () => {
      live = false;
    };
  }, [services, account, address]);

  useEffect(() => {
    if (opened) {
      setName('');
      setAddress(fixedAddress ?? '');
      setError(null);
      setAddressError(null);
      setNameError(null);
    }
  }, [opened, fixedAddress]);

  // Same check as the Send screen: required, valid for the current network.
  // A scan passes the address it filled in, since the state has not caught up yet.
  const checkAddress = async (value: string = address): Promise<boolean> => {
    const text = value.trim();
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
      const message = (e as Error).message;
      // Said at the field it is about; anything else under the buttons.
      if (/already have a contact called/.test(message)) setNameError(message);
      else if (/already saved/.test(message) && !fixedAddress) setAddressError(message);
      else setError(message);
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
          <TextInput
            label="Name"
            value={name}
            error={nameError}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setNameError(null);
            }}
            data-autofocus
          />
          {fixedAddress ? (
            <Text fz="var(--v-fs-mono)" c="dimmed" ff="monospace">
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
              description={own && !addressError ? 'This is one of your own addresses.' : undefined}
              rightSectionWidth={44}
              rightSection={
                <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Scan a QR code" onClick={() => setScanning(true)}>
                  <IconScan size={20} stroke={1.8} />
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
          {error && <ErrorLine>{error}</ErrorLine>}
        </Stack>
      </form>
      <QrScanner
        opened={scanning}
        onClose={() => setScanning(false)}
        onResult={(text) => {
          setScanning(false);
          const parsed = parsePaymentText(text);
          if (parsed.error) setAddressError(parsed.error);
          else {
            // Checked at once: an "Enter the address" left from before the scan would keep Save disabled.
            setAddress(parsed.address);
            void checkAddress(parsed.address);
          }
        }}
      />
    </Modal>
  );
}

function RenameForm({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name).catch((err: Error) => (/already have a contact called/.test(err.message) ? setNameError(err.message) : setError(err.message)));
      }}
    >
      <Stack>
        <TextInput
          label="Name"
          value={name}
          error={nameError}
          onChange={(e) => {
            setName(e.currentTarget.value);
            setNameError(null);
          }}
          data-autofocus
        />
        <Group grow>
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            Save
          </Button>
        </Group>
        {error && <ErrorLine>{error}</ErrorLine>}
      </Stack>
    </form>
  );
}
