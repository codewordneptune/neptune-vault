// Receiving address as text and QR code (F11), for each of the three address
// kinds. Key 0 of a kind is its main address; "next unused" derives the next
// key of that kind.

import { Button, Code, Group, Modal, Paper, SegmentedControl, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconCopy, IconShare } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { formatNau, useApp } from '../app/AppContext';
import { nextKeyIndicesOf } from '../storage/db';
import { abbreviateAddress, paymentQrPayload, paymentUri } from '../util/address';
import { copyText } from '../util/clipboard';
import type { KeyKind } from '../wallet/core';

// Labelled by what the address is for; the protocol name is the caption.
const KIND_LABELS: Record<KeyKind, string> = {
  generation: 'Standard',
  ec_hybrid: 'Short',
  viewing: 'View-only',
};
const KIND_PROTOCOL: Record<KeyKind, string> = {
  generation: 'Generation',
  ec_hybrid: 'EC hybrid',
  viewing: 'Viewing',
};

// Same guidance as the desktop wallet gives on its addresses page.
const KIND_NOTES: Record<KeyKind, string> = {
  generation:
    'Safe to reuse and the most private: the default for anything you publish. The code is dense: scan from close up, or copy the address instead.',
  ec_hybrid:
    'Easy to share by message. Give each one to a single payer: if reused widely, a future quantum attacker could reveal, but never spend, the funds sent to it.',
  viewing:
    'For auditing: anyone holding this address can see every payment it receives, though never spend them. Share it only with someone you trust to see that activity.',
};

export function Receive() {
  const { services, account } = useApp();
  const [kind, setKind] = useState<KeyKind>('generation');
  const [indices, setIndices] = useState<Record<KeyKind, number>>({ generation: 0, ec_hybrid: 0, viewing: 0 });
  const [address, setAddress] = useState<string>(account?.address0 ?? '');
  const [qr, setQr] = useState<string>('');
  const [showFull, setShowFull] = useState(false);
  // Optional amount for a payment request; the link follows NIP-2 (npt:).
  const [requestAmount, setRequestAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [qrNote, setQrNote] = useState<string | null>(null);
  // The requested amount as a conforming NIP-002 decimal (from nau, so
  // "1,5" or ".5" never reach the link), or undefined when none is asked.
  const [linkAmount, setLinkAmount] = useState<string | undefined>(undefined);
  const paymentLink = paymentUri(address, linkAmount);

  // Validate the request amount through the wallet core and normalise it.
  useEffect(() => {
    let cancelled = false;
    const text = requestAmount.trim();
    if (text === '') {
      setLinkAmount(undefined);
      setAmountError(null);
      return;
    }
    void (async () => {
      try {
        const nau = BigInt(await services.core.parseAmount(text));
        if (cancelled) return;
        if (nau <= 0n) {
          setAmountError('The amount must be greater than zero');
          setLinkAmount(undefined);
        } else {
          setAmountError(null);
          setLinkAmount(formatNau(nau));
        }
      } catch {
        if (!cancelled) {
          setAmountError('Enter a number, such as 1.5');
          setLinkAmount(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestAmount, services]);
  const index = indices[kind];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = kind === 'generation' && index === 0 && account ? account.address0 : await services.core.address(kind, index);
      if (cancelled) return;
      setAddress(a);
      // The QR carries the complete NIP-002 URI. Scheme and address are
      // upper-cased for the alphanumeric mode a generation address needs;
      // a query needs byte mode, and when the amount does not fit the code
      // falls back to the address-only URI and the link carries the amount.
      const render = async (payload: string) => {
        const svg = await QRCode.toString(payload, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
        setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      };
      try {
        await render(paymentQrPayload(a, linkAmount));
        setQrNote(null);
      } catch {
        try {
          await render(paymentQrPayload(a));
          setQrNote(linkAmount ? 'The amount does not fit in the code for this address; the shared link carries it.' : null);
        } catch {
          setQr('');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, index, account, services, linkAmount]);

  const copy = () => void copyText(address, 'Address copied');

  // The system share sheet where it exists; otherwise the link is copied.
  const share = async () => {
    setSharing(false);
    const text = paymentLink;
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        // Cancelled by the user; nothing to report.
      }
    } else {
      await copyText(text, linkAmount ? 'Payment request copied' : 'Payment link copied');
    }
  };

  const nextUnused = () => {
    const used = account ? nextKeyIndicesOf(account)[kind] : 0;
    setIndices({ ...indices, [kind]: Math.max(used, index + 1) });
  };

  return (
    <Paper>
      <Stack>
        <Title order={2} className="sr-only">
          Receive
        </Title>
        <SegmentedControl
          fullWidth
          value={kind}
          onChange={(v) => setKind(v as KeyKind)}
          data={(Object.keys(KIND_LABELS) as KeyKind[]).map((k) => ({
            value: k,
            label: (
              <span className="vault-fee-seg">
                <span>{KIND_LABELS[k]}</span>
                <small>{KIND_PROTOCOL[k]}</small>
              </span>
            ),
          }))}
        />
        <Text size="sm" c="dimmed">
          {KIND_NOTES[kind]}
        </Text>
        {qrNote && (
          <Text size="xs" c="dimmed">
            {qrNote}
          </Text>
        )}
        {qr && (
          <img
            src={qr}
            alt={`${KIND_LABELS[kind]} address QR code`}
            style={{ width: '100%', height: 'auto', display: 'block', background: '#fff' }}
          />
        )}
        <Text ff="monospace" size="sm" ta="center" style={{ wordBreak: 'break-all' }}>
          {abbreviateAddress(address)}
        </Text>
        <Group grow>
          <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={copy}>
            Copy
          </Button>
          <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => setSharing(true)}>
            Share
          </Button>
        </Group>
        <Modal opened={sharing} onClose={() => setSharing(false)} title="Share a payment link">
          <Stack>
            <TextInput
              label="Amount to request (NPT, optional)"
              description="Goes into the link and, where it fits, the QR code, so the payer's wallet fills it in."
              inputMode="decimal"
              value={requestAmount}
              onChange={(e) => setRequestAmount(e.currentTarget.value)}
              error={amountError}
              autoFocus
            />
            <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
              {abbreviateAddress(paymentLink)}
            </Text>
            <Group grow>
              <Button variant="light" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(paymentLink, linkAmount ? 'Payment request copied' : 'Payment link copied')} disabled={Boolean(amountError)}>
                Copy link
              </Button>
              <Button leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void share()} disabled={Boolean(amountError)}>
                Share
              </Button>
            </Group>
          </Stack>
        </Modal>
        <UnstyledButton onClick={() => setShowFull((v) => !v)} c="var(--v-accent-text)" fz="sm" ta="center">
          {showFull ? 'Hide full address' : 'Show full address'}
        </UnstyledButton>
        {showFull && (
          <Code block style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {address}
          </Code>
        )}
        <Group justify="space-between" align="baseline">
          <Text size="xs" c="dimmed">
            {index === 0 ? `Your main ${KIND_LABELS[kind]} address` : `${KIND_LABELS[kind]} address ${index}`}. Funds sent to any of your addresses are found by the sync.
          </Text>
          <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
            {index > 0 && (
              <UnstyledButton onClick={() => setIndices({ ...indices, [kind]: 0 })} c="var(--v-accent-text)" fz="xs">
                Main address
              </UnstyledButton>
            )}
            <UnstyledButton onClick={nextUnused} c="var(--v-accent-text)" fz="xs">
              Next unused
            </UnstyledButton>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
