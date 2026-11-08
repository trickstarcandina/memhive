import { it, expect } from 'vitest';
import { mkdtempSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCredentials, saveCredentials, normalizeHubUrl, defaultUser } from '../../src/sync/credentials.js';

it('round trips with 0600 file in a 0700 dir, atomically', () => {
  const home = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'sub');
  expect(loadCredentials(home)).toEqual({ hubs: {} });
  saveCredentials(home, { hubs: { 'https://hub': { key: 'mh_x', user: 'alice' } } });
  expect(loadCredentials(home).hubs['https://hub'].user).toBe('alice');
  expect(statSync(path.join(home, 'credentials.json')).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(readdirSync(home)).toEqual(['credentials.json']);
  expect(defaultUser(loadCredentials(home))).toBe('alice');
  expect(defaultUser({ hubs: { a: { key: 'k', user: 'u', authFailed: true } } })).toBeNull();
});
it('ignores malformed entries', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { a: { key: 1 as any, user: 'u' }, b: { key: 'k', user: 'u' } } });
  expect(Object.keys(loadCredentials(home).hubs)).toEqual(['b']);
});
it('normalizeHubUrl', () => {
  expect(normalizeHubUrl('https://hub.example.com/')).toBe('https://hub.example.com');
  expect(normalizeHubUrl('http://localhost:7777')).toBe('http://localhost:7777');
  expect(normalizeHubUrl('http://127.0.0.1:7777/')).toBe('http://127.0.0.1:7777');
  expect(() => normalizeHubUrl('http://hub.example.com')).toThrow(/https/);
  expect(() => normalizeHubUrl('ftp://x')).toThrow();
});
