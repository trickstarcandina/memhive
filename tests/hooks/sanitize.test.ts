import { describe, it, expect } from 'vitest';
import { stripPrivate, sanitizeToolPayload, sanitizePrompt, redactSecrets } from '../../src/hooks/sanitize.js';

describe('stripPrivate', () => {
  it('removes closed private blocks, case-insensitive, multiline', () => {
    expect(stripPrivate('a <private>\nsecret\n</PRIVATE> b')).toBe('a  b');
  });
  it('treats a tag alone inside quotes as a mention, not a block', () => {
    expect(stripPrivate('grep -rn "<private>" src')).toBe('grep -rn "<private>" src');
    expect(stripPrivate("rg '</private>' && x `<private>`")).toBe("rg '</private>' && x `<private>`");
    expect(stripPrivate('a "<private>secret</private>" b')).toBe('a "" b');
    const state = { depth: 0 };
    stripPrivate('grep "<private>" src', state);
    expect(state.depth).toBe(0);
  });
  it('drops everything after an unclosed private tag', () => {
    expect(stripPrivate('keep <private> secret forever')).toBe('keep ');
  });
  it('accepts attributes and whitespace inside tags', () => {
    expect(stripPrivate('a<private x="1">s</private>b')).toBe('ab');
    expect(stripPrivate('a< private >s</ private >b')).toBe('ab');
  });
  it('drops nested blocks entirely, inner text included', () => {
    expect(stripPrivate('a<private>1<private>2</private>3</private>b')).toBe('ab');
  });
  it('removes a stray closing tag', () => {
    expect(stripPrivate('a</private>b')).toBe('ab');
  });
});

describe('sanitizeToolPayload', () => {
  it('strips private strings nested in objects and arrays', () => {
    expect(sanitizeToolPayload({ a: ['x <private>s</private>'], b: { c: '<private>z' } })).toEqual({ a: ['x '], b: { c: '' } });
  });
  it('elides data-url images and image content blocks', () => {
    const data = 'data:image/png;base64,' + 'A'.repeat(500);
    const out = sanitizeToolPayload({ s: data, blocks: [{ type: 'image', source: { data: 'QUJD' } }] }) as any;
    expect(out.s).toBe('<image elided bytes=500>');
    expect(out.blocks[0]).toEqual({ type: 'image', elided: true });
  });
  it('truncates long strings with a marker', () => {
    const out = sanitizeToolPayload('x'.repeat(20000), 16000) as string;
    expect(out.length).toBeLessThan(16200);
    expect(out).toContain('<elided chars=4000>');
  });
  it('truncates small limits without exceeding max plus marker', () => {
    const out = sanitizeToolPayload('x'.repeat(200), 50) as string;
    expect(out.startsWith('x'.repeat(50))).toBe(true);
    expect(out).toContain('<elided chars=150>');
    expect(out.length).toBeLessThanOrEqual(70);
  });
  it('carries an open private block across sibling fields and object keys', () => {
    expect(sanitizeToolPayload(['keep <private>s1', 'inner', 1234, 's2</private> after'])).toEqual(['keep ', '', null, ' after']);
    // Keys inside the open block are private too.
    expect(sanitizeToolPayload({ a: 'keep <private>s1', b: 'inner', c: 's2</private> after', d: 'shown' })).toEqual({ a: 'keep ', '': ' after', d: 'shown' });
    expect(sanitizeToolPayload({ ['x<private>k</private>']: 'v', ['<private>k2']: 'gone', ['</private>z']: 'back' })).toEqual({ x: 'v', '': '', z: 'back' });
  });
  it('redacts a secret-named key whose name is split by a private tag', () => {
    expect(sanitizeToolPayload({ 'pass<private>x</private>word': 'hunter2' })).toEqual({ password: '<redacted>' });
    expect(sanitizeToolPayload({ '<private>password</private>': 'hunter2', 'x<private>token</private>': 42 })).toEqual({ '': '<redacted>', x: '<redacted>' });
    expect(sanitizeToolPayload({ 'api_<private>z</private>key': 'abc', 'password<private>_count</private>': 7 })).toEqual({ api_key: '<redacted>', password: '<redacted>' });
  });
  it('never splits a surrogate pair when truncating', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const out = sanitizeToolPayload('ab' + '\u{1F600}'.repeat(300) + 'c', 201) as string;
    expect(out).toContain('<elided');
    expect(out).not.toMatch(lone);
  });
  it('elides non-base64 data:image urls', () => {
    expect(sanitizeToolPayload('x data:image/svg+xml,%3Csvg%3E%3C/svg%3E y')).toBe('x <image elided bytes=19> y');
    expect(sanitizeToolPayload('src="data:image/svg+xml;charset=utf-8,<svg/>"')).toBe('src="<image elided bytes=6>"');
  });
  it('leaves numbers, booleans and null alone', () => {
    expect(sanitizeToolPayload({ n: 1, b: false, z: null })).toEqual({ n: 1, b: false, z: null });
  });
  it('replaces values nested deeper than the limit instead of passing them raw', () => {
    let v: unknown = '<private>SECRET';
    for (let i = 0; i < 30; i++) v = { n: v };
    const out = JSON.stringify(sanitizeToolPayload(v));
    expect(out).not.toContain('SECRET');
    expect(out).toContain('<elided: max depth>');
  });
});

