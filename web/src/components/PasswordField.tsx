// A password field: Mantine's PasswordInput with an eye that acts on a
// click, as any button does (Mantine's own acts on the press, so a slip
// shows the password), and the field marked invalid while it shows an error.

import { ActionIcon, PasswordInput, type PasswordInputProps } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { forwardRef, useState } from 'react';

export const PasswordField = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordField(props, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <PasswordInput
      ref={ref}
      aria-invalid={props.error ? true : undefined}
      {...props}
      visible={visible}
      onVisibilityChange={setVisible}
      rightSection={
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
      }
    />
  );
});
