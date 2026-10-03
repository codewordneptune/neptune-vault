// The wallet pill in the header: names the open wallet, and its network
// when that is not Mainnet, and opens a menu of the wallets on this network,
// a way to add one, a way to lock, and, for developers and testers, the
// networks (offeredNetworks). Choosing a network locks this wallet and shows
// that network's; choosing a wallet locks and opens that wallet.

import { Button, Group, Menu, Modal, Stack, Text } from '@mantine/core';
import { IconCheck, IconChevronDown, IconLock, IconPlus, IconWallet } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '../app/AppContext';
import { byCreation, offeredNetworks, walletName, type AccountRecord, type Network } from '../storage/db';
import { NETWORK_LABELS } from '../util/network';

export function NetworkMenu() {
  const { services, network, switchNetwork, switchAccount, account, locked, sendJob } = useApp();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<Network | null>(null);
  // The menu item that opened the dialog is gone when it closes: focus goes back to the pill.
  const pillRef = useRef<HTMLButtonElement>(null);
  const cancelSwitch = () => {
    setPending(null);
    setTimeout(() => pillRef.current?.focus(), 0);
  };
  const sending = Boolean(sendJob && !sendJob.done);
  const onThisNetwork = accounts.filter((a) => a.network === network);
  const countOn = (n: Network) => accounts.filter((a) => a.network === n).length;
  // Testnet and Regtest once asked for in Settings; without that, only one a
  // wallet is on, so the wallet stays reachable (new wallets go on Mainnet).
  const networks = offeredNetworks({ developerNetworks: services.settings.developerNetworks, network }, accounts);
  const testNets = networks.length > 1;
  // Mainnet goes without saying; a test network is always named, in its own colour.
  const named = network !== 'main' || !account;
  const hint = (n: Network) => (countOn(n) === 0 ? 'no wallet' : countOn(n) === 1 ? '1 wallet' : countOn(n) + ' wallets');

  const choose = (n: Network) => {
    if (n === network) return;
    // Leaving a network with an account hides that wallet until you return.
    if (account) setPending(n);
    else void switchNetwork(n);
  };

  // The wallets on this device; refreshed each time the menu opens and when
  // the current one changes, since onboarding or an import may have added one.
  useEffect(() => {
    void services.db.getAll('accounts').then((all) => setAccounts(byCreation(all)));
  }, [opened, services, account]);

  return (
    <Menu opened={opened} onChange={setOpened} position="bottom-end" width={220}>
      <Menu.Target>
        {/* The wallet is what the pill is about; the network qualifies it,
            and is named when it is a test network (or there is no wallet). */}
        <button
          ref={pillRef}
          type="button"
          className="vault-network"
          aria-label={`${account ? walletName(account) : ''}${account && named ? ' on ' : ''}${named ? NETWORK_LABELS[network] : ''}. ${testNets ? 'Change wallet or network' : 'Change wallet'}`}
        >
          {account && (
            <>
              <IconWallet size={16} aria-hidden />
              <span className="vault-network-wallet">
                <bdi>{walletName(account)}</bdi>
              </span>
            </>
          )}
          {named && <span className={[account ? 'vault-network-net' : '', network !== 'main' ? 'vault-test-network' : ''].join(' ').trim() || undefined}>{NETWORK_LABELS[network]}</span>}
          <IconChevronDown size={16} />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        {account && (
          <>
            <Menu.Label>{testNets ? `Wallets on ${NETWORK_LABELS[network]}` : 'Wallets'}</Menu.Label>
            {onThisNetwork.map((a) => (
              <Menu.Item
                key={a.id}
                disabled={sending}
                onClick={() => {
                  if (a.id !== account?.id) void switchAccount(a.id);
                }}
                leftSection={a.id === account?.id ? <IconCheck size={16} /> : <span style={{ width: 14 }} />}
              >
                <bdi>{walletName(a)}</bdi>
              </Menu.Item>
            ))}
            <Menu.Item disabled={sending} leftSection={<IconPlus size={16} />} onClick={() => navigate('/onboarding?add=1')}>
              Add a wallet
            </Menu.Item>
            {/* Stepping away is the commonest reason to lock, so it is one tap from
                any screen; Settings keeps its Lock wallet too. Not during a send,
                whose proof a lock would cut short. */}
            {!locked && (
              <Menu.Item disabled={sending} leftSection={<IconLock size={16} />} onClick={() => void services.accounts.lock()}>
                Lock wallet
              </Menu.Item>
            )}
            {testNets && <Menu.Divider />}
          </>
        )}
        {testNets && <Menu.Label>Network</Menu.Label>}
        {testNets &&
          networks.map((n) => (
            <Menu.Item
              key={n}
              onClick={() => choose(n)}
              disabled={sending}
              leftSection={n === network ? <IconCheck size={16} /> : <span style={{ width: 14 }} />}
              rightSection={<span className="vault-network-hint">{hint(n)}</span>}
            >
              {NETWORK_LABELS[n]}
            </Menu.Item>
          ))}
      </Menu.Dropdown>
      <Modal opened={pending !== null} onClose={cancelSwitch} returnFocus={false} title={pending ? `Switch to ${NETWORK_LABELS[pending]}?` : ''}>
        {pending && (
          <Stack>
            <Text size="sm">
              Your {NETWORK_LABELS[network]} wallet stays on this device, so you can switch back any time. Switching locks this wallet.
            </Text>
            <Group grow>
              <Button variant="default" onClick={cancelSwitch}>
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
