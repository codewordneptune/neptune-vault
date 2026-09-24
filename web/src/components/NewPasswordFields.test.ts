import { describe, expect, it } from 'vitest';

import { newPasswordOk, passwordStrength } from './NewPasswordFields';

describe('a new password', () => {
  it('is rated by length alone, and not at all while empty', () => {
    expect(passwordStrength('')).toBeNull();
    expect(passwordStrength('1234567')).toBe('short');
    expect(passwordStrength('12345678')).toBe('weak');
    expect(passwordStrength('123456789012')).toBe('good');
    expect(passwordStrength('1234567890123456')).toBe('strong');
  });

  it('is usable when long enough and repeated exactly', () => {
    expect(newPasswordOk('12345678', '12345678')).toBe(true);
    expect(newPasswordOk('1234567', '1234567')).toBe(false);
    expect(newPasswordOk('12345678', '12345679')).toBe(false);
  });
});
