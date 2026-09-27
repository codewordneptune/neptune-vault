// Text a person typed, made safe to show beside other text.

/**
 * Control characters, and the characters that change the direction or the
 * lines of the text around them: bidirectional marks, embeddings, overrides
 * and isolates, and the line and paragraph separators. A name holding one
 * could reorder the sentence it is shown in, next to an amount or an
 * address. Built from code points, so the source holds no invisible ones.
 */
const RANGES: [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];
const INVISIBLE = new RegExp(`[${RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** Such characters replaced by spaces, the spaces run together, and the ends trimmed. */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}
