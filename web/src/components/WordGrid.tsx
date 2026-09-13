// Numbered seed-word cells that never wrap: two columns on phones, three on
// wider screens. Used to show a phrase and, with `blanks`, to confirm one:
// blank positions render as slots, and a filled slot can be tapped to empty
// it again.

import { Box, Group, SimpleGrid, Text, UnstyledButton } from '@mantine/core';
import { IconX } from '@tabler/icons-react';

export function WordGrid({ words, blanks = [], onClear }: { words: string[]; blanks?: number[]; onClear?: (i: number) => void }) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 3 }} spacing="xs">
      {words.map((w, i) => {
        const blank = blanks.includes(i);
        const cell = (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" w={22} ta="right" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {i + 1}
            </Text>
            <Box className={`vault-word${blank ? ' slot' : ''}${blank && !w ? ' empty' : ''}`}>
              <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {w}
              </Text>
              {blank && w && <IconX size={14} style={{ flexShrink: 0, opacity: 0.7 }} />}
            </Box>
          </Group>
        );
        return blank && w && onClear ? (
          <UnstyledButton key={i} onClick={() => onClear(i)} aria-label={`Remove word ${i + 1}`} w="100%">
            {cell}
          </UnstyledButton>
        ) : (
          <Box key={i}>{cell}</Box>
        );
      })}
    </SimpleGrid>
  );
}
