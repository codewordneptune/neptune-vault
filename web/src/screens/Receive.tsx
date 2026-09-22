// Receiving (F11): the address of each kind as text and QR code, and a
// payment request (NIP-002 link with amount, name and note) with its own
// code. Two tabs, because the address code and the request code must never
// be mistaken for one another. Key 0 of a kind is its main address; "next
// unused" derives the next key of that kind.

import { ActionIcon, Button, Group, Paper, SegmentedControl, Stack, Tabs, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconArrowsMaximize, IconChevronDown, IconCopy, IconShare } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { QrFullScreen } from '../components/QrFullScreen';
import { Caution, Info } from '../components/Notice';

import { formatNau, useApp } from '../app/AppContext';
import { nextKeyIndicesOf } from '../storage/db';
import { abbreviateAddress, metaProblem, paymentQrPayload, paymentUri } from '../util/address';
import { copyText } from '../util/clipboard';
import { KEY_LOOKAHEAD, type KeyKind } from '../backend/types';

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
// What the chosen kind means for whoever gets it; shown under both tabs,
// since a request carries the same address as the bare code.
const KIND_NOTES: Record<KeyKind, string> = {
  generation: 'Safe to reuse and the most private: the default for anything you publish.',
  ec_hybrid:
    'Easy to share by message. Give each one to a single sender: if reused widely, a future quantum attacker could reveal, but never spend, the funds sent to it.',
  viewing:
    'For auditing: anyone holding this address can see every payment it receives, though never spend them. Share it only with someone you trust to see that activity.',
};

// About the code for a kind of address, under both tabs: a request code
// carries the same address and more, so it is at least as dense. What does
// not fit in a request code has its own note.
const CODE_HINTS: Partial<Record<KeyKind, string>> = {
  generation: 'The code is dense: scan from close up, or copy the address instead.',
};

// The note's shape says how much care the kind needs: plain text for
// Standard, which only reassures; text with an info mark for Short, which
// asks for one sender per address; a caution for View-only, whose exposure
// cannot be taken back.
function KindNote({ kind, extra }: { kind: KeyKind; extra?: string }) {
  const text = extra ? `${KIND_NOTES[kind]} ${extra}` : KIND_NOTES[kind];
  if (kind === 'generation') {
    return (
      <Text size="sm" c="dimmed">
        {text}
      </Text>
    );
  }
  return kind === 'viewing' ? <Caution>{text}</Caution> : <Info>{text}</Info>;
}