describe('sanitizePrompt', () => {
  it('strips private and trims', () => expect(sanitizePrompt('  hi <private>x</private> ')).toBe('hi'));
  it('caps the scanned prompt before redaction, so a 2 MB prompt costs no more than 256 KB', () => {
    const big = ('cookie:'.repeat(9) + ' ').repeat(33_000);
    const t = performance.now();
    const out = sanitizePrompt(big);
    expect(performance.now() - t).toBeLessThan(300);
    expect(out.length).toBeLessThan(16200);
    expect(out).toContain('<elided');
  });
  it('leaves no fragment of a secret straddling the prompt pre-cap', () => {
    const secret = 'sk-ant-' + 'abcdefghij'.repeat(4);
    const out = sanitizePrompt('x '.repeat((256 * 1024 - 10) / 2) + secret + ' tail');
    expect(out).not.toMatch(/sk-ant|abcdefgh|<reda(?!cted>)/);
  });
});

describe('redactSecrets', () => {
  const R = '<redacted>';
  it.each([
    ['key sk-ant-api03-abcdefghijklmnopqrstuv', 'key ' + R],
    ['sk-abcdefghijklmnopqrstuvwx', R],
    ['ghp_abcdefghijklmnopqrstuvwx', R],
    ['github_pat_abcdefghijklmnopqrstuvwx', R],
    ['AKIAABCDEFGHIJKLMNOP', R],
    ['xoxb-1234567890-abcdef', R],
    ['mh_abcdefghijklmnopqrstuvwx', R],
    ['Authorization: Bearer abc.def-123456', 'Authorization: ' + R],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- after', R + ' after'],
    ['DB_PASSWORD=hunter2hunter', 'DB_PASSWORD=' + R],
    ['{"api_key": "abc"}', '{"api_key": "' + R + '"}'],
  ])('redacts %s', (i, o) => expect(redactSecrets(i)).toBe(o));
  it('leaves normal code alone', () => {
    for (const c of ['const token = getToken()', 'const tokenizer = new Tokenizer()', 'let x = 5']) expect(redactSecrets(c)).toBe(c);
  });
  it('is applied inside sanitizeToolPayload', () => {
    expect(sanitizeToolPayload({ a: 'x ghp_abcdefghijklmnopqrstuvwx' })).toEqual({ a: 'x ' + R });
  });
  it('handles mixed quotes, escapes and unclosed quotes', () => {
    expect(redactSecrets('{"password": "it\'s a pass"}')).toBe('{"password": "' + R + '"}');
    expect(redactSecrets('secret: \'x"y\'')).toBe("secret: '" + R + "'");
    expect(redactSecrets('password = "ab\\"cd" tail')).toBe('password = "' + R + '" tail');
    expect(redactSecrets('password = "oops\nnext')).toBe('password = "' + R + '"\nnext');
  });
  it('does not redact type annotations or bare references', () => {
    for (const c of ['password: string;', 'maxTokens: number = 100000', 'const a = process.env.SECRET', 'config.token', 'const t = config.token', 'token=$TOKEN']) expect(redactSecrets(c)).toBe(c);
  });
  it('is linear on hostile input', () => {
    const t = Date.now();
    redactSecrets('token='.repeat(175000));
    expect(Date.now() - t).toBeLessThan(200);
  });
  it('redacts every leaf under a secret-named key with an array or object value', () => {
    expect(sanitizeToolPayload({ password: ['hunter2xyz', 7], authorization: { v: 'abcd', n: [{ x: 'y' }], ok: true } })).toEqual({ password: [R, R], authorization: { v: R, n: [{ x: R }], ok: true } });
    expect(sanitizeToolPayload({ items: ['plain'] })).toEqual({ items: ['plain'] });
  });
  it('redacts secret-named keys in payloads but keeps counts', () => {
    expect(sanitizeToolPayload({ password: 'x', n: { apiKey: 5 } })).toEqual({ password: R, n: { apiKey: R } });
    expect(sanitizeToolPayload({ max_tokens: 2048, maxTokens: 2048 })).toEqual({ max_tokens: 2048, maxTokens: 2048 });
  });
  it('redacts unquoted YAML/.env values but not types', () => {
    expect(redactSecrets('token: abcdefghij')).toBe('token: ' + R);
    expect(redactSecrets('password: hunter2hunter')).toBe('password: ' + R);
    expect(redactSecrets('api_key=abc1')).toBe('api_key=' + R);
    for (const c of ['password: string;', 'token: string | null,', 'secret: Foo[];', 'maxTokens: number = 100000', 'token: Map<string, number>;', 'TOKEN_COUNT=1000000', 'max_tokens=100000']) expect(redactSecrets(c)).toBe(c);
  });
  it('treats a capitalised bare word as a value unless it is in TS type context', () => {
    expect(redactSecrets('password: Hunter2Hunter')).toBe('password: ' + R);
    expect(redactSecrets('token: Abcdefghij')).toBe('token: ' + R);
    expect(redactSecrets('api_key: XyZ123abc')).toBe('api_key: ' + R);
    expect(redactSecrets('token: Abcdefghij\nnext: 1')).toBe('token: ' + R + '\nnext: 1');
    expect(redactSecrets('secret: Abc123;')).toBe('secret: ' + R + ';');
    for (const c of ['token: null', 'secret: Foo | null;', 'f(token: Token)', 'f(a, token: Token = t)', 'token: string[]', 'token: bigint;']) expect(redactSecrets(c)).toBe(c);
  });
  it('redacts a bare identifier or unknown generic outside parameter context (false positive beats a leak)', () => {
    expect(redactSecrets('password: Config;')).toBe('password: ' + R + ';');
    expect(redactSecrets('token: Token,')).toBe('token: ' + R + ',');
    expect(redactSecrets('password: Pass<word>;')).toBe('password: ' + R + ';');
    expect(redactSecrets('password: Pass<word, more>')).toBe('password: ' + R);
    expect(redactSecrets('password: Pass<word, more>;')).toBe('password: ' + R + ';');
  });
  it('redacts digit-free values in log, flow-map, object-literal and pipe context', () => {
    const cases: [string, string][] = [
      ['user: admin, password: changeme, db: prod', 'user: admin, password: ' + R + ', db: prod'],
      ['Connecting with user=bob, password: letmein, host=x', 'Connecting with user=bob, password: ' + R + ', host=x'],
      ['{user: admin, password: CorrectHorseBattery, host: x}', '{user: admin, password: ' + R + ', host: x}'],
      ['f({user: admin, password: CorrectHorseBattery, host: x})', 'f({user: admin, password: ' + R + ', host: x})'],
      ['(user: admin, password: CorrectHorseBattery, host: x)', '(user: admin, password: ' + R + ', host: x)'],
      ['(password: changeme)', '(password: ' + R + ')'],
      ['f(a, token: letmein)', 'f(a, token: ' + R + ')'],
      ['password: changeme | base64', 'password: ' + R + ' | base64'],
      ['password: Hunter | base64', 'password: ' + R + ' | base64'],
      ['secret: foo[];', 'secret: ' + R + ';'],
      ['f(token: ref<Foo>)', 'f(token: ' + R + ')'],
    ];
    for (const [i, o] of cases) expect(redactSecrets(i)).toBe(o);
  });
  it('keeps PascalCase types in a real parameter list', () => {
    for (const c of ['function f(a: string, b: Map<string, number>, token: Token)', 'f(a?: Foo, token: Token = t)', 'f(token: Ref<Foo>)', 'secret: Foo | null;']) expect(redactSecrets(c)).toBe(c);
  });
  it('redacts a secret hidden in the type arguments of a generic', () => {
    for (const c of ['password: Map<hunter2secret99>', 'token: Promise<sk-ant-xxxxxxxx>', 'token: Promise<sk-ant-' + 'a'.repeat(30) + '>', 'password: Map<hunterpass>', 'f(token: Ref<abc=def>)', 'token: Map<a:b>;']) {
      const out = redactSecrets(c);
      expect(out).toContain(R);
      expect(out).not.toMatch(/hunter|sk-ant|abc=def|a:b/);
    }
    expect(redactSecrets('password: Map<string, number>')).toBe('password: Map<string, number>');
    expect(redactSecrets('token: Promise<NodeJS.Timeout | null>;')).toBe('token: Promise<NodeJS.Timeout | null>;');
  });
  it('treats a well-known generic as a type whole, also at end of line', () => {
    for (const c of ['password: Map<string, number>', 'token: Promise<Map<string, number>>', 'token: Record<string, string>\nnext']) expect(redactSecrets(c)).toBe(c);
  });
  it('accepts only balanced, digit-free generics and arrays as types', () => {
    for (const c of ['password: hunter2<3', 'password: Hunter<3', 'password: Pass<word>', 'token: abcd1[]']) expect(redactSecrets(c)).toBe(c.slice(0, c.indexOf(':') + 2) + R);
    for (const c of ['token: Promise<string>;', 'token: Record<string, string>,', 'token: Map<string, number>;', 'token: number[]', 'token: Promise<Map<string, number>>;']) expect(redactSecrets(c)).toBe(c);
  });
  it('is linear on hostile type-like input', () => {
    const t = Date.now();
    redactSecrets('token: A<'.repeat(110000));
    expect(Date.now() - t).toBeLessThan(200);
  });
  it('leaves no fragment of a secret straddling the 256 KB pre-cap', () => {
    const secret = 'sk-ant-' + 'abcdefghij'.repeat(4);
    const pad = 'x '.repeat((256 * 1024 - 10) / 2);
    const out = sanitizeToolPayload(pad + secret + ' tail', 1_000_000) as string;
    expect(out).not.toMatch(/sk-ant|abcdefgh|<reda(?!cted>)/);
    expect(out.length).toBeLessThanOrEqual(256 * 1024);
  });
  it('redacts a long bare value to its end and judges references on the whole token', () => {
    expect(redactSecrets('token=' + 'a'.repeat(900) + ' next')).toBe('token=' + R + ' next');
    expect(redactSecrets('token=this.x;rm')).toBe('token=this.x;rm');
    expect(redactSecrets('token=$TOKEN')).toBe('token=$TOKEN');
    expect(redactSecrets('token=$TOKEN/zzzzzz')).toBe('token=' + R);
  });
  it('leaves no fragment of a secret straddling the truncation point', () => {
    const secret = 'sk-ant-' + 'abcdefghij'.repeat(3);
    const out = sanitizeToolPayload('x'.repeat(190) + ' ' + secret + ' ' + 'y'.repeat(600), 300) as string;
    expect(out).not.toMatch(/abcdefgh/);
    expect(out).toContain('<redacted');
  });
});

