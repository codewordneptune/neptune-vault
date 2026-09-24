// Where a scan starts, asked the way people can answer: the month the
// wallet first received funds. The node finds the first block of that
// month (a binary search over block headers, about sixteen requests on
// mainnet) and fills the height in; the height is what the wallet keeps.
// The block number itself sits behind a disclosure, for whoever knows it,
// and opens by itself when the node cannot look a month up. Restore and
// Rescan both ask this way.

import { Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import { showBlock } from '../app/AppContext';
import type { NodeClient } from '../node/rpc';
import { startOfDayMs } from '../util/blockdate';

export type StartLookup = 'idle' | 'looking' | 'found' | 'failed';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Neptune's mainnet began in 2025: no wallet received funds before. */
const FIRST_YEAR = 2025;

export function StartBlockPicker({
  value,
  onChange,
  node,
  month: givenMonth,
  onMonthChange,
  onLookup,
  error,
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
  return (
    <Stack gap="xs">
      <Group grow>
        <Select label="Month" placeholder="Month" data={MONTHS.map((name, i) => ({ value: String(i + 1).padStart(2, '0'), label: name }))} value={monthNo || null} onChange={(v) => setPart(year, v ?? '')} />
        <Select label="Year" placeholder="Year" data={years} value={year || null} onChange={(v) => setPart(v ?? '', monthNo)} />
      </Group>
      {/* Announced as it changes: the lookup takes a few seconds, and its answer appears on its own. */}
      <Text size="sm" c={lookup.kind === 'failed' ? 'var(--v-danger-text)' : 'dimmed'} role="status">
        {lookup.kind === 'looking' && 'Asking the node where that month starts…'}
        {lookup.kind === 'found' && `The scan starts at block ${showBlock(lookup.height)}, the first of ${monthName}, and runs on this device. The node learns nothing about your coins.`}
        {lookup.kind === 'failed' && lookup.message}
        {lookup.kind === 'idle' &&
          (typed !== null
            ? `The scan starts at block ${showBlock(typed)} and runs on this device. The node learns nothing about your coins.`
            : 'Scanning starts at the first block of that month, on this device. The node learns nothing about your coins.')}
      </Text>
      <details className="vault-more" open={lookup.kind === 'failed' || Boolean(error)}>
        <summary>Enter a block number instead</summary>
        <NumberInput
          mt="xs"
          label="Start block"
          description="The block your first funds arrived in, or earlier."
          min={1}
          value={value}
          onChange={(v) => {
            onChange(v);
            if (lookup.kind === 'found' && v !== lookup.height) setLookup({ kind: 'idle' });
          }}
          error={error}
          hideControls
          inputMode="numeric"
        />
      </details>
    </Stack>
  );
}
