import { it, expect } from 'vitest';
import { generateApiKey, hashApiKey, RateLimiter, AuthThrottle } from '../../src/hub/auth.js';
it('generates mh_ keys and stable hashes', () => {
  const { raw, hash } = generateApiKey();
  expect(raw).toMatch(/^mh_[A-Za-z0-9_-]{43}$/);
  expect(hashApiKey(raw)).toBe(hash); expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(generateApiKey().raw).not.toBe(raw);
});
it('rate limiter allows 60 per window then blocks, resets after window', () => {
  const rl = new RateLimiter(60, 60_000);
  for (let i = 0; i < 60; i++) expect(rl.allow('k', 1000)).toBe(true);
  expect(rl.allow('k', 1000)).toBe(false);
  expect(rl.allow('other', 1000)).toBe(true);
  expect(rl.allow('k', 61_001)).toBe(true);
});
it('auth throttle is per client, windowed, and bounded in memory', () => {
  const t = new AuthThrottle(30, 60_000, 10_000);
  for (let i = 0; i < 30; i++) t.failed('A', 1000);
  expect(t.wait('A', 1000)).toBe(60); expect(t.wait('B', 1000)).toBe(0);
  expect(t.wait('A', 61_000)).toBe(0);
  for (let i = 0; i < 10_001; i++) t.failed(`fake-${i}`, 2000);
  expect(t.size).toBe(10_000);
});
