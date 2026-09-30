// Numbered seed-word cells: two columns on phones, three on wider screens. A
// word too long for its cell with enlarged text wraps rather than being cut
// short, since a cut word is one that can be copied down wrong. Used to show a phrase and, with `blanks`, to confirm one:
// blank positions render as slots, and a filled slot can be tapped to empty
// it again. The slot the next word goes into is marked, so a word never
// lands somewhere the person did not expect.

import { Box, Group, SimpleGrid, Text, UnstyledButton } from '@mantine/core';
import { IconX } from '@tabler/icons-react';

// `only` shows just those places, by their numbers: the confirmation's
// missing words, without the rest of the phrase on screen again.
export function WordGrid({ words, blanks = [], next, onClear, only }: { words: string[]; blanks?: number[]; next?: number; onClear?: (i: number) => void; only?: number[] }) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 3 }} spacing="xs">
      {(only ?? words.map((_, i) => i)).map((i) => {
        const w = words[i] ?? '';
        const blank = blanks.includes(i);
        const empty = blank && !w;
        const cell = (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" ta="right" style={{ width: '1.8em', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }} aria-hidden={empty || undefined}>
              {i + 1}
            </Text>
            <Box className={`vault-word${blank ? ' slot' : ''}${empty ? ' empty' : ''}${empty && i === next ? ' next' : ''}`}>
              {/* An empty slot has no word to read out, so it is named instead. */}
              {empty ? (
                <span className="sr-only">{`Word ${i + 1}, empty${i === next ? ', next' : ''}`}</span>
              ) : (
                <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                  {w}
                </Text>
              )}
              {blank && w && <IconX size={16} stroke={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden />}
            </Box>
          </Group>
        );
        return blank && w && onClear ? (
          <UnstyledButton key={i} className="vault-word-slot" onClick={() => onClear(i)} aria-label={`Word ${i + 1}: ${w}. Remove`} w="100%">
            {cell}
          </UnstyledButton>
        ) : (
          <Box key={i}>{cell}</Box>
        );
      })}
    </SimpleGrid>
  );
}
