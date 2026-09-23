import { describe, expect, it } from 'vitest';

import { isNewer, newerRelease } from './DesktopUpdateNotice';

const release = (tag: string, draft = false) => ({ tag_name: tag, html_url: `https://example.test/${tag}`, draft });

describe('the desktop update check', () => {
  it('compares versions by their numbers', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });

  it('offers the newest published desktop release', () => {
    const found = newerRelease([release('desktop-v0.3.0'), release('desktop-v0.4.0'), release('desktop-v0.2.0')], '0.2.0');
    expect(found).toEqual({ version: '0.4.0', url: 'https://example.test/desktop-v0.4.0' });
  });

  it('ignores drafts, other tags and older versions', () => {
    expect(newerRelease([release('desktop-v0.9.0', true), release('v9.0.0'), release('desktop-v0.1.0')], '0.2.0')).toBeNull();
  });
});
