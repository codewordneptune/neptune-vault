// Receiving address as text and QR code (F11), for each of the three address
// kinds. Key 0 of a kind is its main address; "next unused" derives the next
// key of that kind.

import { Button, Code, Group, Paper, SegmentedControl, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';
import { nextKeyIndicesOf } from '../storage/db';
import { abbreviateAddress } from '../util/address';
import type { KeyKind } from '../wallet/core';

const KIND_LABELS: Record<KeyKind, string> = {
  generation: 'Generation',
  ec_hybrid: 'EC hybrid',
  viewing: 'Viewing',
};

// Same guidance as the desktop wallet gives on its addresses page.
const KIND_NOTES: Record<KeyKind, string> = {
  generation:
    'The most private option and a good default. Safe to reuse. The code is dense: scan from close up, or copy the address instead.',
  ec_hybrid:
    'Short and easy to share. Give each one to a single person: if reused widely, a future quantum attacker could reveal, but never spend, the funds sent to it.',
  viewing:
    'Anyone holding this address can see every payment it receives, though never spend them. Share it only with someone you trust to see that activity.',
};

export function Receive() {
  const { services, account } = useApp();
  const [kind, setKind] = useState<KeyKind>('generation');
  const [indices, setIndices] = useState<Record<KeyKind, number>>({ generation: 0, ec_hybrid: 0, viewing: 0 });
  const [address, setAddress] = useState<string>(account?.address0 ?? '');
  const [qr, setQr] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const index = indices[kind];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = kind === 'generation' && index === 0 && account ? account.address0 : await services.core.address(kind, index);
      if (cancelled) return;
      setAddress(a);
      // Upper-case bech32m is still valid and fits the QR alphanumeric mode
      // (4296 chars at level L), which a 2900-character generation address
      // needs; mixed case would overflow the byte mode. SVG scales to any
      // width without blur.
      try {
        const svg = await QRCode.toString(a.toUpperCase(), { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
        setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      } catch {
        setQr('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, index, account, services]);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const nextUnused = () => {
    const used = account ? nextKeyIndicesOf(account)[kind] : 0;
    setIndices({ ...indices, [kind]: Math.max(used, index + 1) });
  };

  return (
    <Paper>
      <Stack>
        <Title order={3}>Receive</Title>
        <SegmentedControl
          fullWidth
          value={kind}
          onChange={(v) => setKind(v as KeyKind)}
          data={(Object.keys(KIND_LABELS) as KeyKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
        />
        <Text size="sm" c="dimmed">
          {KIND_NOTES[kind]}
        </Text>
        {qr && (
          <img
            src={qr}
            alt={`${KIND_LABELS[kind]} address QR code`}
            style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 'var(--mantine-radius-md)', background: '#fff' }}
          />
        )}
        <Text ff="monospace" size="sm" ta="center" style={{ wordBreak: 'break-all' }}>
          {abbreviateAddress(address)}
        </Text>
        <Group grow>
          <Button leftSection={copied ? <IconCheck size={16} stroke={1.8} /> : <IconCopy size={16} stroke={1.8} />} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="light" onClick={nextUnused}>
            Next unused
          </Button>
        </Group>
        <UnstyledButton onClick={() => setShowFull((v) => !v)} c="neptune.3" fz="sm" ta="center">
          {showFull ? 'Hide full address' : 'Show full address'}
        </UnstyledButton>
        {showFull && (
          <Code block style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {address}
          </Code>
        )}
        <Text size="xs" c="dimmed">
          {KIND_LABELS[kind]} address {index}. Funds sent to any of your addresses are found by the sync.
        </Text>
      </Stack>
    </Paper>
  );
}
