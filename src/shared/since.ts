/**
 * `7d`, `12h`, `30m`, `2w` or a date -> the ISO timestamp rows are compared with; null when it is neither. Timestamps
 * are compared as text, so anything else would silently match every row or none.
 */
export function parseSince(v: string, now = Date.now()): string | null {
  const m = v.match(/^(\d+)([wdhm])$/);
  const ms = m
    ? now - Number(m[1]) * { w: 6048e5, d: 864e5, h: 36e5, m: 6e4 }[m[2] as 'w' | 'd' | 'h' | 'm']
    : /^\d{4}-\d{2}-\d{2}/.test(v) // Date.parse alone also takes "7" or "week 2", as a day in 2001
      ? Date.parse(v)
      : Number.NaN;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
