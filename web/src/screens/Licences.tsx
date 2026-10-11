// The third-party software in this build and its licences, as the build
// wrote them (third-party-licences.txt, from web/thirdPartyLicences.ts): a
// page of Settings, reached from About. Fetched when opened, never cached by
// the service worker, so it is read only by those who open it.

import { Paper, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

export function ThirdPartyLicences() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/third-party-licences.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (t) => live && setText(t),
        () => live && setFailed(true),
      );
    return () => {
      live = false;
    };
  }, []);
  return (
    <Paper>
      <Stack>
        <Text size="sm" c="dimmed">
          Neptune Vault is open source, under MIT OR Apache-2.0. It is built from the software below, each under its own licence.
        </Text>
        {failed ? (
          <Text size="sm">The list could not be loaded. It is fetched when this page opens, so it needs a connection.</Text>
        ) : text === null ? (
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        ) : (
          <Text component="pre" size="xs" ff="monospace" m={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {text}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
