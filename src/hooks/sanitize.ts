// Matches an opening <private ...> tag (group 1 undefined) or a closing </private> tag (group 1 set).
// A bare `<private` with no `>` swallows to end of string (fail closed).
const TAG = /<\s*(\/\s*)?private\b[^>]*(?:>|$)/gi;
// Base64 or URL-encoded/raw payload (`data:image/svg+xml,%3Csvg…`); runs to whitespace, a quote or `)`.
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^\s"'`)]*/gi;
const MAX_DEPTH = 20;
const TAIL = 100;
const PRE_CAP = 256 * 1024;

/** Open-block depth, carried from string to string so a block split across sibling fields still hides what is between. */
export interface PrivateState { depth: number }

// Scanner, not regex: nested blocks must not leak their inner text.
export function stripPrivate(text: string, state: PrivateState = { depth: 0 }): string {
  let out = '';
  let cursor = 0;
  for (const m of text.matchAll(TAG)) {
    const at = m.index;
    if (state.depth === 0) out += text.slice(cursor, at);
    if (m[1] === undefined) state.depth++;
    else if (state.depth > 0) state.depth--;
    cursor = at + m[0].length;
  }
  // An unclosed opener leaves depth > 0 and drops the rest of the string.
  if (state.depth === 0) out += text.slice(cursor);
  return out;
}

