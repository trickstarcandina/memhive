/** Turn free text into a safe FTS5 MATCH expression: each token quoted, joined by AND (implicit). */
export function toFtsQuery(text: string): string {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniq = [...new Set(tokens)].slice(0, 16);
  return uniq.map((t) => `"${t}"`).join(' ');
}
