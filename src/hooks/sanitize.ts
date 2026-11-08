// Matches an opening <private ...> tag (group 1 undefined) or a closing </private> tag (group 1 set).
const TAG = /<\s*(\/\s*)?private\b[^>]*>/gi;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const MAX_DEPTH = 20;
const TAIL = 100;
const PRE_CAP = 256 * 1024;

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
// Keyword-anchored, no nested quantifiers: scanning stays linear (ReDoS). Quoted values are
// escape-aware (unclosed quote redacts to end of line); bare values run to the end of the token.
const SECRET_ASSIGN = /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[\w.-]{0,40})(["']?\s{0,5}([:=])\s{0,5})(?:("(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$))|('(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$))|([^\s"'`,;(){}]{4,}))/gi;
// Only a full reference path counts: `$VAR`, `${VAR}`, `process.env.X`, `config.token`.
const REFERENCE = /^\$\{?[A-Z_][A-Z0-9_]*\}?$|^(?:process\.env|import\.meta\.env|os\.environ|this|config|env)(?:\.\w+|\[['"]\w+['"]\])+$/i;
// After `name:` a bare value counts as a TS type only when it cannot plausibly be a YAML/.env secret:
// a primitive keyword, a generic/array shape, a `|` union of those, or a digit-free identifier in
// member/param context (followed by `;`, `,`, `=`, `)` or `|`). A bare word at end of line is a value.
const TS_PRIMITIVE = /^(?:string|number|boolean|any|unknown|object|null|undefined|never|void|bigint|symbol)(?:\[\])*$/;
const TS_SHAPE = /^[A-Za-z_$][\w$.]*(?:<.*|(?:\[\])+)$/;
const TS_IDENT = /^[A-Za-z_$][A-Za-z_$.]*$/;
const TYPE_FOLLOW = /^[ \t]*(?:[;,|<>=)}\]]|\r?\n|$)/;
const MEMBER_FOLLOW = /^[ \t]*[;,=)|]/;

function looksLikeType(bare: string, follow: string): boolean {
  if (!TYPE_FOLLOW.test(follow)) return false;
  const typeLike = (p: string) => TS_PRIMITIVE.test(p) || TS_SHAPE.test(p);
  if (bare.includes('|')) return bare.split('|').every(typeLike);
  return typeLike(bare) || (TS_IDENT.test(bare) && MEMBER_FOLLOW.test(follow));
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<redacted>');
  return out.replace(SECRET_ASSIGN, (m, name: string, pre: string, sep: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number, str: string) => {
    const q = dq ? '"' : sq ? "'" : '';
    if (q) return `${name}${pre}${q}<redacted>${q}`;
    if (!bare || REFERENCE.test(bare)) return m;
    if (str[offset + m.length] === '(') return m; // call, e.g. getToken()
    if (COUNT_KEY.test(str.slice(Math.max(0, offset - 12), offset) + name)) return m;
    if (sep === ':' && looksLikeType(bare, str.slice(offset + m.length, offset + m.length + 64))) return m;
    return `${name}${pre}<redacted>`;
  });
}

const SECRET_KEY = /secret|token|passw(or)?d|api[_-]?key|private[_-]?key|authorization|cookie/i;
const COUNT_KEY = /(^|_)(count|max|min|limit|len|length)s?$|tokens?_?(count|used)|max_?tokens|(input|output|total)_?tokens/i;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = max >= 200 ? TAIL : 0;
  const head = s.slice(0, max - tail);
  const rest = tail ? s.slice(-tail) : '';
  return `${head}\n<elided chars=${s.length - max}>\n${rest}`;
}

// Drops a token cut by the cap; fails closed (drops up to 1 KB) when no whitespace is near.
function dropPartialTail(s: string): string {
  const stop = Math.max(0, s.length - 1024);
  for (let i = s.length - 1; i >= stop; i--) if (/\s/.test(s[i])) return s.slice(0, i + 1);
  return s.slice(0, stop);
}

function sanitizeString(s: string, max: number): string {
  const noImages = stripPrivate(s).replace(DATA_IMAGE, (m) => `<image elided bytes=${m.length - m.indexOf(',') - 1}>`);
  // Hard pre-cap bounds the scan. Redact a slightly wider window first, so a secret straddling the cap
  // is matched whole, then cap and drop the cut trailing token; truncate last so nothing is a fragment.
  if (noImages.length <= PRE_CAP) return truncate(redactSecrets(noImages), max);
  return truncate(dropPartialTail(redactSecrets(noImages.slice(0, PRE_CAP + 1024)).slice(0, PRE_CAP)), max);
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
  for (const [k, v] of Object.entries(rec)) {
    const hidden = SECRET_KEY.test(k) && !COUNT_KEY.test(k) && (typeof v === 'string' || typeof v === 'number');
    out[k] = hidden ? '<redacted>' : sanitizeToolPayload(v, maxChars, depth + 1);
  }
  return out;
}
