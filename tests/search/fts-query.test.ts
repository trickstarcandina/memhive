import { it, expect } from 'vitest';
import { toFtsQuery } from '../../src/store/sqlite/fts-query.js';
it.each([
  ['auth: "token" OR jwt*', '"auth" "token" "or" "jwt"'],
  ['  ', ''],
  ['Đăng nhập lỗi', '"đăng" "nhập" "lỗi"'],
  ['a-b_c', '"a" "b_c"'],
  ['dup dup dup', '"dup"'],
])('%s', (i, o) => expect(toFtsQuery(i)).toBe(o));
it('normalizes decomposed (NFD) Vietnamese so combining marks stay in the token', () => {
  expect(toFtsQuery('Đăng nhập lỗi'.normalize('NFD'))).toBe('"đăng" "nhập" "lỗi"');
});
