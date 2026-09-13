// Receiving address as text and QR code (F11). Key 0 is the account's main
// address; "next unused" derives the next generation key.

import { Button, Code, Group, Paper, Stack, Text, Title } from '@mantine/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { useApp } from '../app/AppContext';

export function Receive() {
  const { services, account } = useApp();
  const [index, setIndex] = useState(0);
  const [address, setAddress] = useState<string>(account?.address0 ?? '');
  const [qr, setQr] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = index === 0 && account ? account.address0 : await services.core.address(index);
      if (cancelled) return;
      setAddress(a);
      // Generation addresses are about 2900 characters. Upper-case bech32m is
      // still valid and fits the QR alphanumeric mode (4296 chars at level L),
      // where mixed case would overflow the byte mode.
      try {
        setQr(await QRCode.toDataURL(a.toUpperCase(), { margin: 1, width: 240, errorCorrectionLevel: 'L' }));
      } catch {
        setQr('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, account, services]);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Paper withBorder p="md">
      <Stack align="center">
        <Title order={3}>Receive</Title>
        {qr && <img src={qr} alt="address QR code" width={240} height={240} />}
        <Code block style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {address}
        </Code>
        <Group>
          <Button onClick={copy}>{copied ? 'Copied' : 'Copy address'}</Button>
          <Button variant="light" onClick={() => setIndex((i) => Math.max(0, account ? account.nextKeyIndex : 1, i + 1))}>
            Next unused address
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Address {index}. Funds sent to any of your addresses are found by the sync.
        </Text>
      </Stack>
    </Paper>
  );
}
