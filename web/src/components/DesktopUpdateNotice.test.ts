import { describe, expect, it } from 'vitest';

import { isNewer, newerRelease } from './DesktopUpdateNotice';

const release = (tag: string, kind: 'published' | 'draft' | 'prerelease' = 'published') => ({
  tag_name: tag,
  html_url: 'https://example.test/elsewhere',
  draft: kind === 'draft',
  prerelease: kind === 'prerelease',
});

describe('the desktop update check', () => {
  it('compares versions by their numbers', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });

  it('offers the newest published desktop release, by its own tag page', () => {
    const found = newerRelease([release('desktop-v0.3.0'), release('desktop-v0.4.0'), release('desktop-v0.2.0')], '0.2.0');
    expect(found).toEqual({ version: '0.4.0', url: 'https://github.com/codewordneptune/neptune-vault/releases/tag/desktop-v0.4.0' });
  });

  it('ignores drafts, pre-releases, other tags and older versions', () => {
    const releases = [release('desktop-v0.9.0', 'draft'), release('desktop-v0.8.0', 'prerelease'), release('v9.0.0'), release('desktop-v0.1.0')];
    expect(newerRelease(releases, '0.2.0')).toBeNull();
  });

  it('ignores a version that is not numbers and dots', () => {
    const releases = [release('desktop-v1.0.0-rc.1'), release('desktop-v2.0.0/../../../elsewhere'), release('desktop-v3.0.0?x=1')];
    expect(newerRelease(releases, '0.2.0')).toBeNull();
  });
});
