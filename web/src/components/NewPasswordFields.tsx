// A new password and its repeat, as setup and Settings both ask for one.
// Length is the only signal worth showing; anything finer misleads. The
// strength is a coloured word under the field, not a bar and not an error:
// four words say as much as the app knows, and nothing turns red while the
// person is still typing. Only a repeat that differs is an error, and only
// once something has been typed there.

import { PasswordInput, Stack, Text } from '@mantine/core';

export const MIN_PASSWORD_LENGTH = 8;

export type PasswordStrength = 'short' | 'weak' | 'good' | 'strong';

/** How strong a new password is, by length alone; null while nothing is typed. */
export function passwordStrength(password: string): PasswordStrength | null {
  if (password.length === 0) return null;
  if (password.length < MIN_PASSWORD_LENGTH) return 'short';
  if (password.length < 12) return 'weak';
  if (password.length < 16) return 'good';
  return 'strong';
}

/** Whether a new password and its repeat can be used. */
export function newPasswordOk(password: string, again: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password === again;
}

const WORDS: Record<PasswordStrength, string> = { short: 'Too short', weak: 'Weak', good: 'Good', strong: 'Strong' };
// The theme's text tokens, which keep their contrast in both themes.
const COLOURS: Record<PasswordStrength, string> = {
  short: 'var(--v-danger-text)',
  weak: 'var(--v-warn-text)',
  good: 'var(--v-ok-text)',
  strong: 'var(--v-ok-text)',
};

export function NewPasswordFields({
  password,
  onPassword,
  again,
  onAgain,
  label = 'Password (at least 8 characters)',
  repeatLabel = 'Repeat',
}: {
  password: string;
  onPassword: (value: string) => void;
  again: string;
  onAgain: (value: string) => void;
  label?: string;
  repeatLabel?: string;
}) {
  const level = passwordStrength(password);
  return (
    <Stack>
      <PasswordInput
        label={label}
        description={
          level ? (
            <>
              Strength:{' '}
              <Text span inherit fw={600} c={COLOURS[level]}>
                {WORDS[level]}
              </Text>
            </>
          ) : (
            'Longer beats complicated.'
          )
        }
        value={password}
        onChange={(e) => onPassword(e.currentTarget.value)}
        autoComplete="new-password"
      />
      <PasswordInput
        label={repeatLabel}
        value={again}
        onChange={(e) => onAgain(e.currentTarget.value)}
        // Judged once it is complete: half-typed, it would always "differ".
        error={again.length >= password.length && again !== password ? 'Passwords differ' : undefined}
        autoComplete="new-password"
      />
    </Stack>
  );
}
