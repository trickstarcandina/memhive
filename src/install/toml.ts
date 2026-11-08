const stripComment = (line: string) => line.replace(/\s*#.*$/, '');
const headerKey = (line: string) => { const m = stripComment(line).trim().match(/^\[([^\]]+)\]$/); return m ? m[1].replace(/\s+/g, '') : null; };

// shortcut: line-based, no multi-line strings/arrays awareness, '#' inside quoted values mis-stripped; upgrade to a TOML parser if configs get exotic.
export function setTomlBoolean(content: string, tableHeader: string, key: string, value: boolean): string {
  const want = headerKey(tableHeader)!;
  const line = `${key} = ${value ? 'true' : 'false'}`;
  const lines = content.split('\n');
  const start = lines.findIndex((l) => headerKey(l) === want);
  if (start === -1) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${trimmed ? '\n\n' : ''}${tableHeader}\n${line}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const idx = lines.findIndex((l, i) => i > start && i < end && re.test(stripComment(l)));
  if (idx === -1) lines.splice(start + 1, 0, line); else lines[idx] = line;
  return lines.join('\n');
}
