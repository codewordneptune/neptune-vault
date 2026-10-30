// Numbered seed-word cells: two columns on phones, three on wider screens. A
// word too long for its cell with enlarged text wraps rather than being cut
// short, since a cut word is one that can be copied down wrong. Used to show a phrase and, with `blanks`, to confirm one:
// blank positions render as slots, and a filled slot can be tapped to empty
// it again. The slot the next word goes into is marked, so a word never
// lands somewhere the person did not expect.

import { Box, Group, SimpleGrid, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconCopy, IconX } from '@tabler/icons-react';

import { useSecureScreen } from '../app/secureScreen';
import { PHONE, useLayout } from '../app/layout';
import { useCopied } from '../util/clipboard';
import { formatMonth } from '../util/time';

// `only` shows just those places, by their numbers: the confirmation's
// missing words, without the rest of the phrase on screen again. `month`
// closes the phrase with the month to write down with it.
export function WordGrid({ words, blanks = [], next, onClear, only, month }: { words: string[]; blanks?: number[]; next?: number; onClear?: (i: number) => void; only?: number[]; month?: number }) {
  useSecureScreen();
  const phone = useLayout(PHONE);
  // A phrase only shown, not checked, is never pressed: its rows are shorter, so it and the button after it fit on a phone.
  const shown = blanks.length === 0;
  // A numbered list to a screen reader. The role is explicit: without
  // list markers some browsers stop announcing a list as one.
  const grid = (
    <SimpleGrid component="ol" role="list" className={shown ? 'vault-word-list compact' : 'vault-word-list'} cols={phone ? 2 : 3} spacing="xs" verticalSpacing={shown ? 6 : 'xs'}>
      {(only ?? words.map((_, i) => i)).map((i) => {
        const w = words[i] ?? '';
        const blank = blanks.includes(i);
        const empty = blank && !w;
        const cell = (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" ta="right" className="vault-tabular" style={{ width: '1.8em', flexShrink: 0 }} aria-hidden={empty || undefined}>
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
              {blank && w && <IconX size={16} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden />}
            </Box>
          </Group>
        );
        return (
          <Box component="li" key={i}>
            {blank && w && onClear ? (
              <UnstyledButton className="vault-word-slot" onClick={() => onClear(i)} aria-label={`Word ${i + 1}: ${w}. Remove`} w="100%">
                {cell}
              </UnstyledButton>
            ) : (
              cell
            )}
          </Box>
        );
      })}
    </SimpleGrid>
  );
  return month === undefined ? (
    grid
  ) : (
    <div>
      {grid}
      <StartMonth at={month} />
    </div>
  );
}

/**
 * The month to write down with the words, as a last row of theirs: a private
 * restore can start there, and skip every block before it (MONTH_WHY).
 */
function StartMonth({ at }: { at: number }) {
  return (
    <div className="vault-start-month">
      <Text size="sm" c="dimmed">
        Start month
      </Text>
      <Text size="sm" fw={600}>
        {formatMonth(at)}
      </Text>
    </div>
  );
}

/** Copy words, under a shown phrase: it says Copied on itself for a moment. */
export function CopyWords({ words }: { words: string[] }) {
  const [copied, copy] = useCopied();
  return (
    <UnstyledButton c={copied ? 'var(--v-ok-text)' : 'var(--v-accent-text)'} fz="sm" className="vault-tap-link vault-tap-link-start vault-link-icon" onClick={() => void copy(words.join(' '), 'Seed phrase copied')}>
      {copied ? <IconCheck size={16} aria-hidden /> : <IconCopy size={16} aria-hidden />}
      {copied ? 'Copied' : 'Copy words'}
    </UnstyledButton>
  );
}
