// Where a scan starts, asked the way people can answer: the month the
// wallet first received funds. The node finds the first block of that
// month (a binary search over block headers, about sixteen requests on
// mainnet) and fills the height in; the height is what the wallet keeps.
// The block number itself sits behind a disclosure, for whoever knows it,
// and opens by itself when the node cannot look a month up. Restore and
// Rescan both ask this way.

import { Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { showBlock } from '../app/AppContext';
import type { NodeClient } from '../node/rpc';
import type { Network } from '../storage/db';
import { startOfDayMs } from '../util/blockdate';
import { Spoken } from './Spoken';

export type StartLookup = 'idle' | 'looking' | 'found' | 'failed';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Neptune's mainnet began in 2025: no wallet received funds before. */
const FIRST_YEAR = 2025;

/** Mainnet blocks as a scan downloads them: 15 to 19 MB per 100, measured. */
const MAINNET_MB_PER_BLOCK = 0.17;

/** What scanning this many Mainnet blocks downloads, roughly. */
export function downloadSize(blocks: number): string {
  const mb = blocks * MAINNET_MB_PER_BLOCK;
  return mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 10_000 ? 0 : 1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

export function StartBlockPicker({
  value,
  onChange,
  node,
  month: givenMonth,
  onMonthChange,
  onLookup,
  error,
  network,
}: {
  value: number | string;
  onChange: (height: number | string) => void;
  /** The node to ask; a fresh client each time so a changed URL is honoured. */
  node: () => NodeClient;
  /** The month chosen, as YYYY-MM, or ''; kept by the caller when given, so it outlasts this field. */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** Told how the month lookup stands, so the caller can wait for it. */
  onLookup?: (state: StartLookup) => void;
  /** A problem with the block, such as one above the chain's tip. */
  error?: string | null;
  /** The wallet's network: on Mainnet, what the scan downloads is said too. */
  network?: Network;
}) {
  const [ownMonth, setOwnMonth] = useState('');
  const month = givenMonth ?? ownMonth;
  const setMonth = onMonthChange ?? setOwnMonth;
  const [lookup, setLookupState] = useState<{ kind: 'idle' } | { kind: 'looking' } | { kind: 'found'; height: number } | { kind: 'failed'; message: string }>({ kind: 'idle' });
  const setLookup = (next: typeof lookup) => {
    setLookupState(next);
    onLookup?.(next.kind);
  };
  const latest = useRef(0);
  // The chain's tip, asked once, for the download a Mainnet scan means.
  const [tip, setTip] = useState<number | null>(null);
  useEffect(() => {
    if (network !== 'main') return;
    let live = true;
    void node().probe().then(
      (height) => live && setTip(height),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // A fresh client each render: asked on the network only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);
  const [year, monthNo] = month ? month.split('-') : ['', ''];
  const now = new Date();
  const years = Array.from({ length: now.getFullYear() - FIRST_YEAR + 1 }, (_, i) => String(now.getFullYear() - i));
  const setPart = (y: string, m: string) => setMonth(y && m ? `${y}-${m}` : y ? `${y}-` : m ? `-${m}` : '');

  useEffect(() => {
    const dateMs = /^\d{4}-\d{2}$/.test(month) ? startOfDayMs(`${month}-01`) : null;
    if (dateMs === null) {
      setLookup({ kind: 'idle' });
      return;
    }
    const token = ++latest.current;
    setLookup({ kind: 'looking' });
    void (async () => {
      try {
        const height = await node().heightForDate(dateMs);
        if (token !== latest.current) return;
        onChange(height);
        setLookup({ kind: 'found', height });
      } catch (e) {
        if (token !== latest.current) return;
        const message = (e as Error).message;
        setLookup({ kind: 'failed', message: /not found|-32601/i.test(message) ? 'This node cannot look blocks up by date: enter a block number below instead.' : `Could not ask the node: ${message}` });
      }
    })();
    // onChange, onLookup and node are fresh closures each render; the lookup reruns on the month only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const monthName = /^\d{4}-\d{2}$/.test(month) ? `${MONTHS[Number(monthNo) - 1]} ${year}` : '';
  // With no month chosen, a block typed below (or the one the wallet
  // already starts at) is where the scan starts, and the line says so.
  const typed = Number(value) > 1 ? Number(value) : null;
  const from = lookup.kind === 'found' ? lookup.height : typed;
  const download = network === 'main' && tip !== null && from !== null && tip > from ? ` About ${downloadSize(tip - from)} to download.` : '';
  return (
    <Stack gap="xs">
      <Group grow>
        <Select label="Month" placeholder="Month" data={MONTHS.map((name, i) => ({ value: String(i + 1).padStart(2, '0'), label: name }))} value={monthNo || null} onChange={(v) => setPart(year, v ?? '')} />
        <Select label="Year" placeholder="Year" data={years} value={year || null} onChange={(v) => setPart(v ?? '', monthNo)} />
      </Group>
      {/* The lookup's answers are announced: it takes a few seconds, and they
          appear on their own. What follows from a typed block number is only
          shown, so each keystroke is not read out. */}
      {lookup.kind === 'idle' ? (
        <Text size="sm" c="dimmed">
          <Spoken
            text={
              typed !== null
                ? `The scan starts at block ${showBlock(typed)} and runs on this device. The node learns nothing about your coins.${download}`
                : 'Scanning starts at the first block of that month, on this device. The node learns nothing about your coins.'
            }
          />
        </Text>
      ) : (
        <Text size="sm" c={lookup.kind === 'failed' ? 'var(--v-danger-text)' : 'dimmed'} role="status">
          {lookup.kind === 'looking' && 'Asking the node where that month starts…'}
          {lookup.kind === 'found' && <Spoken text={`The scan starts at block ${showBlock(lookup.height)}, the first of ${monthName}, and runs on this device. The node learns nothing about your coins.${download}`} />}
          {lookup.kind === 'failed' && lookup.message}
        </Text>
      )}
      <details className="vault-setting" open={lookup.kind === 'failed' || Boolean(error)}>
        <summary>
          <IconChevronRight size={16} className="vault-setting-chevron" aria-hidden />
          Enter a block number instead
        </summary>
        <NumberInput
          mt="xs"
          label="Start block"
          description="The block your first payment arrived in, or earlier."
          min={1}
          value={value}
          onChange={(v) => {
            onChange(v);
            if (lookup.kind === 'found' && v !== lookup.height) setLookup({ kind: 'idle' });
          }}
          error={error && <Spoken text={error} />}
          errorProps={{ role: 'alert' }}
          hideControls
          inputMode="numeric"
        />
      </details>
    </Stack>
  );
}