// [input, secret core that must disappear, text that must survive]
const LEAK_FIXTURES: [string, string, string[]][] = [
  ['postgres://admin:S3cr3tPw@db.internal:5432/prod', 'S3cr3tPw', ['postgres://admin:', '@db.internal:5432/prod']],
  ['uri mongodb+srv://user:pw0rdXyz@cluster/db end', 'pw0rdXyz', ['mongodb+srv://user:', '@cluster/db end']],
  ['redis://:redisPw99@host:6379', 'redisPw99', ['redis://:', '@host:6379']],
  ['amqp://u:amqpPass1@h', 'amqpPass1', ['amqp://u:', '@h']],
  ['git clone https://user:tok12345678@github.com/x/y.git', 'tok12345678', ['git clone https://user:', '@github.com/x/y.git']],
  ['DB_PASS=hunter2hunter2', 'hunter2hunter2', ['DB_PASS=']],
  ['MYSQL_PWD=abc12345', 'abc12345', ['MYSQL_PWD=']],
  ['CREDENTIALS=credVal1234', 'credVal1234', ['CREDENTIALS=']],
  ['AUTH=authVal1234', 'authVal1234', ['AUTH=']],
  ['ACCESS_KEY=accessVal99', 'accessVal99', ['ACCESS_KEY=']],
  ['AWS_SESSION_TOKEN=FwoGZXIvYXdzEJr', 'FwoGZXIvYXdzEJr', ['AWS_SESSION_TOKEN=']],
  ['MNEMONIC="abandon ability able about above absent"', 'abandon ability', ['MNEMONIC=']],
  ['DATABASE_URL=postgres://u:pwSecret1@h/db', 'pwSecret1', ['DATABASE_URL=']],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop ok', 'abcdefghijklmnop', ['jwt ', ' ok']],
  ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF0pgpbody\n-----END PGP PRIVATE KEY BLOCK----- after', 'lQOYBF0pgpbody', [' after']],
  ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXk', []],
  ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHzBJBgkqhk\n-----END ENCRYPTED PRIVATE KEY-----', 'MIIFHzBJBgkqhk', []],
  ['stripe sk_live_' + '4eC39HqLyjWDarjt', '4eC39HqLyjWDarjt', ['stripe ']],
  ['sk_test_' + 'abcdefghijklmnop12', 'abcdefghijklmnop12', []],
  ['rk_live_' + 'abcdefghijklmnop34', 'abcdefghijklmnop34', []],
  ['key AIza' + 'SyA1234567890abcdefghijklmnopqrstuv', 'SyA1234567890abcdefghij', ['key ']],
  ['glpat-' + 'abcdefghij1234567890', 'abcdefghij1234567890', []],
  ['npm_' + 'abcdefghijklmnopqrstuvwxyz1234', 'abcdefghijklmnopqrstuvwxyz1234', []],
  ['hf_' + 'abcdefghijklmnopqrstuvwxyz1234', 'abcdefghijklmnopqrstuvwxyz1234', []],
  ['ghu_' + 'abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx', []],
  ['ghr_' + 'abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx', []],
  ['ASIA' + 'ABCDEFGHIJKLMNOP', 'ABCDEFGHIJKLMNOP', []],
  ['hook https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXX', 'XXXXXXXXXXXXXXXX', ['hook ']],
  ['SG.' + 'abcdefghijklmnopqrst' + '.' + 'uvwxyzABCDEFGHIJKLMN', 'abcdefghijklmnopqrst', []],
  ['SK' + '0123456789abcdef0123456789abcdef', '0123456789abcdef', []],
  ['sk-proj-' + 'abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx', []],
  ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz', ['Authorization: ']],
  ['Cookie: session=abc123def456; other=1', 'abc123def456', ['Cookie: ']],
  ['Set-Cookie: sid=sidValue1234; Path=/', 'sidValue1234', ['Set-Cookie: ']],
  ['X-Api-Key: xapikey12345', 'xapikey12345', ['X-Api-Key: ']],
  ['curl -u admin:curlPw99 https://api.example.com/x', 'curlPw99', ['curl -u ', ' https://api.example.com/x']],
  ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://x', 'dXNlcjpwYXNz', ['curl -H "Authorization: ', '" https://x']],
  ['passphrase: correcthorse1', 'correcthorse1', ['passphrase: ']],
  ['client_secret=clientSec123', 'clientSec123', ['client_secret=']],
  ['session_id: sess1234abcd', 'sess1234abcd', ['session_id: ']],
  ['dsn = "https://k@sentry.io/1"', 'k@sentry', ['dsn = "']],
  ['connection_string: Server=x;Pwd=y1234', 'Server=x', ['connection_string: ']],
  ['signing_key=signKey1234', 'signKey1234', ['signing_key=']],
  ['encryption-key: encKey12345', 'encKey12345', ['encryption-key: ']],
  ['authToken: authTok123456', 'authTok123456', ['authToken: ']],
  ['cookie: sid="abc123quoted"; x=1', 'abc123quoted', ['cookie: ']],
  ['Cookie: a=1; session="q u o t e d value"', 'q u o t e d', ['Cookie: ']],
  ['postgres://admin:pa/ss1234@db.internal/prod', 'pa/ss1234', ['postgres://admin:', '@db.internal/prod']],
  ['postgres://admin:p@ss1234@db.internal/prod', 'p@ss1234', ['postgres://admin:', '@db.internal/prod']],
  ['https://u:pw12345678@host/p?e=a@b.com', 'pw12345678', ['https://u:', '@host/p?e=a@b.com']],
  ['curl -uadmin:attachedPw1 https://x', 'attachedPw1', ['curl -u', ' https://x']],
  ['-u admin:startPw99 https://x', 'startPw99', [' https://x']],
  ['curl --user=admin:userEqPw1 https://x', 'userEqPw1', ['curl --user=']],
  ['curl -u 1000:numericPw2 https://x', 'numericPw2', ['curl -u ']],
  ['Authorization:\tBasic dXNlcjpwYXNz', 'dXNlcjpwYXNz', ['Authorization:']],
  ['password=\\"unterminatedA\\', 'unterminatedA', ['password=']],
  ['password=\\"unterminatedB\\\nnext: 1', 'unterminatedB', ['password=', '\nnext: 1']],
  ['password=\\"a\\\\\\"leakedtail\\"', 'leakedtail', ['password=']],
  ['{"value": "MNEMONIC=\\"abandon ability\\""}', 'abandon', ['{"value": "MNEMONIC=\\"']],
  ['{\\"user\\": \\"app\\", \\"password\\": \\"hunter2xyz\\"}', 'hunter2xyz', ['\\"user\\": \\"app\\"']],
];