// A code on the card, like a printed one: the white runs on below it into a
// slim footer that says it opens full screen. The hint sits under the code,
// never on it: a Standard address makes a code so dense that covering any
// of it can stop a camera reading it.
function QrCode({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  return (
    <UnstyledButton onClick={onOpen} aria-label="Show the QR code full screen" className="vault-receive-col vault-qr-code">
      <img src={src} alt={alt} />
      <span className="vault-qr-foot" aria-hidden>
        <IconArrowsMaximize size={14} stroke={2} />
        {/* The word for how this device is used: a tap on a phone, a click with a mouse. */}
        <span className="vault-qr-foot-touch">Tap to enlarge</span>
        <span className="vault-qr-foot-mouse">Click to enlarge</span>
      </span>
    </UnstyledButton>
  );
}

type Tab = 'address' | 'request';

const QR_OPTIONS = { type: 'image/png' as const, width: 1200, margin: 2, errorCorrectionLevel: 'L' as const };

export function Receive() {
  const { services, account, refresh } = useApp();
  const [tab, setTab] = useState<Tab>('address');
  const [kind, setKind] = useState<KeyKind>('generation');
  const [indices, setIndices] = useState<Record<KeyKind, number>>({ generation: 0, ec_hybrid: 0, viewing: 0 });
  const [address, setAddress] = useState<string>(account?.address0 ?? '');
  const [qr, setQr] = useState<string>('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  // Which code, if any, is shown as large as the screen allows.
  const [enlarged, setEnlarged] = useState<'address' | 'request' | null>(null);
  const index = indices[kind];

  // The request: amount, name and note. They belong to this visit of the
  // screen: kept while switching tabs, gone when the screen is left.
  const [requestAmount, setRequestAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  // The requested amount as a conforming NIP-002 decimal (from nau, so
  // "1,5" or ".5" never reach the link), or undefined when none is asked.
  const [linkAmount, setLinkAmount] = useState<string | undefined>(undefined);
  // The name the sender sees as the link's label, and a note for the sender
  // (the link's message): shown on their review and kept with their send,
  // never reaching this wallet.
  const [requestLabel, setRequestLabel] = useState('');
  const labelError = requestLabel.trim() ? metaProblem(requestLabel.trim()) : null;
  const [requestNote, setRequestNote] = useState('');
  const noteError = requestNote.trim() ? metaProblem(requestNote.trim()) : null;
  const linkLabel = labelError ? undefined : requestLabel.trim() || undefined;
  const linkNote = noteError ? undefined : requestNote.trim() || undefined;
  const paymentLink = paymentUri(address, linkAmount, linkNote, linkLabel);
  const [requestQr, setRequestQr] = useState('');
  const [requestQrNote, setRequestQrNote] = useState<string | null>(null);

  // Validate the request amount through the wallet core and normalise it.
  useEffect(() => {
    let cancelled = false;
    // A pasted grouped value is fine; spaces are grouping.
    const text = requestAmount.replace(/[\s  ]/g, '');
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

  // The address of the chosen kind and index, and its code: the address
  // alone. Scheme and address are upper-cased for the alphanumeric mode a
  // generation address needs. A PNG, not an SVG: a long press on a phone
  // saves the image, and galleries and downloaders handle PNG everywhere
  // while an SVG data URL often arrives as a broken file. 1200 px keeps a
  // version-40 code (177 modules) at about 7 px per module.
  useEffect(() => {
    let cancelled = false;
    // The old address and code go at once: nobody must copy or scan the
    // previous kind believing it is the one just chosen.
    setAddress('');
    setQr('');
    setAddressError(null);
    void (async () => {
      try {
        // Always from the keys, the main address included. The copy kept in
        // the database is there for screens shown while locked; it is not
        // protected by anything, and an address shown here is one people pay
        // to. If the two ever differ the keys are right, and the copy is mended.
        const a = await services.core.address(kind, index);
        if (cancelled) return;
        if (kind === 'generation' && index === 0 && account && account.address0 !== a) void services.accounts.repairAddress0(account.id, a).then(refresh);
        setAddress(a);
        try {
          setQr(await QRCode.toDataURL(paymentQrPayload(a), QR_OPTIONS));
        } catch {
          setQr('');
        }
      } catch (e) {
        if (!cancelled) setAddressError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, index, account, services]);

  // The request's code carries the whole link when it fits; otherwise as
  // much as fits, with a line saying what the link still carries.
  useEffect(() => {
    if (tab !== 'request' || !address) return;
    let cancelled = false;
    void (async () => {
      const render = async (payload: string) => {
        const url = await QRCode.toDataURL(payload, QR_OPTIONS);
        if (!cancelled) setRequestQr(url);
      };
      const withText = Boolean(linkNote || linkLabel);
      try {
        await render(paymentQrPayload(address, linkAmount, linkNote, linkLabel));
        setRequestQrNote(null);
      } catch {
        try {
          await render(paymentQrPayload(address, linkAmount));
          setRequestQrNote(withText ? 'The name and note do not fit in the code for this address; the link carries them.' : null);
        } catch {
          try {
            await render(paymentQrPayload(address));
            setRequestQrNote(linkAmount || withText ? 'The amount, name and note do not fit in the code for this address; the link carries them.' : null);
          } catch {
            setRequestQr('');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, address, linkAmount, linkNote, linkLabel]);

  const copy = () => void copyText(address, 'Address copied');
  // Where the system share sheet exists, the address can go straight into a
  // message; where it does not, Share would only copy, which Copy already does.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const shareAddress = async () => {
    try {
      await navigator.share({ text: address });
    } catch {
      // Cancelled by the user; nothing to report.
    }
  };

  // The system share sheet where it exists; otherwise the link is copied.
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ text: paymentLink });
      } catch {
        // Cancelled by the user; nothing to report.
      }
    } else {
      await copyText(paymentLink, linkAmount ? 'Payment request copied' : 'Payment link copied');
    }
  };

  // The sync looks for payments on every address up to a few past the
  // newest one that has received something. An address further out would
  // never be looked at, and a payment to it never found, so none is offered.
  const used = account ? nextKeyIndicesOf(account)[kind] : 0;
  const furthest = used + KEY_LOOKAHEAD;
  const nextUnused = () => {
    setIndices({ ...indices, [kind]: Math.min(furthest, Math.max(used, index + 1)) });
  };
  useEffect(() => {
    if (index > furthest) setIndices((all) => ({ ...all, [kind]: furthest }));
  }, [index, furthest, kind]);

  const requestInvalid = Boolean(amountError || noteError || labelError);
  // Said only once another address than the main one is showing: on the main
  // address the kind selector above already says what it is, and the worry
  // this answers (will a new address work?) has not come up.
  const rotationNote =
    index === 0
      ? null
      : `${tab === 'address' ? '' : 'The request is to '}${KIND_LABELS[kind]} address ${index}. ` +
        (index >= furthest ? 'More addresses open up once one of these has received a payment.' : 'Payments to it arrive in this wallet like any other.');

  return (
    <Paper>
      <Stack>
        <Title order={2} className="sr-only">
          Receive
        </Title>
        <SegmentedControl
          aria-label="Address kind"
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
        <Tabs value={tab} onChange={(v) => setTab((v as Tab) ?? 'address')} className="vault-tabs" keepMounted={false}>
          <Tabs.List grow>
            <Tabs.Tab value="address">Address</Tabs.Tab>
            <Tabs.Tab value="request">Request payment</Tabs.Tab>
          </Tabs.List>
        </Tabs>

        {tab === 'address' && (
          <>
            {qr && <QrCode src={qr} alt={`${KIND_LABELS[kind]} address QR code`} onOpen={() => setEnlarged('address')} />}
            {/* The address as one object that opens: shortened, and in full
                inside the same box once its chevron (or the box) is tapped. */}
            <div
              className="vault-receive-col vault-address-box"
              onClick={() => {
                // A drag that selected part of the address is not a tap.
                if (address && !window.getSelection()?.toString()) setShowFull((v) => !v);
              }}
            >
              <span className={showFull ? 'vault-address-text full' : 'vault-address-text'}>
                {address ? (showFull ? address : abbreviateAddress(address)) : addressError ? 'No address' : 'Deriving the address…'}
              </span>
              {address && (
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  className="vault-tap vault-address-toggle"
                  aria-label={showFull ? 'Show the address shortened' : 'Show the full address'}
                  aria-expanded={showFull}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFull((v) => !v);
                  }}
                >
                  <IconChevronDown size={18} stroke={1.8} className={showFull ? 'vault-chevron open' : 'vault-chevron'} />
                </ActionIcon>
              )}
            </div>
            {addressError && (
              <Text size="sm" c="red">
                Could not derive this address: {addressError}
              </Text>
            )}
            <Group grow className="vault-receive-col">
              <Button leftSection={<IconCopy size={16} stroke={1.8} />} onClick={copy} disabled={!address}>
                Copy address
              </Button>
              {canShare && (
                <Button variant="light" leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void shareAddress()} disabled={!address}>
                  Share
                </Button>
              )}
            </Group>
            <KindNote kind={kind} extra={CODE_HINTS[kind]} />
          </>
        )}

        {tab === 'request' && (
          <>
            <TextInput
              label="Amount (NPT, optional)"
              inputMode="decimal"
              value={requestAmount}
              onChange={(e) => setRequestAmount(e.currentTarget.value)}
              error={amountError}
            />
            <TextInput
              label="Your name (optional)"
              description="Shown to the sender as an unverified name."
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
            {/* The code, then what to do with it: the same order as the Address tab. */}
            {requestQr && !requestInvalid && <QrCode src={requestQr} alt="Payment request QR code" onOpen={() => setEnlarged('request')} />}
            {requestQrNote && !requestInvalid && (
              <Text size="sm" c="dimmed" className="vault-receive-col">
                {requestQrNote}
              </Text>
            )}
            <Group grow className="vault-receive-col">
              <Button variant="light" leftSection={<IconCopy size={16} stroke={1.8} />} onClick={() => void copyText(paymentLink, linkAmount ? 'Payment request copied' : 'Payment link copied')} disabled={requestInvalid}>
                Copy link
              </Button>
              <Button leftSection={<IconShare size={16} stroke={1.8} />} onClick={() => void share()} disabled={requestInvalid}>
                Share
              </Button>
            </Group>
            <KindNote kind={kind} extra={CODE_HINTS[kind]} />
          </>
        )}

        {/* The sentence about the address showing, then what can be done about it, on the line beneath. */}
        <Stack gap={4}>
          {rotationNote && (
            <Text size="sm" c="dimmed">
              {rotationNote}
            </Text>
          )}
          <Group gap={6} wrap="nowrap">
            {index > 0 && (
              <UnstyledButton onClick={() => setIndices({ ...indices, [kind]: 0 })} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start">
                Main address
              </UnstyledButton>
            )}
            {index > 0 && index < furthest && (
              <Text span size="sm" c="dimmed" aria-hidden>
                ·
              </Text>
            )}
            {index < furthest && (
              <UnstyledButton onClick={nextUnused} c="var(--v-accent-text)" fz="sm" className={index > 0 ? 'vault-tap-link' : 'vault-tap-link vault-tap-link-start'}>
                New address
              </UnstyledButton>
            )}
          </Group>
        </Stack>
        <QrFullScreen
          opened={enlarged !== null && Boolean(enlarged === 'request' ? requestQr : qr)}
          onClose={() => setEnlarged(null)}
          src={enlarged === 'request' ? requestQr : qr}
          // The name people choose by as the title, and the protocol's own on a
          // quieter line beneath, for checking against another wallet or the node.
          title={enlarged === 'request' ? 'Payment request' : `${KIND_LABELS[kind]} address`}
          subtitle={enlarged === 'request' ? `${KIND_LABELS[kind]} address · ${KIND_PROTOCOL[kind]}` : KIND_PROTOCOL[kind]}
          // The title says what kind of address it is; under the code goes the
          // address itself, and for a request the amount asked for above it.
          caption={`${enlarged === 'request' && linkAmount ? `${linkAmount} NPT
` : ''}${address ? abbreviateAddress(address) : ''}`}
        />
      </Stack>
    </Paper>
  );
}
