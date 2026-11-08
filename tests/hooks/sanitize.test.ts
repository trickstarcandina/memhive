import { describe, it, expect } from 'vitest';
import { stripPrivate, sanitizeToolPayload, sanitizePrompt, redactSecrets } from '../../src/hooks/sanitize.js';

describe('stripPrivate', () => {
  it('removes closed private blocks, case-insensitive, multiline', () => {
    expect(stripPrivate('a <private>\nsecret\n</PRIVATE> b')).toBe('a  b');
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
  it('redacts secret-named keys in payloads but keeps counts', () => {
    expect(sanitizeToolPayload({ password: 'x', n: { apiKey: 5 } })).toEqual({ password: R, n: { apiKey: R } });
    expect(sanitizeToolPayload({ max_tokens: 2048, maxTokens: 2048 })).toEqual({ max_tokens: 2048, maxTokens: 2048 });
  });
});
