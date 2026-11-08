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
    // A tag alone inside quotes (`grep "<private>" src`) mentions the tag; it does not open or close a block.
    const q = text[at - 1];
    if ((q === '"' || q === "'" || q === '`') && text[at + m[0].length] === q) continue;
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
  return truncate(redactCapped(stripPrivate(text)).trim(), 16000);
}

// Covered: PEM private keys (any label, PGP `KEY BLOCK` too), vendor tokens (Anthropic/OpenAI `sk-`, Stripe,
// Google `AIza`, GitHub, GitLab, npm, HuggingFace, AWS `AKIA`/`ASIA`, Slack tokens and webhooks, SendGrid, Twilio,
// memhive `mh_`), JWTs, Bearer and `Authorization: Basic` credentials, URL userinfo passwords, Cookie headers,
// `curl -u user:pw`, and `name = value` / `name: value` / `.env` assignments whose name holds a secret keyword.
// Every rule starts at a literal prefix, `\b` or a lookbehind, and no quantifier nests: scanning stays linear (ReDoS).
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[\w-]{35}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[\w-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bmh_[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // The lookbehind lets a run of segment characters start at most one match, so a failed scan is never repeated.
  /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /(?<![\w.-])SG\.[\w-]{20,}\.[\w-]{20,}/g,
];
// Group 1 is kept, so the reader still sees what was there: scheme, user and host stay, only the password goes.
const PREFIXED_PATTERNS: RegExp[] = [
  // The password may hold `@`: it runs lazily to the `@` whose host part ends the authority. The lookbehind gives a
  // scheme one start per run, and the atomic `(?=(?=(x))\2@)` precheck finds an `@` without backtracking.
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,256}:)(?=(?=([^\s/@]{0,256}))\2@)[^\s]{1,256}?(?=@[^\s@/]{0,253}(?:[\s/?#]|$))/gi,
  // shortcut: an unencoded `/` in the password is matched only within 32 chars (a wider window costs too much
  // on hostile `a://b:` runs); widen with a hand-written scanner if longer ones show up.
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,256}:)(?=(?=([^\s@]{0,32}))\2@)[^\s]{1,32}?(?=@[^\s@/]{0,253}(?:[\s/?#]|$))/gi,
  // `Basic` alone is prose; only the header value form is a credential.
  /\b(Authorization["']?[ \t]{0,5}[:=][ \t]{0,5}["']?)Basic[ \t]{1,5}[A-Za-z0-9+/]{4,}={0,2}/gi,
  /(https:\/\/hooks\.slack\.com\/services\/)[\w/-]+/g,
  // Needs a `name=value` pair, so `cookie: string` (a TS type) is left alone. The bounded, colon-free name keeps
  // repeated `cookie:` linear; the value runs to end of line, so quoted and later cookies go too.
  /\b((?:set-)?cookie[ \t]{0,5}:[ \t]{0,5})[^\s=;,"':]{1,256}=[^\r\n]*/gi,
];
// `curl -u user:pw`, `-uuser:pw`, `--user=user:pw`. `docker`/`podman`/`su -u` take `user:group`, not a credential:
// group 1 consumes the rest of such a line, so its flags are skipped in the same single linear scan.
const USER_FLAG = /(\b(?:docker|podman|su)\b[^\n]*)|((?:^|\s)(?:-u|--user)(?:[ \t]{1,5}|=)?["']?)(?!-)[^\s"':]+:[^\s"']+/gm;
// Keyword-anchored, no nested quantifiers: scanning stays linear (ReDoS). Quoted values are
// escape-aware (unclosed quote redacts to end of line); bare values run to the end of the token,
// and a bounded `<...>` group (`Map<string, number>`) stays inside the token so it is judged and redacted whole.
// `pass` needs a word end so `passed`/`passing` are not keys; `auth` skips `author*`/`authority`/`authent*`
// but keeps `authorization`. Ambiguous names like `auth: foo` are redacted: a false positive is cheaper than a leak.
// A JSON-escaped quote (`\"`, a JSON document inside a JSON string) opens a value redacted to end of line: the
// escape depth cannot be known, so guessing where the value closes would fail open.
const SECRET_ASSIGN = /((?:secret|token|passw(?:or)?d|pass(?:phrase)?(?![a-z])|pwd|api[_-]?key|private[_-]?key|credential|auth(?!or(?!i[sz])|ent)|access[_-]?key|signing[_-]?key|encryption[_-]?key|cookie|session[_-]?id|dsn|conn(?:ection)?[_-]?str(?:ing)?|mnemonic|seed[_-]?phrase|database[_-]?url)[\w.-]{0,40})(\\?["']?\s{0,5}([:=])\s{0,5})(?:(\\"[^\n]*)|("(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$))|('(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$))|((?:<[^<>\n]{0,200}>|[^\s"'`,;(){}]){4,}))/gi;
// Only a full reference path counts: `$VAR`, `${VAR}`, `process.env.X`, `config.token`.
const REFERENCE = /^\$\{?[A-Z_][A-Z0-9_]*\}?$|^(?:process\.env|import\.meta\.env|os\.environ|this|config|env)(?:\.\w+|\[['"]\w+['"]\])+$/i;
// After `name:` a bare value counts as a TS type only when it cannot plausibly be a YAML/.env/log secret
// (a false positive is cheaper than a leaked secret): a primitive keyword, a PascalCase array (`Foo[]`),
// a `|` union of those, a well-known generic (`Map<string, number>`), a PascalCase identifier followed by
// `| Type` (`Foo | null`), or - inside a real parameter list (`f(a, token: Token)`) - a PascalCase identifier or generic.
const TS_PRIMITIVE = /^(?:string|number|boolean|any|unknown|object|null|undefined|never|void|bigint|symbol)(?:\[\])*$/;
const TS_ARRAY = /^[A-Z][A-Za-z_$.]*(?:\[\])+$/;
const TS_NAME = /^[A-Z][A-Za-z_$.]*$/;
// Disjoint delimiters keep this linear; one level of nesting (`Promise<Map<a, b>>`) is enough.
const TS_GENERIC = /^[A-Z][A-Za-z_$.]*<[^<>\n]*(?:<[^<>\n]*>[^<>\n]*)*>(?:\[\])*$/;
const KNOWN_GENERIC = /^(?:Array|ReadonlyArray|Map|ReadonlyMap|Set|ReadonlySet|WeakMap|WeakSet|Record|Promise|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Awaited|Iterable|AsyncIterable)</;
const TYPE_FOLLOW = /^[ \t]*(?:[;,|<>=)}\]]|\r?\n|$)/;
const PARAM_FOLLOW = /^[ \t]*[,=)]/;
const UNION_FOLLOW = /^[ \t]*\|[ \t]*([A-Za-z_$][\w$.]*)/;
// An earlier parameter: `a`, `a?` or `a: Type...` whose type starts with a primitive or PascalCase name, no default.
const PARAM_PIECE = /^\s*[\w$]+\??\s*(?::\s*([A-Za-z_$][\w$.]*)[^=]*)?$/;

const isTypeName = (n: string) => TS_PRIMITIVE.test(n) || TS_NAME.test(n);

// True only when the key sits in a parameter list: the innermost unclosed bracket before it is `(`
// (not `{`/`[`, which are object/array literals) and every earlier entry reads as a typed parameter,
// so `(user: admin, password: Hunter)` and `{a: b, token: Tok, c: d}` stay value context.
function inParamList(before: string): boolean {
  let depth = 0;
  let open = -1;
  for (let i = before.length - 1; i >= 0 && open < 0; i--) {
    const c = before[i];
    if (')]}>'.includes(c)) depth++;
    else if ('([{<'.includes(c)) {
      if (depth > 0) depth--;
      else if (c === '(') open = i;
      else return false;
    }
  }
  if (open < 0) return false;
  const head = before.slice(open + 1).replace(/[ \t]*[\w$]*$/, '');
  if (head === '') return true;
  if (!head.endsWith(',')) return false;
  const pieces: string[] = [];
  let cur = '';
  depth = 0;
  for (const c of head.slice(0, -1)) {
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { pieces.push(cur); cur = ''; } else cur += c;
  }
  pieces.push(cur);
  return pieces.every((p) => {
    const m = PARAM_PIECE.exec(p);
    return m !== null && (m[1] === undefined || isTypeName(m[1]));
  });
}

// Type arguments must read as type names: digit-free, only `.` `[]` `|` `&` `,` spaces and nested `<>` between
// names, and each name a primitive or PascalCase. `Map<hunter2secret99>` and `Promise<sk-...>` are values.
const TYPE_ARGS = /^[A-Za-z_$.[\]|&,<> ]*$/;
function typeArgsOk(bare: string): boolean {
  const args = bare.slice(bare.indexOf('<') + 1, bare.lastIndexOf('>'));
  return TYPE_ARGS.test(args) && args.split(/[^A-Za-z_$.]+/).filter(Boolean).every(isTypeName);
}

function looksLikeType(bare: string, follow: string, before: string): boolean {
  if (!TYPE_FOLLOW.test(follow)) return false;
  const inParams = () => PARAM_FOLLOW.test(follow) && inParamList(before);
  if (bare.includes('<')) return TS_GENERIC.test(bare) && typeArgsOk(bare) && (KNOWN_GENERIC.test(bare) || inParams());
  const typeLike = (p: string) => TS_PRIMITIVE.test(p) || TS_ARRAY.test(p);
  if (bare.includes('|')) return bare.split('|').every(typeLike);
  if (typeLike(bare)) return true;
  if (!TS_NAME.test(bare)) return false;
  const union = UNION_FOLLOW.exec(follow);
  return union ? isTypeName(union[1]) : inParams();
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<redacted>');
  for (const re of PREFIXED_PATTERNS) out = out.replace(re, '$1<redacted>');
  out = out.replace(USER_FLAG, (m, cmd: string | undefined, pre: string) => (cmd ? m : `${pre}<redacted>`));
  return out.replace(SECRET_ASSIGN, (m, name: string, pre: string, sep: string, edq: string | undefined, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number, str: string) => {
    if (edq) return `${name}${pre}\\"<redacted>`;
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

// Hard pre-cap bounds the scan. Redact a slightly wider window first, so a secret straddling the cap
// is matched whole, then cap and drop the cut trailing token; callers truncate last so nothing is a fragment.
function redactCapped(s: string): string {
  if (s.length <= PRE_CAP) return redactSecrets(s);
  return dropPartialTail(redactSecrets(s.slice(0, headEnd(s, PRE_CAP + 1024))).slice(0, PRE_CAP));
}

function sanitizeString(s: string, max: number, state: PrivateState): string {
  const noImages = stripPrivate(s, state).replace(DATA_IMAGE, (m) => `<image elided bytes=${m.length - m.indexOf(',') - 1}>`);
  return truncate(redactCapped(noImages), max);
}

/** Pass one `state` to every part of one host payload (input and output) so a private block can span them. */
export function sanitizeToolPayload(value: unknown, maxChars = 16000, state: PrivateState = { depth: 0 }, depth = 0, hide = false): unknown {
  // Fail closed: a too-deep value is replaced, never passed through raw.
  if (depth > MAX_DEPTH) return '<elided: max depth>';
  if (typeof value === 'string') { const s = sanitizeString(value, maxChars, state); return hide ? '<redacted>' : s; }   // array items under a secret key
  if (value === null || typeof value !== 'object') return state.depth > 0 && value !== undefined ? null : hide && typeof value === 'number' ? '<redacted>' : value;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolPayload(v, maxChars, state, depth + 1, hide));
  const rec = value as Record<string, unknown>;
  if (rec.type === 'image' || rec.type === 'image_url') return { type: 'image', elided: true };
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(rec)) {
    const k = stripPrivate(rawKey, state);
    // Judge both forms: stripping a tag out of a key must never make it less sensitive.
    const secretKey = (x: string) => SECRET_KEY.test(x) && !COUNT_KEY.test(x);
    // Under a secret-named key every string or number leaf is hidden, also inside arrays and objects (`{"password": ["x"]}`).
    const hideV = hide || secretKey(rawKey) || secretKey(k);
    out[k] = hideV && (typeof v === 'string' || typeof v === 'number') ? '<redacted>' : sanitizeToolPayload(v, maxChars, state, depth + 1, hideV);
  }
  return out;
}