describe('redactSecrets coverage (H1)', () => {
  it.each(LEAK_FIXTURES)('redacts %s', (input, core, keep) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(core);
    expect(out).toContain('<redacted>');
    for (const k of keep) expect(out).toContain(k);
    expect(redactSecrets(out)).toBe(out);
  });
  it('keeps scheme, user and host of a connection string', () => {
    expect(redactSecrets('postgres://admin:S3cr3tPw@db.internal:5432/prod')).toBe('postgres://admin:<redacted>@db.internal:5432/prod');
  });
  it('redacts a .env file read through a tool payload', () => {
    const out = JSON.stringify(sanitizeToolPayload({ content: 'DB_PASS=hunter2hunter2\nDATABASE_URL=postgres://u:pw@h/db' }));
    expect(out).not.toMatch(/hunter2|:pw@/);
  });
  it('leaves prose and non-secret look-alikes alone', () => {
    for (const c of [
      'the password field is required', 'password hunter2', 'Basic authentication is supported', 'author: Jane Doe',
      'authority: high', 'authentication: required', 'passed: 3, passing tests', 'https://example.com:8080/path',
      'ssh://git@github.com:22/x', 'docker run -u 1000:1000 img', 'docker run --rm -u www-data:www-data img', 'podman run -u app:app img', 'curl --user-agent foo https://x', 'cookie: string;', 'sessionId: string', 'API_URL=https://api.example.com',
      'eyJ is the start of a JWT', 'Ask the SK team', 'the AIza prefix',
    ]) expect(redactSecrets(c)).toBe(c);
  });
  it('is idempotent on every fixture', () => {
    for (const [i] of LEAK_FIXTURES) expect(redactSecrets(redactSecrets(i))).toBe(redactSecrets(i));
  });
  it('stays linear on 256 KB inputs aimed at the new rules', () => {
    for (const unit of ['eyJ', 'eyJa-', 'eyJaaaaaaaa.', '://a:b@', 'x://a:', 'Basic ', 'Authorization: Basic ', 'SG.a-', 'cookie: a', 'token=\\"a', 'token=\\"\\\\', 'cookie:', 'cookie:a', 'a://b:', 'x://a:@h', 'x://a:p@', ' -u a:', '-ua', ' docker -u a:b', ' ', 'Authorization: ', 'Authorization:      ', ' -u a', 'a.', 'pass', 'auth: ']) {
      const s = unit.repeat(Math.ceil(256 * 1024 / unit.length));
      const t = performance.now();
      redactSecrets(s);
      expect(performance.now() - t, unit).toBeLessThan(200);
    }
  });
  it('runs under 300 ms on 2 MB adversarial inputs', () => {
    const N = 2 * 1024 * 1024;
    const fill = (u: string) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const words = ['alpha', 'beta', 'token', 'password', 'gamma', 'secret', 'map', 'key', 'url', 'auth'];
    let random = '';
    while (random.length < N) random += words[Math.floor(rnd() * words.length)] + ' ';
    const inputs: [string, string][] = [
      ['random words', random],
      ['secret: Map<', fill('secret: Map<')],
      ['password: <<<', 'password: ' + '<'.repeat(N)],
      ['token=', fill('token=')],
      ['eyJ', fill('eyJ')],
      ['://a:b@', fill('://a:b@')],
      ['Basic ', fill('Basic ')],
      ['cookie:', fill('cookie:')],
      ['password=\\"', fill('password=\\"')],
      ['password=\\"a\\', fill('password=\\"a\\')],
      ['spaces', ' '.repeat(N)],
      ['a://b:', fill('a://b:')],
      [' -u a:', fill(' -u a:')],
      [' -u a:b', fill(' -u a:b')],
      [' docker -u a:b', fill(' docker -u a:b')],
      ['NFD Vietnamese', fill('Tiếng Việt có dấu mật khẩu '.normalize('NFD'))],
      ['no whitespace', 'a'.repeat(N)],
    ];
    for (const [name, s] of inputs) {
      const t = performance.now();
      redactSecrets(s);
      expect(performance.now() - t, name).toBeLessThan(300);
    }
  });
});
