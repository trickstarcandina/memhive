import { describe, it, expect } from 'vitest';
import { redactSecrets, sanitizeToolPayload, stripPrivate, type PrivateState } from '../../src/hooks/sanitize.js';
import { mulberry32, int, pick, chars, ALNUM, type Rng } from '../helpers/prng.js';

const HEX = '0123456789abcdef';
const UPNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64URL = ALNUM + '-_';

// Each generator returns the full secret text and its distinctive core (>= 8 chars) that must never survive.
type Secret = { text: string; core: string };
const SECRETS: ((r: Rng) => Secret)[] = [
  (r) => { const c = chars(r, ALNUM, int(r, 24, 40)); return { text: 'sk-ant-api03-' + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, 32); return { text: 'sk-proj-' + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 20, 40)); return { text: pick(r, ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_']) + c, core: c }; },
  (r) => { const c = chars(r, UPNUM, 16); return { text: pick(r, ['AKIA', 'ASIA']) + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 20, 30)); return { text: 'mh_' + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 16, 30)); return { text: pick(r, ['sk_live_', 'sk_test_', 'rk_live_']) + c, core: c }; },
  (r) => { const c = chars(r, ALNUM + '-_', 35); return { text: 'AIza' + c, core: c.slice(0, 20) }; },
  (r) => { const c = chars(r, ALNUM, int(r, 20, 30)); return { text: 'glpat-' + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 30, 40)); return { text: pick(r, ['npm_', 'hf_']) + c, core: c }; },
  (r) => { const c = chars(r, ALNUM, 24); return { text: 'https://hooks.slack.com/services/T' + chars(r, UPNUM, 8) + '/B' + chars(r, UPNUM, 8) + '/' + c, core: c }; },
  (r) => { const a = chars(r, ALNUM, 22), b = chars(r, ALNUM, 43); return { text: `SG.${a}.${b}`, core: b }; },
  (r) => { const c = chars(r, HEX, 32); return { text: 'SK' + c, core: c }; },
  (r) => { const c = chars(r, B64URL, int(r, 16, 40)); return { text: `eyJ${chars(r, B64URL, 12)}.eyJ${chars(r, B64URL, 12)}.${c}`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 20, 60)); return { text: `-----BEGIN ${pick(r, ['RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', 'PGP ', ''])}PRIVATE KEY${pick(r, ['', ' BLOCK'])}-----\n${c}\n-----END PRIVATE KEY-----`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `${pick(r, ['password', 'passwd', 'api_key', 'secret', 'token', 'client_secret'])}${pick(r, ['=', ': ', ' = '])}${c}`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `${pick(r, ['postgres', 'mysql', 'mongodb+srv', 'redis', 'amqp', 'https'])}://${pick(r, ['admin', 'u', ''])}:${c}@db.internal:5432/app`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `${pick(r, ['DB_PASS', 'MYSQL_PWD', 'CREDENTIALS', 'AUTH', 'ACCESS_KEY', 'AWS_SESSION_TOKEN', 'STRIPE_SECRET'])}=${c}`, core: c }; },
  (r) => { const c = `${chars(r, ALNUM, 8)} ${chars(r, ALNUM, 8)}`; return { text: `${pick(r, ['MNEMONIC', 'DB_PASSWORD', 'SECRET_KEY'])}=${pick(r, ['"', "'"])}${c}${pick(r, ['"', "'"])}`, core: c.slice(0, 8) }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: JSON.stringify({ user: 'app', [pick(r, ['password', 'api_key', 'secret', 'token'])]: c }), core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `Authorization: Basic ${c}`, core: c }; },
  // Only the Cookie rule catches these: the secret is not in the first cookie, or it is quoted with attributes.
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `Cookie: theme=dark; session=${c}`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `Set-Cookie: sid="${c}"; Path=/; HttpOnly`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `authorization: ${pick(r, ['bearer', 'token', 'Basic'])} ${c}`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `os.environ["${pick(r, ['API_TOKEN', 'DB_PASSWORD', 'SECRET_KEY'])}"] = "${c}"`, core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: pick(r, [`mysql -u root -p${c} db`, `sshpass -p ${c} ssh h`, `docker login -u me -p ${c}`]), core: c }; },
  (r) => { const c = chars(r, ALNUM, int(r, 8, 20)); return { text: `curl -u admin:${c} https://api.example.com`, core: c }; },
];

