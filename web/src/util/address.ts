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

/**
 * Normalise text scanned from a QR code or pasted: strips the payment URI
 * scheme (`npt:` or `NPT:`), lower-cases the bech32m address (upper case is
 * what QR codes carry), and reads an `amount` query parameter if present.
 */
export function parsePaymentText(text: string): { address: string; amount?: string } {
  let t = text.trim();
  if (/^npt:/i.test(t)) t = t.slice(4);
  let amount: string | undefined;
  const q = t.indexOf('?');
  if (q >= 0) {
    const params = new URLSearchParams(t.slice(q + 1));
    amount = params.get('amount') ?? undefined;
    t = t.slice(0, q);
  }
  return { address: t.toLowerCase(), amount };
}
