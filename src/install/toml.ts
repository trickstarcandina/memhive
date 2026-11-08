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
  const line = `${key} = ${value ? 'true' : 'false'}${eol === '\r\n' ? '\r' : ''}`;   // lines are split on \n only
  const lines = content.split('\n');
  const start = lines.findIndex((l) => headerKey(l) === want);
  if (start === -1) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${trimmed ? eol + eol : ''}${tableHeader}${eol}${line.replace(/\r$/, '')}${eol}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const idx = lines.findIndex((l, i) => i > start && i < end && re.test(stripComment(l)));
  if (idx === -1) lines.splice(start + 1, 0, line); else lines[idx] = line;
  return lines.join('\n');
}

export function hasTomlTable(content: string, tableHeader: string): boolean {
  const want = headerKey(tableHeader);
  return content.split('\n').some((l) => headerKey(l) === want);
}

/** Line-based edit, then verified with a real TOML parser. Throws instead of returning a file that is invalid or lacks the intended value. */
export function setTomlBooleanChecked(content: string, tableHeader: string, key: string, value: boolean): string {
  if (content.trim()) { try { parse(content); } catch (e) { throw new Error(`existing TOML does not parse: ${(e as Error).message}`); } }
  const out = setTomlBoolean(content, tableHeader, key, value);
  let parsed: unknown;
  try { parsed = parse(out); } catch (e) { throw new Error(`edited TOML would not parse (dotted/inline form?): ${(e as Error).message}`); }
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
