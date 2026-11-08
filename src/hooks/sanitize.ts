// Matches an opening <private ...> tag (group 1 undefined) or a closing </private> tag (group 1 set).
const TAG = /<\s*(\/\s*)?private\b[^>]*>/gi;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const MAX_DEPTH = 20;
const TAIL = 100;

// Scanner, not regex: nested blocks must not leak their inner text.
export function stripPrivate(text: string): string {
  let out = '';
  let depth = 0;
  let cursor = 0;
  for (const m of text.matchAll(TAG)) {
    const at = m.index;
    if (depth === 0) out += text.slice(cursor, at);
    if (m[1] === undefined) depth++;
    else if (depth > 0) depth--;
    cursor = at + m[0].length;
  }
  // An unclosed opener leaves depth > 0 and drops the rest of the string.
  if (depth === 0) out += text.slice(cursor);
  return out;
}

export function sanitizePrompt(text: string): string {
  return stripPrivate(text).trim();
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bmh_[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];
// Only literal values: quoted strings, or unquoted tokens that are not a call like getToken().
const SECRET_ASSIGN = /\b([\w.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)(?:(["'])[^"'\n]*\2|[^\s"'`(),;]{6,}(?![^\s"'`,;]*\())/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<redacted>');
  return out.replace(SECRET_ASSIGN, (_m, pre: string, q?: string) => (q ? `${pre}${q}<redacted>${q}` : `${pre}<redacted>`));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = max >= 200 ? TAIL : 0;
  const head = s.slice(0, max - tail);
  const rest = tail ? s.slice(-tail) : '';
  return `${head}\n<elided chars=${s.length - max}>\n${rest}`;
}

function sanitizeString(s: string, max: number): string {
  const noPrivate = redactSecrets(stripPrivate(s));
  const noImages = noPrivate.replace(DATA_IMAGE, (m) => `<image elided bytes=${m.length - m.indexOf(',') - 1}>`);
  return truncate(noImages, max);
}

export function sanitizeToolPayload(value: unknown, maxChars = 16000, depth = 0): unknown {
  // Fail closed: a too-deep value is replaced, never passed through raw.
  if (depth > MAX_DEPTH) return '<elided: max depth>';
  if (typeof value === 'string') return sanitizeString(value, maxChars);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolPayload(v, maxChars, depth + 1));
  const rec = value as Record<string, unknown>;
  if (rec.type === 'image' || rec.type === 'image_url') return { type: 'image', elided: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = sanitizeToolPayload(v, maxChars, depth + 1);
  return out;
}
