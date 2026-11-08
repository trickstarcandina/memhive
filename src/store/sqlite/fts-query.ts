/** Turn free text into a safe FTS5 MATCH expression: each token quoted, joined by AND (implicit). */
export function toFtsQuery(text: string, op: ' ' | ' OR ' = ' '): string {
  return ftsTokens(text)
    .slice(0, 16)
    .map((t) => `"${t}"`)
    .join(op);
}
/** The distinct lowercase tokens FTS sees. NFC first: decomposed Vietnamese would otherwise split at combining marks (\p{M} is not in the class). */
export function ftsTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFC')
        .toLowerCase()
        .match(/[\p{L}\p{N}_]+/gu) ?? []
    ),
  ];
}
