// Receiving address as text and QR code (F11), for each of the three address
// kinds. Key 0 of a kind is its main address; "next unused" derives the next
// key of that kind.

import { Button, Code, Group, Modal, Paper, SegmentedControl, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconCopy, IconReceipt, IconShare } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { formatNau, useApp } from '../app/AppContext';
import { nextKeyIndicesOf } from '../storage/db';
import { abbreviateAddress, metaProblem, paymentQrPayload, paymentUri } from '../util/address';
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
    'Easy to share by message. Give each one to a single sender: if reused widely, a future quantum attacker could reveal, but never spend, the funds sent to it.',
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
  // A note for the sender: the link's message. It is shown on their review
  // screen and kept with their send; it never reaches this wallet.
  const [requestNote, setRequestNote] = useState('');
  const noteError = requestNote.trim() ? metaProblem(requestNote.trim()) : null;
  // The name the sender sees as the link's label. Like the amount and the
  // note it belongs to one request and is cleared with the dialog.
  const [requestLabel, setRequestLabel] = useState('');
  const labelError = requestLabel.trim() ? metaProblem(requestLabel.trim()) : null;
  const linkNote = noteError ? undefined : requestNote.trim() || undefined;
  const linkLabel = labelError ? undefined : requestLabel.trim() || undefined;
  const paymentLink = paymentUri(address, linkAmount, linkNote, linkLabel);

  // Validate the request amount through the wallet core and normalise it.
  useEffect(() => {
    let cancelled = false;
    const text = requestAmount.replace(/[s  ]/g, '');
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
      // Scheme and address are upper-cased for the alphanumeric mode a
      // generation address needs. A PNG, not an SVG: a long press on a phone saves the image, and
      // galleries and downloaders handle PNG everywhere while an SVG data
      // URL often arrives as a broken file. 1200 px keeps a version-40 code
      // (177 modules) at about 7 px per module, more than any screen shows.
      const render = async (payload: string) => {
        setQr(await QRCode.toDataURL(payload, { type: 'image/png', width: 1200, margin: 2, errorCorrectionLevel: 'L' }));
      };
      // The page shows the address alone; a request with amount, name or
      // note has its own code inside the request dialog.
      try {
        await render(paymentQrPayload(a));
      } catch {
        setQr('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, index, account, services]);

  // The request dialog's code carries the whole link when it fits; otherwise
  // as much as fits, with a line saying what the shared link still carries.
  const [requestQr, setRequestQr] = useState('');
  useEffect(() => {
    if (!sharing || !address) return;
    let cancelled = false;
    void (async () => {
      const render = async (payload: string) => {
        const url = await QRCode.toDataURL(payload, { type: 'image/png', width: 1200, margin: 2, errorCorrectionLevel: 'L' });
        if (!cancelled) setRequestQr(url);
      };
      const withText = Boolean(linkNote || linkLabel);
      try {
        await render(paymentQrPayload(address, linkAmount, linkNote, linkLabel));
        setQrNote(null);
      } catch {
        try {
          await render(paymentQrPayload(address, linkAmount));
          setQrNote(withText ? 'The name and note do not fit in the code for this address; the link carries them.' : null);
        } catch {
          try {
            await render(paymentQrPayload(address));
            setQrNote(linkAmount || withText ? 'The amount, name and note do not fit in the code for this address; the link carries them.' : null);
          } catch {
            setRequestQr('');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sharing, address, linkAmount, linkNote, linkLabel]);

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
          <Button variant="light" leftSection={<IconReceipt size={16} stroke={1.8} />} onClick={() => setSharing(true)}>
            Request payment
          </Button>
        </Group>
        <Modal
          opened={sharing}
          onClose={() => {
            // A request lives and dies with its dialog.
            setSharing(false);
            setRequestAmount('');
            setRequestLabel('');
            setRequestNote('');
          }}
          title="Request a payment"
        >
          <Stack>
            <TextInput
              label="Amount to request (NPT, optional)"
              description="The sender's wallet fills it in."
              inputMode="decimal"
              value={requestAmount}
              onChange={(e) => setRequestAmount(e.currentTarget.value)}
              error={amountError}
              autoFocus
            />
            <TextInput
              label="Your name, shown to the sender (optional)"
              description="Travels in the link; the sender's wallet shows it as an unverified name."
              value={requestLabel}
              onChange={(e) => setRequestLabel(e.currentTarget.value)}
              error={labelError}
              maxLength={255}
            />
            <TextInput
              label="Note for the sender (optional)"
              description="Shown to the sender only; it does not reach you."
              value={requestNote}
              onChange={(e) => setRequestNote(e.currentTarget.value)}
              error={noteError}
              maxLength={255}
            />
            {requestQr && (
              <img src={requestQr} alt="Payment request QR code" style={{ width: '100%', height: 'auto', display: 'block', background: '#fff' }} />
            )}
            {qrNote && (
              <Text size="xs" c="dimmed">
                {qrNote}
              </Text>
            )}
            <Group grow>
              <Button variant="light" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(paymentLink, linkAmount ? 'Payment request copied' : 'Payment link copied')} disabled={Boolean(amountError || noteError || labelError)}>
                Copy link
              </Button>
              <Button leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void share()} disabled={Boolean(amountError || noteError || labelError)}>
                Share
              </Button>
            </Group>
          </Stack>
        </Modal>
        <UnstyledButton onClick={() => setShowFull((v) => !v)} c="var(--v-accent-text)" fz="sm" ta="center" className="vault-tap-link" style={{ justifyContent: 'center' }}>
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
              <UnstyledButton onClick={() => setIndices({ ...indices, [kind]: 0 })} c="var(--v-accent-text)" fz="xs" className="vault-tap-link">
                Main address
              </UnstyledButton>
            )}
            <UnstyledButton onClick={nextUnused} c="var(--v-accent-text)" fz="xs" className="vault-tap-link">
              Next unused
            </UnstyledButton>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
