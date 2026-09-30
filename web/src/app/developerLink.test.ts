import { describe, expect, it } from 'vitest';

import { withoutDeveloperFlag } from './developerLink';

describe('the developer link', () => {
  it('is found, and taken out of the address with nothing else', () => {
    expect(withoutDeveloperFlag('http://localhost:4400/?developer')).toBe('http://localhost:4400/');
    expect(withoutDeveloperFlag('https://vault.dev.useneptune.org/?developer=1')).toBe('https://vault.dev.useneptune.org/');
    expect(withoutDeveloperFlag('http://localhost:4400/onboarding?add=1&developer#top')).toBe('http://localhost:4400/onboarding?add=1#top');
  });

  it('leaves an address without it alone', () => {
    expect(withoutDeveloperFlag('http://localhost:4400/')).toBeNull();
    expect(withoutDeveloperFlag('http://localhost:4400/?developers')).toBeNull();
  });
});
