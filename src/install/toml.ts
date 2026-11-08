import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

/** Drops a trailing comment, ignoring '#' inside single- or double-quoted strings. */
function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}
const headerKey = (line: string) => { const m = stripComment(line).trim().match(/^\[([^\]]+)\]$/); return m ? m[1].replace(/\s+/g, '') : null; };

// shortcut: line-based edit (keeps bytes); multi-line strings/arrays are not tracked, so callers must use setTomlBooleanChecked.
export function setTomlBoolean(content: string, tableHeader: string, key: string, value: boolean): string {
  const want = headerKey(tableHeader)!;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';   // keep the file's line endings
  const line = `${key} = ${value ? 'true' : 'false'}`;   // lines are split on \n only, so each keeps its own trailing \r
  const lines = content.split('\n');
  const start = lines.findIndex((l) => headerKey(l) === want);
  if (start === -1) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${trimmed ? eol + eol : ''}${tableHeader}${eol}${line}${eol}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const idx = lines.findIndex((l, i) => i > start && i < end && re.test(stripComment(l)));
  const cr = (l: string) => (l.endsWith('\r') ? '\r' : '');
  if (idx !== -1) lines[idx] = line + cr(lines[idx]);
  else if (start === lines.length - 1) { lines[start] += eol === '\r\n' && !cr(lines[start]) ? '\r' : ''; lines.push(line); }   // header was the last line, with no EOL
  else lines.splice(start + 1, 0, line + cr(lines[start]));
  return lines.join('\n');
}

export function hasTomlTable(content: string, tableHeader: string): boolean {
  const want = headerKey(tableHeader);
  return content.split('\n').some((l) => headerKey(l) === want);
}

/** Line-based edit, then verified with a real TOML parser. Throws instead of returning a file that is invalid or lacks the intended value. */
export function setTomlBooleanChecked(content: string, tableHeader: string, key: string, value: boolean): string {
  let before: Record<string, unknown> = {};
  if (content.trim()) { try { before = parse(content); } catch (e) { throw new Error(`existing TOML does not parse: ${(e as Error).message}`); } }
  const out = setTomlBoolean(content, tableHeader, key, value);
  let parsed: unknown;
  try { parsed = parse(out); } catch (e) { throw new Error(`edited TOML would not parse (dotted/inline form?): ${(e as Error).message}`); }
  // The line edit can land inside a multi-line string that holds a "[table]" line: the file still parses, but some
  // other value changed. Everything except the target key must be as before.
  const path = [...headerPath(tableHeader), key];
  if (!isDeepStrictEqual(without(parsed, path), without(before, path))) throw new Error(`edited TOML would change more than ${key} (a multi-line string holding ${tableHeader}?)`);
  // Walk the path the header names: parse "<header>\nk = v" and follow its single-key chain.
  let want: unknown = parse(`${tableHeader}\n${key} = ${value}`);
  while (want && typeof want === 'object') {
    const [k] = Object.keys(want);
    const wv = (want as Record<string, unknown>)[k];
    parsed = (parsed as Record<string, unknown> | undefined)?.[k];
    if (typeof wv !== 'object') { if (parsed !== wv) throw new Error(`edited TOML does not have ${key} = ${value}`); return out; }
    want = wv;
  }
  return out;
}

const headerPath = (tableHeader: string): string[] => {
  const path: string[] = []; let o: unknown = parse(`${tableHeader}\n__k = 1`);
  while (o && typeof o === 'object') { const [k] = Object.keys(o); if (k === '__k') break; path.push(k); o = (o as Record<string, unknown>)[k]; }
  return path;
};
/** A copy of `doc` without the value at `path`; tables left empty by that removal are dropped too. */
function without(doc: unknown, path: string[]): unknown {
  if (!path.length || !doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const [k, ...rest] = path; const copy = { ...(doc as Record<string, unknown>) };
  if (!(k in copy)) return copy;
  if (!rest.length) { delete copy[k]; return copy; }
  const inner = without(copy[k], rest);
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && !Object.keys(inner).length) delete copy[k]; else copy[k] = inner;
  return copy;
}
