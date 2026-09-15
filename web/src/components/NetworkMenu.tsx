// The network pill in the header: a menu listing the three networks, the
// wallets on the current one when there are several, and a way to add one.
// Choosing a network applies the same lock-and-switch as Settings; choosing
// a wallet locks and opens that wallet.

import { Button, Group, Menu, Modal, Stack, Text } from '@mantine/core';
import { IconCheck, IconChevronDown, IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { walletName, type AccountRecord, type Network } from '../storage/db';
import { NETWORK_LABELS } from '../util/network';

const NETWORKS: Network[] = ['main', 'testnet', 'regtest'];

export function NetworkMenu() {
  const { services, network, switchNetwork, switchAccount, account, sendJob } = useApp();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<Network | null>(null);
  const sending = Boolean(sendJob && !sendJob.done);
  const onThisNetwork = accounts.filter((a) => a.network === network);
  const several = onThisNetwork.length > 1;
  const countOn = (n: Network) => accounts.filter((a) => a.network === n).length;
  const hint = (n: Network) => (countOn(n) === 0 ? 'no wallet' : countOn(n) === 1 ? 'wallet' : countOn(n) + ' wallets');

  const choose = (n: Network) => {
    if (n === network) return;
    // Leaving a network with an account hides that wallet until you return.
    if (account) setPending(n);
    else void switchNetwork(n);
  };

  // The wallets on this device; refreshed each time the menu opens and when
  // the current one changes, since onboarding or an import may have added one.
  useEffect(() => {
    void services.db.getAll('accounts').then(setAccounts);
  }, [opened, services, account]);

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-end" width={200} radius="md" shadow="md">
      <Menu.Target>
        <button type="button" className="vault-network" aria-label={`Network: ${NETWORK_LABELS[network]}${several && account ? ', ' + walletName(account) : ''}. Change network or wallet`}>
          {NETWORK_LABELS[network]}
          {several && account ? ' · ' + walletName(account) : ''}
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
            rightSection={<span className="vault-network-hint">{hint(n)}</span>}
          >
            {NETWORK_LABELS[n]}
          </Menu.Item>
        ))}
        {several && (
          <>
            <Menu.Label>Wallets on {NETWORK_LABELS[network]}</Menu.Label>
            {onThisNetwork.map((a) => (
              <Menu.Item
                key={a.id}
                disabled={sending}
                onClick={() => {
                  if (a.id !== account?.id) void switchAccount(a.id);
                }}
                leftSection={a.id === account?.id ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
              >
                {walletName(a)}
              </Menu.Item>
            ))}
          </>
        )}
        {account && (
          <>
            <Menu.Divider />
            <Menu.Item disabled={sending} leftSection={<IconPlus size={14} />} onClick={() => navigate('/onboarding?add=1')}>
              Add a wallet
            </Menu.Item>
          </>
        )}
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
