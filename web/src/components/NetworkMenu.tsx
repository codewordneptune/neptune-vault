// The network pill in the header: a menu listing the three networks, marking
// the ones that already have an account. Choosing one applies the same
// lock-and-switch as Settings.

import { Button, Group, Menu, Modal, Stack, Text } from '@mantine/core';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import type { Network } from '../storage/db';
import { NETWORK_LABELS } from '../util/network';

const NETWORKS: Network[] = ['main', 'testnet', 'regtest'];

export function NetworkMenu() {
  const { services, network, switchNetwork, account } = useApp();
  const [withAccount, setWithAccount] = useState<Set<Network>>(new Set());
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<Network | null>(null);

  const choose = (n: Network) => {
    if (n === network) return;
    // Leaving a network with an account hides that wallet until you return.
    if (account) setPending(n);
    else void switchNetwork(n);
  };

  // Which networks have an account; refreshed each time the menu opens, since
  // onboarding or an import may have added one.
  useEffect(() => {
    if (!opened) return;
    void services.db.getAll('accounts').then((all) => setWithAccount(new Set(all.map((a) => a.network))));
  }, [opened, services, account]);

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-end" width={200} radius="md" shadow="md">
      <Menu.Target>
        <button type="button" className="vault-network" aria-label={`Network: ${NETWORK_LABELS[network]}. Change network`}>
          {NETWORK_LABELS[network]}
          <IconChevronDown size={12} stroke={2.2} />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Network</Menu.Label>
        {NETWORKS.map((n) => (
          <Menu.Item
            key={n}
            onClick={() => choose(n)}
            leftSection={n === network ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
            rightSection={
              <span className="vault-network-hint">{withAccount.has(n) ? 'wallet' : 'no wallet'}</span>
            }
          >
            {NETWORK_LABELS[n]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
      <Modal opened={pending !== null} onClose={() => setPending(null)} title={pending ? `Switch to ${NETWORK_LABELS[pending]}?` : ''}>
        {pending && (
          <Stack>
            <Text size="sm">
              Your {NETWORK_LABELS[network]} wallet stays saved on this device; switch back any time. The app locks when switching.
            </Text>
            <Group grow>
              <Button variant="default" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const n = pending;
                  setPending(null);
                  void switchNetwork(n);
                }}
              >
                Switch
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Menu>
  );
}
