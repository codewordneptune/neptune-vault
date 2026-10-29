// How a restore or a rescan finds the wallet's payments: fast, through the
// node's coin index, or private, by scanning the blocks on this device. A
// labelled choice, asked first: a date matters only to a private one.

import { Input, SegmentedControl } from '@mantine/core';
import { useId } from 'react';

export function MethodChoice({ what, fast, onChange }: { what: 'restore' | 'rescan'; fast: boolean; onChange: (fast: boolean) => void }) {
  const id = useId();
  return (
    <Input.Wrapper label={`How to ${what}`} labelElement="div" labelProps={{ id }}>
      <SegmentedControl
        aria-labelledby={id}
        fullWidth
        value={fast ? 'fast' : 'private'}
        onChange={(v) => onChange(v === 'fast')}
        data={[
          { value: 'fast', label: `Fast ${what}` },
          { value: 'private', label: `Private ${what}` },
        ]}
      />
    </Input.Wrapper>
  );
}
