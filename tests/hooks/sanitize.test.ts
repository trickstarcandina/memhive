import { describe, it, expect } from 'vitest';
import { stripPrivate, sanitizeToolPayload, sanitizePrompt } from '../../src/hooks/sanitize.js';

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