// Host text: TS code, YAML, JSON, logs, Markdown. None of it is a secret on its own.
const HOSTS = [
  'export function connect(host: string, port: number): Promise<Client> {\n  return new Client({ host, port });\n}',
  'interface Opts { token?: Token; password?: string; retries: number }',
  'const m: Map<string, number> = new Map();\nlet x = 5;',
  'server:\n  host: 0.0.0.0\n  port: 8080\nlogging:\n  level: info',
  '{"name": "app", "nested": {"list": [1, 2, {"deep": true}], "flag": false}}',
  '2026-11-09T10:00:00Z INFO request done status=200 path=/api/v1/items took=12ms',
  '[warn] retrying upstream connection (attempt 3/5)',
  '# Setup\n\nRun `npm install` then *start* the server.\n\n- item one\n- item two',
  '| col | val |\n|-----|-----|\n| a   | 1   |',
  'SELECT id, name FROM users WHERE id = $1;',
];
const SEPS = [' ', '\n', '\t', ' ', '\n\n'];
const WRAPS: [string, string][] = [['', ''], ['"', '"'], ["'", "'"], ['`', '`'], ['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];

// Splits only at whitespace so a secret is never glued onto a host word (`fooghp_...` is not a token boundary).
function insertAt(r: Rng, host: string, piece: string): string {
  const cuts = [0, host.length];
  for (let i = 0; i < host.length; i++) if (/\s/.test(host[i])) cuts.push(i);
  const at = pick(r, cuts);
  return host.slice(0, at) + pick(r, SEPS) + piece + pick(r, SEPS) + host.slice(at);
}

function buildCase(r: Rng): { host: string; core: string } {
  const s = pick(r, SECRETS)(r);
  const [open, close] = pick(r, WRAPS);
  let piece = open + s.text + close;
  // Inside a JSON string value the secret arrives escaped (`\n`, `\"`).
  if (r() < 0.25) piece = `{"value": ${JSON.stringify(s.text)}}`;
  let host = pick(r, HOSTS);
  if (r() < 0.5) host += pick(r, SEPS) + pick(r, HOSTS);
  return { host: insertAt(r, host, piece), core: s.core };
}

describe('redactSecrets property (F1)', () => {
  it('never leaves an injected secret core, never throws, is idempotent', () => {
    const r = mulberry32(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const { host, core } = buildCase(r);
      const once = redactSecrets(host);
      expect(once.includes(core), `case ${i}: ${JSON.stringify(host)}`).toBe(false);
      expect(redactSecrets(once), `case ${i} idempotence`).toBe(once);
      const payload = JSON.stringify(sanitizeToolPayload({ content: host }));
      expect(payload.includes(core), `case ${i} payload: ${JSON.stringify(host)}`).toBe(false);
    }
  });

  it('stays fast enough for the whole property run', { retry: 2 }, () => {
    const t = performance.now();
    const r = mulberry32(1);
    for (let i = 0; i < 2000; i++) redactSecrets(buildCase(r).host);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  // Vocabulary taken from the non-secret fixtures in sanitize.test.ts, so a widened rule cannot quietly regress them.
  const SAFE = [
    'const token = getToken()', 'const tokenizer = new Tokenizer()', 'let x = 5',
    'password: string;', 'maxTokens: number = 100000', 'const a = process.env.SECRET', 'config.token', 'const t = config.token', 'token=$TOKEN',
    'token: string | null,', 'secret: Foo[];', 'token: Map<string, number>;', 'TOKEN_COUNT=1000000', 'max_tokens=100000',
    'token: null', 'secret: Foo | null;', 'f(token: Token)', 'f(a, token: Token = t)', 'token: string[]', 'token: bigint;',
    'function f(a: string, b: Map<string, number>, token: Token)', 'f(a?: Foo, token: Token = t)', 'f(token: Ref<Foo>)',
    'password: Map<string, number>', 'token: Promise<NodeJS.Timeout | null>;', 'token: Promise<Map<string, number>>',
    'token: Record<string, string>', 'token: Promise<string>;', 'token: Record<string, string>,', 'token: number[]',
    'interface A { password?: string }', 'const x = ${TOKEN}', 'the password field is required', 'password hunter2',
    'Basic authentication is supported', 'author: Jane Doe', 'passed: 3, passing tests', 'https://example.com:8080/path',
    'docker run -u 1000:1000 img', 'cookie: string;', 'sessionId: string', 'Rotate the API key every month.',
  ];
  it('leaves secret-free host text unchanged', () => {
    const r = mulberry32(0xbadc0de);
    for (let i = 0; i < 500; i++) {
      const parts = Array.from({ length: int(r, 1, 6) }, () => (r() < 0.7 ? pick(r, SAFE) : pick(r, HOSTS)));
      const host = parts.join('\n');
      expect(redactSecrets(host), `case ${i}`).toBe(host);
    }
  });
});

describe('stripPrivate property (F2)', () => {
  const TOKENS = ['text', 'a b', '\n', '<private>', '</private>', '<private attr="x">', '"<private>"', "'</private>'"];

  // Reference model of the documented behavior: a tag directly wrapped in matching quotes is a mention;
  // an opener raises depth, a closer lowers it (a stray one is dropped); text survives only at depth 0.
  function model(tokens: string[], state: PrivateState): string {
    let out = '';
    for (const t of tokens) {
      const isMention = t === '"<private>"' || t === "'</private>'";
      const isTag = !isMention && t.startsWith('<');
      if (isTag) {
        if (t.startsWith('</')) { if (state.depth > 0) state.depth--; } else state.depth++;
      } else if (state.depth === 0) out += t;
    }
    return out;
  }

  const isSubsequence = (sub: string, s: string) => {
    let j = 0;
    for (let i = 0; i < s.length && j < sub.length; i++) if (s[i] === sub[j]) j++;
    return j === sub.length;
  };

  it('drops every depth > 0 region, keeps a subsequence and carries depth across sibling strings', () => {
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      // Text tokens are separated by spaces so adjacent quotes from a mention never pair with a neighbouring tag.
      const seq = (n: number) => Array.from({ length: n }, () => pick(r, TOKENS)).flatMap((t) => [t, ' ']);
      const a = seq(int(r, 0, 10));
      const b = seq(int(r, 0, 10));
      const real: PrivateState = { depth: 0 };
      const ref: PrivateState = { depth: 0 };
      const outA = stripPrivate(a.join(''), real);
      const expA = model(a, ref);
      const outB = stripPrivate(b.join(''), real);
      const expB = model(b, ref);
      const msg = `case ${i}: ${JSON.stringify([a.join(''), b.join('')])}`;
      expect(outA, msg).toBe(expA);
      expect(outB, msg).toBe(expB);
      expect(real.depth, msg).toBe(ref.depth);
      expect(isSubsequence(outA, a.join('')), msg).toBe(true);
      expect(isSubsequence(outB, b.join('')), msg).toBe(true);
    }
  });

});
