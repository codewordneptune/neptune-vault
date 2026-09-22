// Abbreviated address display, the same rule as neptune-wallet's
// to_bech32m_abbreviated: the human-readable prefix plus eight characters,
// three dots, and the last eight characters.

/**
 * An address short enough for one line of a list: the prefix, four
 * characters, an ellipsis, the last four. Enough to recognise an address
 * already known, which is all a list row is for; the detail shows more.
 */
export function shortAddress(address: string): string {
  const hrpLen = address.indexOf('1');
  if (hrpLen < 0 || address.length <= hrpLen + 1 + 4 + 4) return address;
  return `${address.slice(0, hrpLen + 5)}…${address.slice(-4)}`;
}

export function abbreviateAddress(address: string): string {
  const hrpLen = address.indexOf('1');
  if (hrpLen < 0) return address;
  const firstLen = hrpLen + 8;
  const lastLen = 8;
  if (address.length <= firstLen + lastLen) return address;
  return `${address.slice(0, firstLen)}…${address.slice(-lastLen)}`;
}

/**
 * The kind an address string belongs to, from its prefix: the label people
 * choose by (intent) and the protocol's own name (mechanism).
 */
export function addressKind(address: string): { intent: string; protocol: string } {
  const hrp = address.toLowerCase().slice(0, Math.max(address.indexOf('1'), 0));
  if (hrp.startsWith('nolga')) return { intent: 'Standard', protocol: 'Generation' };
  if (hrp.startsWith('nechvk')) return { intent: 'Viewing key', protocol: 'EC hybrid viewing key' };
  if (hrp.startsWith('nech')) return { intent: 'Short', protocol: 'EC hybrid' };
  if (hrp.startsWith('nview')) return { intent: 'View-only', protocol: 'Viewing' };
  if (hrp.startsWith('nolsym')) return { intent: 'Symmetric key', protocol: 'Symmetric' };
  return { intent: 'Unknown', protocol: 'unknown kind' };
}

/** "Standard (Generation)": intent first, mechanism in brackets. */
export function addressKindLabel(address: string): string {
  const k = addressKind(address);
  return k.protocol === 'unknown kind' ? 'Unknown kind' : `${k.intent} (${k.protocol})`;
}

export interface PaymentText {
  /** Lower-case address, or '' when the text is not usable. */
  address: string;
  /** Requested amount in NPT as written, when present and well-formed. */
  amount?: string;
  /** Payee name and payment description from the link, for the payer's eyes only. */
  label?: string;
  message?: string;
  /** Why the text was rejected, when it was. */
  error?: string;
}

/**
 * What a name or a note may not contain, in a link being read and in one
 * being made alike: C0 and C1 control characters, the line and paragraph
 * separators, and the bidirectional embeddings, overrides and isolates,
 * which can make text read as something other than what it says.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_META = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Percent-decoded once, `+` literal, at most 255 bytes; undefined when absent or unusable. */
function decodeMeta(value: string): string | undefined | null {
  if (value === '') return undefined;
  let text: string;
  try {
    text = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > 255) return null;
  // Control characters, line separators and bidirectional overrides have no
  // place in a name or a note: the same characters the link maker refuses
  // (metaProblem below), so a link cannot carry in what the app would not
  // let its own user type. Written as escapes: raw control bytes in this
  // line once made git treat the whole file as binary, and its diffs unreadable.
  if (FORBIDDEN_IN_META.test(text)) return null;
  return text === '' ? undefined : text;
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
  let label: string | undefined;
  let message: string | undefined;
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
      if (name === 'label' || name === 'message') {
        const decoded = decodeMeta(value);
        if (decoded === null) return { address: '', error: `The ${name === 'label' ? 'name' : 'note'} in the link is malformed` };
        // A value of only whitespace shows nothing; treat it as absent.
        const trimmed = (decoded ?? '').trim();
        if (trimmed !== '') {
          if (name === 'label') label = trimmed;
          else message = trimmed;
        }
      }
      // Unknown names are ignored.
    }
  }
  const checked = checkAddress(rest);
  return checked.error ? checked : { ...checked, amount, label, message };
}

function checkAddress(raw: string): PaymentText {
  if (raw === '') return { address: '', error: 'The link has no address' };
  if (!/^[A-Za-z0-9]+$/.test(raw)) return { address: '', error: 'The address contains invalid characters' };
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return { address: '', error: 'The address mixes upper and lower case' };
  return { address: raw.toLowerCase() };
}

/** A NIP-002 payment URI. `amount` must already be a conforming decimal. */
export function paymentUri(address: string, amount?: string, message?: string, label?: string): string {
  const params: string[] = [];
  if (amount) params.push(`amount=${amount}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  if (message) params.push(`message=${encodeURIComponent(message)}`);
  return `neptunecash:${address.toLowerCase()}${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * Why a label or message cannot go into a link, or null when it can: at most
 * 255 bytes of UTF-8, and none of the control and directional-formatting
 * characters NIP-002 forbids. Percent-encoding is the generator's job.
 */
export function metaProblem(text: string): string | null {
  if (new TextEncoder().encode(text).length > 255) return 'At most 255 bytes (about 250 letters)';
  if (FORBIDDEN_IN_META.test(text)) return 'Line breaks and control characters are not allowed';
  return null;
}

/**
 * The QR payload for a URI: scheme and address upper-cased so they take the
 * alphanumeric mode a generation address needs; the query, if any, stays as
 * written (it needs byte mode and only fits when the encoder segments).
 */
export function paymentQrPayload(address: string, amount?: string, message?: string, label?: string): string {
  const uri = paymentUri(address, amount, message, label);
  const query = uri.slice('neptunecash:'.length + address.length);
  return `NEPTUNECASH:${address.toUpperCase()}${query}`;
}
