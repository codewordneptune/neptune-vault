// A row's More button, which opens the row's menu, named under the pointer
// as every icon button is. The tooltip is attached by its target: wrapped
// around Menu.Target it would take the button's click, and inside it the
// menu's attributes (expanded, controls) would land on the tooltip.

import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { IconDotsVertical } from '@tabler/icons-react';
import { useRef, type Ref } from 'react';

export function MoreButton({ label, buttonRef }: { label: string; buttonRef?: Ref<HTMLButtonElement> }) {
  const own = useRef<HTMLButtonElement>(null);
  const ref = useMergedRef(own, buttonRef);
  return (
    <>
      <Menu.Target>
        <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label={label} ref={ref}>
          <IconDotsVertical size={20} />
        </ActionIcon>
      </Menu.Target>
      <Tooltip label="More" target={own} interactive />
    </>
  );
}
