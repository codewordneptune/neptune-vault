// A value chosen from a short list: a labelled field, the same height, edge
// and text as the other fields, that opens the list. Each choice has its
// name and a note; the one chosen is ticked. Receive's address type and
// Send's fee. It is a select (a button and a list box), not a menu of
// commands, so a screen reader says "Medium, selected". Opened from the
// keyboard, the arrows start at the choice made, and the list goes when
// focus moves on (Tab), as a native select's does.

import { Combobox, Input, Text, useCombobox } from '@mantine/core';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';

export interface Choice {
  value: string;
  name: string;
  /** A line under the name: what the choice is, or what it costs. */
  note?: ReactNode;
}

// The value of the entry that does something other than choose.
const MORE = 'vault-choice-more';

export function ChoiceField({
  label,
  value,
  choices,
  onChoose,
  face,
  hint,
  more,
  reading,
}: {
  label: string;
  value: string;
  choices: Choice[];
  onChoose: (value: string) => void;
  /** What the field shows; the chosen choice's name unless given. */
  face?: ReactNode;
  /** One line at the top of the list, about all the choices. A screen reader hears it with the field. */
  hint?: string;
  /** A last entry that does something else, such as comparing the choices. */
  more?: { label: string; onSelect: () => void };
  /** A reading under the field, as under an amount field: its estimate in another currency. */
  reading?: ReactNode;
}) {
  const labelId = useId();
  const fieldId = useId();
  const hintId = useId();
  const readingId = useId();
  const box = useCombobox({
    onDropdownClose: () => box.resetSelectedOption(),
    onDropdownOpen: (source) => {
      if (source === 'keyboard') box.selectActiveOption();
    },
  });
  const describedBy = [reading ? readingId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <Input.Label id={labelId} htmlFor={fieldId}>
        {label}
      </Input.Label>
      <Combobox
        store={box}
        onOptionSubmit={(v) => {
          box.closeDropdown();
          if (more && v === MORE) more.onSelect();
          else onChoose(v);
        }}
        position="bottom-start"
      >
        <Combobox.Target targetType="button" withExpandedAttribute>
          <button type="button" id={fieldId} className="vault-choice-field" aria-labelledby={`${labelId} ${fieldId}`} aria-describedby={describedBy} onClick={() => box.toggleDropdown()} onBlur={() => box.closeDropdown()}>
            <span className="vault-choice-face">{face ?? choices.find((c) => c.value === value)?.name}</span>
            <IconChevronDown size={16} aria-hidden />
          </button>
        </Combobox.Target>
        <Combobox.Dropdown>
          <div className="vault-picker-label" aria-hidden>
            {label}
          </div>
          {hint && (
            <Text size="xs" c="dimmed" className="vault-picker-hint" aria-hidden>
              {hint}
            </Text>
          )}
          <Combobox.Options aria-label={label}>
            {choices.map((c) => (
              <Combobox.Option key={c.value} value={c.value} active={c.value === value} aria-selected={c.value === value} className="vault-choice-option">
                <span className="vault-choice-check" aria-hidden>
                  {c.value === value && <IconCheck size={16} />}
                </span>
                <span>
                  <Text span display="block" size="sm" fw={600}>
                    {c.name}
                  </Text>
                  {c.note && (
                    <Text span display="block" size="xs" c="dimmed">
                      {c.note}
                    </Text>
                  )}
                </span>
              </Combobox.Option>
            ))}
            {/* An entry of the list, so the arrow keys reach it too. */}
            {more && (
              <Combobox.Option value={MORE} className="vault-choice-option vault-choice-more">
                <span className="vault-choice-check" aria-hidden />
                <Text span size="sm">
                  {more.label}
                </Text>
              </Combobox.Option>
            )}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
      {hint && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
      {reading && (
        <Text id={readingId} size="sm" c="dimmed" mt={5}>
          {reading}
        </Text>
      )}
    </div>
  );
}
