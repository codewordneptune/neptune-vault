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
