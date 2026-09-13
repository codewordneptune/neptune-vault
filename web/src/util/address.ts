// Abbreviated address display, the same rule as neptune-wallet's
// to_bech32m_abbreviated: the human-readable prefix plus eight characters,
// three dots, and the last eight characters.

export function abbreviateAddress(address: string): string {
  const hrpLen = address.indexOf('1');
  if (hrpLen < 0) return address;
  const firstLen = hrpLen + 8;
  const lastLen = 8;
  if (address.length <= firstLen + lastLen) return address;
  return `${address.slice(0, firstLen)}...${address.slice(-lastLen)}`;
}

/** Human label for the kind an address string belongs to, from its prefix. */
export function addressKindLabel(address: string): string {
  const hrp = address.toLowerCase().slice(0, Math.max(address.indexOf('1'), 0));
  if (hrp.startsWith('nolga')) return 'Generation';
  if (hrp.startsWith('nechvk')) return 'EC hybrid viewing key';
  if (hrp.startsWith('nech')) return 'EC hybrid';
  if (hrp.startsWith('nview')) return 'Viewing';
  if (hrp.startsWith('nolsym')) return 'Symmetric';
  return 'Unknown kind';
}

export interface PaymentText {
  /** Lower-case address, or '' when the text is not usable. */
  address: string;
  /** Requested amount in NPT as written, when present and well-formed. */
  amount?: string;
  /** Why the text was rejected, when it was. */
  error?: string;
}

const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,32})?$/;
const RESERVED = new Set(['address', 'reference', 'memo']);

/**
 * Text scanned from a QR code or pasted, per NIP-002: a `neptunecash:`
 * payment URI (scheme case-insensitive, address literal and single-case,
 * optional `amount`, `label` and `message` ignored here, reserved names
 * rejected), the legacy address-only `npt:` payload, or a bare address.
 */
export function parsePaymentText(text: string): PaymentText {
  const t = text.trim();
  if (t === '') return { address: '', error: 'Nothing to read' };
  if (/\s/.test(t)) return { address: '', error: 'The link contains whitespace; it may have been wrapped in transport' };
  const colon = t.indexOf(':');
  const scheme = colon >= 0 ? t.slice(0, colon).toLowerCase() : null;
  let rest = colon >= 0 ? t.slice(colon + 1) : t;

  if (scheme === 'npt') {
    // Legacy wallet payload: address only, never a query.
    if (rest.includes('?')) return { address: '', error: 'Not a payment link: an NPT: payload cannot carry parameters' };
    return checkAddress(rest);
  }
  if (scheme !== null && scheme !== 'neptunecash') return { address: '', error: `Unknown link type "${scheme}"` };
  if (rest.includes('#')) return { address: '', error: 'The link is malformed' };

  let amount: string | undefined;
  const q = rest.indexOf('?');
  if (q >= 0) {
    const query = rest.slice(q + 1);
    rest = rest.slice(0, q);
    const seen = new Set<string>();
    for (const part of query === '' ? [] : query.split('&')) {
      const eq = part.indexOf('=');
      const name = eq >= 0 ? part.slice(0, eq) : part;
      const value = eq >= 0 ? part.slice(eq + 1) : '';
      if (!/^[a-z0-9._~-]+$/.test(name)) return { address: '', error: `Invalid parameter "${name}"` };
      if (seen.has(name)) return { address: '', error: `Repeated parameter "${name}"` };
      seen.add(name);
      if (RESERVED.has(name) || /^(address|amount)\.[0-9]+$/.test(name)) return { address: '', error: `Unsupported parameter "${name}"` };
      if (name.startsWith('req-')) return { address: '', error: `This wallet does not support the required extension "${name}"` };
      if (name === 'amount') {
        if (!AMOUNT_RE.test(value)) return { address: '', error: 'The requested amount is not valid' };
        amount = value;
      }
      // label and message are for the payer's eyes only; unknown names are ignored.
    }
  }
  const checked = checkAddress(rest);
  return checked.error ? checked : { ...checked, amount };
}

function checkAddress(raw: string): PaymentText {
  if (raw === '') return { address: '', error: 'The link has no address' };
  if (!/^[A-Za-z0-9]+$/.test(raw)) return { address: '', error: 'The address contains invalid characters' };
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return { address: '', error: 'The address mixes upper and lower case' };
  return { address: raw.toLowerCase() };
}

/** A NIP-002 payment URI. `amount` must already be a conforming decimal. */
export function paymentUri(address: string, amount?: string): string {
  return `neptunecash:${address.toLowerCase()}${amount ? `?amount=${amount}` : ''}`;
}

/**
 * The QR payload for a URI: scheme and address upper-cased so they take the
 * alphanumeric mode a generation address needs; the query, if any, stays as
 * written (it needs byte mode and only fits when the encoder segments).
 */
export function paymentQrPayload(address: string, amount?: string): string {
  return `NEPTUNECASH:${address.toUpperCase()}${amount ? `?amount=${amount}` : ''}`;
}
