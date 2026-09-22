// Where a scan starts: a block height, typed or found from a date. The
// date lookup asks the node for block headers (a binary search, about
// sixteen requests on mainnet) and fills the height in; the height is what
// the wallet keeps.

import { NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import { showBlock } from '../app/AppContext';
import type { NodeClient } from '../node/rpc';
import { startOfDayMs } from '../util/blockdate';

export function StartBlockPicker({
  value,
  onChange,
  node,
  disabled,
  description,
  error,
}: {
  value: number | string;
  onChange: (height: number | string) => void;
  /** The node to ask; a fresh client each time so a changed URL is honoured. */
  node: () => NodeClient;
  disabled?: boolean;
  description?: string;
  error?: string | null;
}) {
  const [day, setDay] = useState('');
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'looking' } | { kind: 'found'; height: number; day: string } | { kind: 'failed'; message: string }>({ kind: 'idle' });
  const latest = useRef(0);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const dateMs = day ? startOfDayMs(day) : null;
    if (dateMs === null) {
      setStatus({ kind: 'idle' });
      return;
    }
    const token = ++latest.current;
    setStatus({ kind: 'looking' });
    void (async () => {
      try {
        const height = await node().heightForDate(dateMs);
        if (token !== latest.current) return;
        onChange(height);
        setStatus({ kind: 'found', height, day });
      } catch (e) {
        if (token !== latest.current) return;
        const message = (e as Error).message;
        setStatus({ kind: 'failed', message: /not found|-32601/i.test(message) ? 'This node cannot look blocks up by date; enter a block number instead.' : `Could not ask the node: ${message}` });
      }
    })();
    // onChange is a fresh closure each render; the lookup should rerun on the day only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  return (
    <Stack gap="xs">
      <TextInput
        label="Start from a date"
        description="The day your first funds arrived, or earlier. The node finds the block."
        type="date"
        max={today}
        value={day}
        onChange={(e) => setDay(e.currentTarget.value)}
        disabled={disabled}
      />
      <NumberInput
        label="Start block"
        description={description}
        min={1}
        value={value}
        onChange={(v) => {
          onChange(v);
          if (status.kind === 'found' && v !== status.height) setStatus({ kind: 'idle' });
        }}
        error={error}
        hideControls
        inputMode="numeric"
        disabled={disabled}
      />
      {status.kind === 'looking' && (
        <Text size="sm" c="dimmed">
          Asking the node…
        </Text>
      )}
      {status.kind === 'found' && (
        <Text size="sm" c="dimmed">
          The first block of {new Date(startOfDayMs(status.day) as number).toLocaleDateString()} is {showBlock(status.height)}.
        </Text>
      )}
      {status.kind === 'failed' && (
        <Text size="sm" c="red">
          {status.message}
        </Text>
      )}
    </Stack>
  );
}