export function sanitizePrompt(text: string): string {
  return truncate(redactSecrets(stripPrivate(text)).trim(), 16000);
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
// escape-aware (unclosed quote redacts to end of line); bare values run to the end of the token,
// and a bounded `<...>` group (`Map<string, number>`) stays inside the token so it is judged and redacted whole.
const SECRET_ASSIGN = /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[\w.-]{0,40})(["']?\s{0,5}([:=])\s{0,5})(?:("(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$))|('(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$))|((?:<[^<>\n]{0,200}>|[^\s"'`,;(){}]){4,}))/gi;
// Only a full reference path counts: `$VAR`, `${VAR}`, `process.env.X`, `config.token`.
const REFERENCE = /^\$\{?[A-Z_][A-Z0-9_]*\}?$|^(?:process\.env|import\.meta\.env|os\.environ|this|config|env)(?:\.\w+|\[['"]\w+['"]\])+$/i;
// After `name:` a bare value counts as a TS type only when it cannot plausibly be a YAML/.env secret
// (a false positive is cheaper than a leaked secret): a primitive keyword, a digit-free array (`Foo[]`),
// a `|` union of those, a well-known generic (`Map<string, number>`), an identifier in a union (`Foo | null`),
// or - inside a parameter list (`f(a, token: Token)`) - a digit-free identifier or generic.
const TS_PRIMITIVE = /^(?:string|number|boolean|any|unknown|object|null|undefined|never|void|bigint|symbol)(?:\[\])*$/;
const TS_ARRAY = /^[A-Za-z_$][A-Za-z_$.]*(?:\[\])+$/;
const TS_IDENT = /^[A-Za-z_$][A-Za-z_$.]*$/;
// Disjoint delimiters keep this linear; one level of nesting (`Promise<Map<a, b>>`) is enough.
const TS_GENERIC = /^[A-Za-z_$][A-Za-z_$.]*<[^<>\n]*(?:<[^<>\n]*>[^<>\n]*)*>(?:\[\])*$/;
const KNOWN_GENERIC = /^(?:Array|ReadonlyArray|Map|ReadonlyMap|Set|ReadonlySet|WeakMap|WeakSet|Record|Promise|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Awaited|Iterable|AsyncIterable)</;
const TYPE_FOLLOW = /^[ \t]*(?:[;,|<>=)}\]]|\r?\n|$)/;
const PARAM_FOLLOW = /^[ \t]*[,=)]/;
const PARAM_BEFORE = /[(,][ \t]*[\w$]*$/;

function looksLikeType(bare: string, follow: string, before: string): boolean {
  if (!TYPE_FOLLOW.test(follow)) return false;
  const inParams = PARAM_BEFORE.test(before) && PARAM_FOLLOW.test(follow);
  if (bare.includes('<')) return TS_GENERIC.test(bare) && (KNOWN_GENERIC.test(bare) || inParams);
  const typeLike = (p: string) => TS_PRIMITIVE.test(p) || TS_ARRAY.test(p);
  if (bare.includes('|')) return bare.split('|').every(typeLike);
  return typeLike(bare) || (TS_IDENT.test(bare) && (inParams || /^[ \t]*\|/.test(follow)));
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
    if (sep === ':' && looksLikeType(bare, str.slice(offset + m.length, offset + m.length + 64), str.slice(Math.max(0, offset - 64), offset))) return m;
    return `${name}${pre}<redacted>`;
  });
}

const SECRET_KEY = /secret|token|passw(or)?d|api[_-]?key|private[_-]?key|authorization|cookie/i;
const COUNT_KEY = /(^|_)(count|max|min|limit|len|length)s?$|tokens?_?(count|used)|max_?tokens|(input|output|total)_?tokens/i;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
// Cut points moved off the middle of a surrogate pair, so no lone half is left behind.
const headEnd = (s: string, i: number) => (i > 0 && isHigh(s.charCodeAt(i - 1)) ? i - 1 : i);
const tailStart = (s: string, i: number) => (i < s.length && isLow(s.charCodeAt(i)) ? i + 1 : i);

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = max >= 200 ? TAIL : 0;
  const head = s.slice(0, headEnd(s, max - tail));
  const rest = tail ? s.slice(tailStart(s, s.length - tail)) : '';
  return `${head}\n<elided chars=${s.length - max}>\n${rest}`;
}

// Drops a token cut by the cap; fails closed (drops up to 1 KB) when no whitespace is near.
function dropPartialTail(s: string): string {
  const stop = Math.max(0, s.length - 1024);
  for (let i = s.length - 1; i >= stop; i--) if (/\s/.test(s[i])) return s.slice(0, i + 1);
  return s.slice(0, headEnd(s, stop));
}

function sanitizeString(s: string, max: number, state: PrivateState): string {
  const noImages = stripPrivate(s, state).replace(DATA_IMAGE, (m) => `<image elided bytes=${m.length - m.indexOf(',') - 1}>`);
  // Hard pre-cap bounds the scan. Redact a slightly wider window first, so a secret straddling the cap
  // is matched whole, then cap and drop the cut trailing token; truncate last so nothing is a fragment.
  if (noImages.length <= PRE_CAP) return truncate(redactSecrets(noImages), max);
  return truncate(dropPartialTail(redactSecrets(noImages.slice(0, headEnd(noImages, PRE_CAP + 1024))).slice(0, PRE_CAP)), max);
}

/** Pass one `state` to every part of one host payload (input and output) so a private block can span them. */
export function sanitizeToolPayload(value: unknown, maxChars = 16000, state: PrivateState = { depth: 0 }, depth = 0): unknown {
  // Fail closed: a too-deep value is replaced, never passed through raw.
  if (depth > MAX_DEPTH) return '<elided: max depth>';
  if (typeof value === 'string') return sanitizeString(value, maxChars, state);
  if (value === null || typeof value !== 'object') return state.depth > 0 && value !== undefined ? null : value;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolPayload(v, maxChars, state, depth + 1));
  const rec = value as Record<string, unknown>;
  if (rec.type === 'image' || rec.type === 'image_url') return { type: 'image', elided: true };
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(rec)) {
    const k = stripPrivate(rawKey, state);
    const hidden = SECRET_KEY.test(k) && !COUNT_KEY.test(k) && (typeof v === 'string' || typeof v === 'number');
    out[k] = hidden ? '<redacted>' : sanitizeToolPayload(v, maxChars, state, depth + 1);
  }
  return out;
}
