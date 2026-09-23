// The desktop app's word that a newer version is out. The web app learns of
// new builds from its service worker; the desktop app has none, and until
// its installers are signed for the auto-updater it cannot install one by
// itself either. So it asks the project's GitHub releases, now and then,
// whether a desktop version newer than its own has been published, and
// offers the download page.
//
// What it tells GitHub: that someone at this address asked about the
// project's releases, as any visit to the page would. Nothing about the
// wallet. It never counts a draft: only a release someone has published.

import { Anchor, Button, Group, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';

const RELEASES = 'https://api.github.com/repos/codewordneptune/neptune-vault/releases?per_page=20';
const TAG_PREFIX = 'desktop-v';
/** How often a running app asks again. */
const CHECK_MS = 6 * 60 * 60 * 1000;

interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
}

/** Whether version `a` is newer than `b`, by dotted numbers. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The newest published desktop release, if any is newer than `current`. */
export function newerRelease(releases: Release[], current: string): { version: string; url: string } | null {
  let best: { version: string; url: string } | null = null;
  for (const r of releases) {
    if (r.draft || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    if (isNewer(version, current) && (!best || isNewer(version, best.version))) best = { version, url: r.html_url };
  }
  return best;
}

export function DesktopUpdateNotice() {
  const { sendJob } = useApp();
  const [newer, setNewer] = useState<{ version: string; url: string } | null>(null);
  const [later, setLater] = useState(false);

  useEffect(() => {
    let live = true;
    const check = async () => {
      if (!navigator.onLine) return;
      try {
        const response = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) return;
        const found = newerRelease((await response.json()) as Release[], __APP_VERSION__);
        if (live) setNewer(found);
      } catch {
        // Offline, or GitHub not answering: nothing to say, ask again later.
      }
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const sending = Boolean(sendJob && !sendJob.done);
  if (!newer || later || sending) return null;

  return (
    <div className="vault-updatestrip" role="status">
      <div className="vault-updatestrip-inner">
        <div className="vault-updatestrip-body">
          <IconDownload size={18} stroke={1.8} />
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={600}>
              Version {newer.version} of the desktop app is out
            </Text>
            <Text size="xs" c="dimmed">
              You are on {__APP_VERSION__}. Install the new version over this one; your wallets stay.
            </Text>
          </div>
        </div>
        <div className="vault-updatestrip-actions">
          <span />
          <Group gap="xs" wrap="nowrap">
            <Button size="compact-sm" variant="subtle" className="vault-tap" onClick={() => setLater(true)}>
              Later
            </Button>
            <Anchor href={newer.url} target="_blank" rel="noreferrer" className="vault-tap-link" fw={600} size="sm">
              Download
            </Anchor>
          </Group>
        </div>
      </div>
    </div>
  );
}
