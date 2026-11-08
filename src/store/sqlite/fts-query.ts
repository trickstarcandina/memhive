/** Turn free text into a safe FTS5 MATCH expression: each token quoted, joined by AND (implicit). */
export function toFtsQuery(text: string): string {
  // NFC first: decomposed Vietnamese would otherwise split at combining marks (\p{M} is not in the class).
  const tokens = text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniq = [...new Set(tokens)].slice(0, 16);
  return uniq.map((t) => `"${t}"`).join(' ');
}
