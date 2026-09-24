// Amounts as people type them. A coin divides much further than any screen
// shows it, and every screen shows at most eight decimals. An amount typed
// with more would be sent in full while the review, the confirmation and
// the history all show it cut to eight: so eight is where typing stops too,
// and what is reviewed is exactly what is sent.

/** The most decimals an amount may be typed with: as many as the app shows. */
export const MAX_DECIMALS = 8;

/** Why a typed amount has too many decimals, or null. Grouping spaces are ignored. */
export function decimalsProblem(text: string): string | null {
  const plain = text.replace(/[\s  ]/g, '');
  const dot = plain.indexOf('.');
  if (dot < 0 || plain.length - dot - 1 <= MAX_DECIMALS) return null;
  return `Use at most ${MAX_DECIMALS} decimals, for example 1.12345678`;
}
