// Balance, sync status and history (F13, F14, R18).

import { ActionIcon, Alert, Button, Group, Modal, Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconArrowsExchange, IconChevronDown, IconClockPause, IconCopy, IconEye, IconEyeOff, IconLock, IconRefresh, IconShieldCheck, IconWifiOff } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { showBlock, showNau, useApp } from '../app/AppContext';
import type { StoredUtxo } from '../backend/types';
import type { ContactRecord, HistoryRecord } from '../storage/db';
import { InstallNudge } from '../components/InstallNudge';
import { PocNotice } from '../components/PocNotice';
import { abbreviateAddress } from '../util/address';
import { copyText } from '../util/clipboard';
import { coinKeyOfReceipt, groupHistory, type HistoryEntry } from '../util/history';
import { formatWhen } from '../util/time';

export function Home() {
  const { balance, sync, history, utxos, syncNow, lastSyncedAt, online, services, refresh, account, sendJob, dismissSendJob, loaded } = useApp();
  // A send that failed while the person was elsewhere is easy to miss as a
  // toast; it stays here until dismissed, and survives a reload.
  const [failure, setFailure] = useState(services.settings.lastSendFailure);
  useEffect(() => {
    setFailure(services.settings.lastSendFailure);
  }, [services, sendJob?.done, sendJob?.error]);
  const dismissFailure = () => {
    setFailure(undefined);
    dismissSendJob();
  };
  // Masked amounts for reading the app in public; remembered across visits.
  const [hidden, setHidden] = useState<boolean>(services.settings.hideBalance ?? false);
  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    void services.updateSettings({ hideBalance: next });
  };
  const amount = (nau: bigint) => (hidden ? '••••' : showNau(nau));
  // Re-render every 30 s so "2 min ago" stays right.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  };
  const navigate = useNavigate();

  // Reminder until an export file exists; a dismissal snoozes it for a week.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const showBackupNudge =
    Boolean(account) && !account?.lastBackupAt && !(account?.backupNudgeDismissedAt && Date.now() - account.backupNudgeDismissedAt < WEEK_MS);
  const dismissNudge = async () => {
    if (!account) return;
    await services.accounts.dismissBackupNudge(account.id);
    await refresh();
  };

  // One entry per transaction, with the recipient named when it is a contact.
  const entries = groupHistory(history, utxos);
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  useEffect(() => {
    if (!account) return;
    void services.contacts.list(account.id).then(setContacts);
  }, [services, account, history.length]);
  const contactFor = (address: string | null) => (address ? contacts.find((c) => c.address === address) : undefined);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [why, setWhy] = useState(false);
  // The sheet's technical rows are folded until asked for, and fold again for the next entry.
  const [tech, setTech] = useState(false);
  useEffect(() => setTech(false), [detail]);
  const PAGE = 50;
  const [shown, setShown] = useState(PAGE);

  // Giving up on a pending send frees its reserved coins; confirmed first.
  const [givingUp, setGivingUp] = useState<HistoryRecord | null>(null);
  const giveUp = async () => {
    if (!account || !givingUp) return;
    await services.sendService(account.id).forget(givingUp.txid);
    setGivingUp(null);
    await refresh();
  };
  // Exactly what is held: the inputs reserved for that transaction.
  const reservedFor = (h: HistoryRecord) => utxos.filter((u) => u.pendingTxid === h.txid).reduce((sum, u) => sum + BigInt(u.amountNau), 0n);

  // What the balance becomes once every pending send is included: the held
  // coins minus what leaves in those sends (amount plus fee) comes back.
  const pendingSends = history.filter((h) => h.kind === 'sent' && h.status === 'pending');
  const leavingNau = pendingSends.reduce((sum, h) => sum + BigInt(h.amountNau) + BigInt(h.feeNau ?? '0'), 0n);
  const afterPendingNau = balance.spendableNau + balance.reservedNau - leavingNau;

  // A receipt's time lock, from the row or, for rows written before it was
  // kept there, from the coin. Null once the date has passed.
  const lockOf = (h: HistoryRecord): number | null => {
    if (h.kind !== 'received') return null;
    const date = h.releaseDateMs ?? utxos.find((u) => u.hash === coinKeyOfReceipt(h))?.releaseDateMs ?? null;
    return date !== null && date > Date.now() ? date : null;
  };
  const showDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  const busy = sync?.phase === 'checking' || sync?.phase === 'restoring' || sync?.phase === 'scanning';
  const syncText =
    sync === null
      ? 'Not synced yet'
      : sync.phase === 'checking'
        ? 'Checking the chain'
        : sync.phase === 'restoring'
          ? (sync.message ?? 'Fast restore')
          : sync.phase === 'scanning'
          ? `Scanning block ${showBlock(sync.syncedHeight)} of ${showBlock(sync.tipHeight)}`
          : sync.phase === 'done'
            ? `Up to date · block ${showBlock(sync.syncedHeight)}${lastSyncedAt ? ` · ${ago(lastSyncedAt)}` : ''}`
            : sync.message ?? 'Sync failed';

  const incomingNau = history.filter((h) => h.kind === 'received' && h.status === 'pending').reduce((sum, h) => sum + BigInt(h.amountNau), 0n);
  const titleOf = (e: HistoryEntry) => {
    if (e.kind === 'received') return e.record.status === 'pending' ? 'Incoming' : 'Received';
    if (e.kind === 'self') return 'Moved to yourself';
    if (e.record.txid === '' || e.record.recipient === null) return 'Sent';
    const c = contactFor(e.record.recipient);
    return `Sent to ${c ? c.name : e.record.recipient ? abbreviateAddress(e.record.recipient) : 'address'}`;
  };
  // The coins a payment put on the chain, by their commitments: what a block
  // explorer knows them by. A received row's coin carries its own commitment
  // once scanned with a core that keeps it. The labels say "coin", as the
  // rest of the app does; "output" is the protocol's word, not the person's.
  const outputsOf = (e: HistoryEntry): { commitment: string; label: string }[] => {
    const coinOf = (row: HistoryRecord) => {
      const hash = coinKeyOfReceipt(row);
      return (utxos.find((u) => u.hash === hash)?.stored as StoredUtxo | undefined)?.commitment;
    };
    if (e.kind === 'received') {
      const c = coinOf(e.record) ?? e.record.outputs?.[0]?.commitment;
      return c ? [{ commitment: c, label: 'Your coin' }] : [];
    }
    const numbered = (list: { commitment: string; label: string }[]) => {
      const changes = list.filter((o) => o.label === 'Your change').length;
      let n = 0;
      return list.map((o) => (o.label === 'Your change' && changes > 1 ? { ...o, label: `Your change ${++n}` } : o));
    };
    const recorded = (e.record.outputs ?? []).map((o) => ({ commitment: o.commitment, label: o.role === 'recipient' ? (e.kind === 'self' ? 'Your coin' : "The recipient's coin") : 'Your change' }));
    if (recorded.length > 0) return numbered(recorded);
    // A send recorded before outputs were kept: the coins it brought back
    // are known once scanned, the recipient's output is not.
    return numbered(
      e.folded.flatMap((row) => {
        const c = coinOf(row);
        return c ? [{ commitment: c, label: e.kind === 'self' && BigInt(row.amountNau) === BigInt(e.record.amountNau) ? 'Your coin' : 'Your change' }] : [];
      }),
    );
  };

  const statusOf = (h: HistoryRecord) =>
    h.status === 'confirmed' ? (h.height !== null ? `Confirmed in block ${showBlock(h.height)}` : 'Confirmed') : h.status === 'pending' ? 'Pending, waiting for a block' : 'Failed';
  const nodeStatusOf = (h: HistoryRecord) => {
    if (h.kind !== 'sent' || h.status !== 'pending' || !h.mempoolCheckedAt) return null;
    return h.mempoolSeenAt ? `In the node's mempool, checked ${formatWhen(h.mempoolCheckedAt)}` : 'Not seen in the node\'s mempool yet';
  };

  return (
    <Stack gap="md">
      <Title order={2} className="sr-only">
        Home
      </Title>
      <PocNotice />
      {failure && failure.accountId === account?.id && (
        <Alert color="red" title="Not sent" withCloseButton onClose={dismissFailure}>
          <Text size="sm">
            {failure.amount} NPT to {abbreviateAddress(failure.recipient)}, {new Date(failure.at).toLocaleString()}. {failure.message}
          </Text>
        </Alert>
      )}
      {/* One notice at a time: the backup first, since a lost seed phrase is worse than a missing install. */}
      {!showBackupNudge && <InstallNudge />}
      {showBackupNudge && (
        <Alert color="yellow" icon={<IconShieldCheck size={18} />} title="Back up this wallet" withCloseButton onClose={() => void dismissNudge()}>
          <Text size="sm">Clearing the browser's site data deletes it. Export a backup file so you can restore the wallet and its contacts.</Text>
          <Text size="sm" mt="xs">
            <UnstyledButton onClick={() => navigate('/settings')} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
              Export backup file
            </UnstyledButton>
          </Text>
        </Alert>
      )}
      {/* The dot answers "is this current?" without reading: green up to date, amber while working, red when it cannot say. */}
      <div className="vault-status">
        <span className="vault-status-text">
          <span className={`vault-status-dot ${!online || sync?.phase === 'error' ? 'bad' : sync?.phase === 'done' ? 'ok' : 'busy'}`} aria-hidden />
          {!online && <IconWifiOff size={14} stroke={1.8} />}
          {busy && <IconRefresh size={14} stroke={1.8} className="vault-spin" />}
          {syncText}
        </span>
        {!busy && online && (
          <span className="vault-status-actions">
            {sync?.phase === 'error' && (
              <UnstyledButton onClick={() => navigate('/settings')} fz="xs" c="var(--v-accent-text)" className="vault-tap-link">
                Settings
              </UnstyledButton>
            )}
            <UnstyledButton onClick={() => void syncNow()} fz="xs" c="var(--v-accent-text)" className="vault-tap-link">
              {sync?.phase === 'error' ? 'Retry' : 'Sync'}
            </UnstyledButton>
          </span>
        )}
      </div>
      <Paper>
        <Stack gap="xs">
          {/* The eye keeps its 40 px target but is pulled into the row's
              margins, so the label sits where every other card's title does. */}
          <Group justify="space-between" align="center" style={{ minHeight: 0 }}>
            <span className="vault-eyebrow">Balance</span>
            <ActionIcon variant="subtle" size="lg" className="vault-tap" my={-10} mr={-8} aria-label={hidden ? 'Show amounts' : 'Hide amounts'} aria-pressed={hidden} onClick={toggleHidden}>
              {hidden ? <IconEyeOff size={20} stroke={1.8} /> : <IconEye size={20} stroke={1.8} />}
            </ActionIcon>
          </Group>
          <div className="vault-balance" aria-label={hidden ? 'Balance hidden' : `${showNau(balance.spendableNau)} NPT`}>
            {loaded ? amount(balance.spendableNau) : '…'}
            <small> NPT</small>
          </div>
          {/* Money on the way and money held, as two readings; the sentence behind them is one tap away. */}
          {incomingNau > 0n && (
            <Group gap={6} wrap="nowrap">
              <IconArrowDownLeft size={14} stroke={1.8} className="vault-balance-note-in" aria-hidden />
              <Text size="sm">{amount(incomingNau)} NPT incoming</Text>
            </Group>
          )}
          {balance.reservedNau > 0n && (
            <Group gap={6} wrap="nowrap">
              <IconLock size={14} stroke={1.8} className="vault-balance-note-held" aria-hidden />
              <Text size="sm">{amount(balance.reservedNau)} NPT held until confirmed</Text>
            </Group>
          )}
          {balance.lockedNau > 0n && (
            <Group gap={6} wrap="nowrap">
              <IconClockPause size={14} stroke={1.8} className="vault-balance-note-held" aria-hidden />
              <Text size="sm">
                {amount(balance.lockedNau)} NPT time-locked{balance.nextReleaseMs ? `, first release ${showDate(balance.nextReleaseMs)}` : ''}
              </Text>
            </Group>
          )}
          {(incomingNau > 0n || balance.reservedNau > 0n || balance.lockedNau > 0n) && (
            <>
              <UnstyledButton onClick={() => setWhy((v) => !v)} c="var(--v-accent-text)" fz="xs" className="vault-tap-link" aria-expanded={why}>
                {why ? 'Less' : 'What does this mean?'}
              </UnstyledButton>
              {why && (
                <Text size="xs" c="dimmed">
                  {incomingNau > 0n && `${amount(incomingNau)} NPT is on its way to you and becomes spendable once a block confirms it. `}
                  {balance.lockedNau > 0n && `${amount(balance.lockedNau)} NPT was paid to you with a time lock set by the payer. It is yours, but the network will not let it be spent before its release date, so it is not counted as spendable. `}
                  {balance.reservedNau > 0n &&
                    `${amount(balance.reservedNau)} NPT is held by ${pendingSends.length === 1 ? 'a pending send' : `${pendingSends.length} pending sends`}${pendingSends.length === 1 ? `: ${amount(BigInt(pendingSends[0].amountNau))} NPT to the recipient and ${amount(BigInt(pendingSends[0].feeNau ?? '0'))} NPT fee` : ''}. Once ${pendingSends.length === 1 ? 'it is' : 'they are'} confirmed, usually within a few blocks, ${amount(afterPendingNau)} NPT is spendable.`}
                </Text>
              )}
            </>
          )}
          <Group grow mt="sm">
            <Button leftSection={<IconArrowUpRight size={16} stroke={1.8} />} onClick={() => navigate('/send')}>
              Send
            </Button>
            <Button variant="light" leftSection={<IconArrowDownLeft size={16} stroke={1.8} />} onClick={() => navigate('/receive')}>
              Receive
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper>
        <Stack>
        <Title order={3}>History</Title>
        {!loaded ? (
          <Text c="dimmed" size="sm">
            Loading…
          </Text>
        ) : entries.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing yet.{' '}
            <UnstyledButton onClick={() => navigate('/receive')} c="var(--v-accent-text)" fz="sm" className="vault-tap-link">
              Share your receiving address
            </UnstyledButton>{' '}
            to get started.
          </Text>
        ) : (
          <div>
            {entries.slice(0, shown).map((e) => {
              const h = e.record;
              const incoming = e.kind === 'received';
              return (
                <UnstyledButton className="vault-row vault-row-button" key={h.key} onClick={() => setDetail(e)} aria-label={`${titleOf(e)}, ${incoming ? 'plus' : 'minus'} ${amount(e.shownNau)} NPT${h.status !== 'confirmed' ? ', ' + h.status : ''}${lockOf(h) !== null ? ', time-locked' : ''}, details`}>
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className={`vault-row-icon${incoming ? '' : ' out'}`}>
                      {incoming ? <IconArrowDownLeft size={18} stroke={1.8} /> : e.kind === 'self' ? <IconArrowsExchange size={18} stroke={1.8} /> : <IconArrowUpRight size={18} stroke={1.8} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} className="vault-row-title">
                        {titleOf(e)}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatWhen(h.timestampMs)}
                        {h.status !== 'confirmed' && (
                          <>
                            {' · '}
                            <Text span inherit className={h.status === 'pending' ? 'vault-state-pending' : 'vault-state-failed'}>
                              {h.status === 'pending' ? 'Pending' : 'Failed'}
                            </Text>
                          </>
                        )}
                        {lockOf(h) !== null && (
                          <>
                            {' · '}
                            <Text span inherit className="vault-state-pending">
                              Locked until {showDate(lockOf(h) as number)}
                            </Text>
                          </>
                        )}
                        {e.kind === 'self' && !hidden && ' · fee only'}
                      </Text>
                    </div>
                  </Group>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <Text size="sm" fw={600} className={incoming ? 'vault-amount-in' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {incoming ? '+' : '−'}
                      {amount(e.shownNau)}
                    </Text>
                  </div>
                </UnstyledButton>
              );
            })}
            {entries.length > shown && (
              <Button variant="subtle" fullWidth mt="xs" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, entries.length - shown)} older
              </Button>
            )}
          </div>
        )}
        </Stack>
      </Paper>

      <Modal opened={detail !== null} onClose={() => setDetail(null)} title={detail ? titleOf(detail) : ''}>
        {detail && (
          <Stack gap="sm">
            <DetailRow label="Status" value={statusOf(detail.record)} />
            <DetailRow label="When" value={new Date(detail.record.timestampMs).toLocaleString()} />
            {detail.kind === 'received' && <DetailRow label="Amount" value={`${amount(detail.shownNau)} NPT`} />}
            {lockOf(detail.record) !== null && (
              <DetailRow label="Time lock" value={`Not spendable before ${new Date(lockOf(detail.record) as number).toLocaleString()}. The payer set this; confirmations do not shorten it.`} />
            )}
            {detail.kind === 'sent' && (
              <DetailRow label={detail.record.txid === '' || detail.record.recipient === null ? 'Amount plus fee' : 'Amount'} value={`${amount(BigInt(detail.record.amountNau))} NPT`} />
            )}
            {detail.kind === 'self' && <DetailRow label="Moved" value={`${amount(BigInt(detail.record.amountNau))} NPT, back to this wallet`} />}
            {detail.kind !== 'received' && detail.record.feeNau && <DetailRow label="Fee" value={`${amount(BigInt(detail.record.feeNau))} NPT`} />}
            {/* The figure on the row, where it is made of two: what left the wallet. */}
            {detail.kind === 'sent' && detail.record.feeNau && <DetailRow label="Total" value={`${amount(detail.shownNau)} NPT`} />}
            {detail.kind === 'sent' && detail.changeNau !== null && <DetailRow label="Change returned" value={`${amount(detail.changeNau)} NPT`} />}
            {detail.kind !== 'received' && detail.record.recipient && (
              <DetailRow
                label={detail.kind === 'self' ? 'Recipient · this wallet' : contactFor(detail.record.recipient) ? `Recipient · ${contactFor(detail.record.recipient)?.name}` : 'Recipient'}
                value={detail.record.recipient}
                mono
                abbreviate
                copy="Address copied"
              />
            )}
            {detail.kind === 'sent' && !detail.record.recipient && (
              <DetailRow label="Recipient" value="Not known on this device. The send was made elsewhere, or before this wallet was restored; the chain carries neither the recipient nor the fee, so the amount above includes the fee." />
            )}
            {detail.record.note && <DetailRow label="Note from the link" value={detail.record.note} isolate />}
            {detail.record.error && <DetailRow label="Error" value={detail.record.error} />}
            {nodeStatusOf(detail.record) && <DetailRow label="Node" value={nodeStatusOf(detail.record) as string} />}
            {outputsOf(detail).length > 0 && (
              <>
                {/* A section of the sheet, not a link beside the address's own
                    link: a line above it, the muted colour, a chevron that turns. */}
                <UnstyledButton onClick={() => setTech((v) => !v)} className="vault-detail-section" aria-expanded={tech}>
                  <span>Technical details</span>
                  <IconChevronDown size={16} stroke={1.8} aria-hidden className={tech ? 'vault-chevron open' : 'vault-chevron'} />
                </UnstyledButton>
                {tech && (
                  <Text size="xs" c="dimmed">
                    A payment puts new coins on the chain. These are their identifiers, called commitments, for looking one up in a block explorer. They reveal no amount and no address.
                  </Text>
                )}
                {tech &&
                  outputsOf(detail).map((o) => (
                    <DetailRow key={o.commitment} label={o.label} value={o.commitment} mono copy="Identifier copied" />
                  ))}
              </>
            )}
            {detail.kind !== 'received' && detail.record.status === 'pending' && (
              <Group justify="flex-end" mt="xs">
                <Button
                  variant="light"
                  color="red"
                  onClick={() => {
                    setGivingUp(detail.record);
                    setDetail(null);
                  }}
                >
                  Give up on this send
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Modal>

      <Modal opened={givingUp !== null} onClose={() => setGivingUp(null)} title="Give up on this send?">
        {givingUp && (
          <Stack>
            <Text size="sm">
              {givingUp.mempoolCheckedAt && !givingUp.mempoolSeenAt
                ? 'The node no longer holds this transaction, so giving up only tidies your list. The coins held for it become spendable again.'
                : givingUp.mempoolSeenAt
                  ? 'The node still holds this transaction. The coins held for it become spendable here again, but if the network confirms it anyway, it still goes through and shows up as sent.'
                  : 'The coins held for it become spendable again. If the transaction is confirmed anyway, it still goes through and shows up as sent.'}
            </Text>
            <Text size="sm" c="dimmed">
              This send: {showNau(BigInt(givingUp.amountNau))} NPT{givingUp.feeNau && ` plus a ${showNau(BigInt(givingUp.feeNau))} NPT fee`}. Held for it: {showNau(reservedFor(givingUp))} NPT, which becomes spendable again.
            </Text>
            <Group grow>
              <Button variant="default" onClick={() => setGivingUp(null)}>
                Keep waiting
              </Button>
              <Button color="red" onClick={() => void giveUp()}>
                Give up
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/** A label and its value in the detail sheet; long values wrap and can be copied. */
function DetailRow({ label, value, mono, copy, abbreviate, isolate }: { label: string; value: string; mono?: boolean; copy?: string; abbreviate?: boolean; isolate?: boolean }) {
  // Long values (a generation address is about 3,500 characters) show
  // abbreviated with a toggle; copying always takes the full value.
  const [full, setFull] = useState(false);
  const shown = abbreviate && !full ? abbreviateAddress(value) : value;
  return (
    <div className="vault-detail-row">
      <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed" className="vault-detail-label">
          {label}
        </Text>
        {copy && (
          <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copyText(value, copy)}>
            <IconCopy size={16} stroke={1.8} />
          </ActionIcon>
        )}
      </Group>
      <Text size="sm" className={mono ? 'vault-detail-mono' : isolate ? 'vault-bidi vault-link-meta-text' : undefined} dir={isolate ? 'auto' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {shown}
      </Text>
      {abbreviate && (
        <UnstyledButton onClick={() => setFull((v) => !v)} c="var(--v-accent-text)" fz="xs" className="vault-tap-link vault-tap-link-start">
          {full ? 'Hide full address' : 'Show full address'}
        </UnstyledButton>
      )}
    </div>
  );
}
