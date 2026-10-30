// A password field: Mantine's PasswordInput with an eye that acts on a
// click, as any button does (Mantine's own acts on the press, so a slip
// shows the password), the field marked invalid while it shows an error,
// and a hint under it while Caps Lock is on.

import { ActionIcon, PasswordInput, Tooltip, type PasswordInputProps } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { forwardRef, useState, type KeyboardEvent } from 'react';

import { WarnLine } from './Notice';

export const PasswordField = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordField(props, ref) {
  const [visible, setVisible] = useState(false);
  // Known only from a key event: nothing says so before the first key.
  const [caps, setCaps] = useState(false);
  const readCaps = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState('CapsLock'));
  return (
    <div>
    <PasswordInput
      ref={ref}
      aria-invalid={props.error ? true : undefined}
      {...props}
      visible={visible}
      onVisibilityChange={setVisible}
      onKeyDown={(e) => {
        readCaps(e);
        props.onKeyDown?.(e);
      }}
      onKeyUp={(e) => {
        readCaps(e);
        props.onKeyUp?.(e);
      }}
      onBlur={(e) => {
        setCaps(false);
        props.onBlur?.(e);
      }}
      rightSection={
        <Tooltip label={visible ? 'Hide the password' : 'Show the password'} interactive>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            className="vault-tap"
            aria-label="Show or hide the password"
            aria-pressed={visible}
            disabled={props.disabled}
            // The focus stays in the field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <IconEyeOff size={20} /> : <IconEye size={20} />}
          </ActionIcon>
        </Tooltip>
      }
    />
    <div aria-live="polite">{caps && <WarnLine mt={6} className="vault-warn-line vault-caps-on">Caps Lock is on</WarnLine>}</div>
    </div>
  );
});
