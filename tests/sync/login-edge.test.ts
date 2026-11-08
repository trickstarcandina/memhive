import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginCommand } from '../../src/cli/commands/login.js';
import { loadCredentials, saveCredentials } from '../../src/sync/credentials.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const cap = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => { o.out += s; }, stderr: (s: string) => { o.err += s; } } }; };
const KEY = 'mh_' + 'K'.repeat(43);

let server: http.Server | undefined;
const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
afterEach(async () => {
  Object.defineProperty(process, 'stdin', origStdin);
  vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); const s = server; server = undefined; await new Promise((r) => s.close(r)); }
});
// Hub stub: /v1/me ok; /v1/config returns the given status/body.
const fakeHub = async (config: { status: number; body?: unknown }): Promise<string> => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/me') return void res.end('{"user":"alice"}');
    res.statusCode = config.status; res.end(JSON.stringify(config.body ?? {}));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

describe('login edge cases', () => {
  it('Ctrl-C at the key prompt cancels with 130 and stores nothing', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const home = mkHome(); const c = cap();
    const p = loginCommand(['https://hub.example.com'], c.io, { home });
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('\x03');
    expect(await p).toBe(130);
    expect(c.o.err).toContain('cancelled');
    expect(loadCredentials(home).hubs).toEqual({});
  });

  it('empty key is rejected before any network call', async () => {
    const c = cap();
    expect(await loginCommand(['https://hub.example.com'], c.io, { home: mkHome(), readKey: async () => '' })).toBe(1);
    expect(c.o.err).toContain('no API key');
  });

  it('missing url prints usage', async () => {
    const c = cap();
    expect(await loginCommand([], c.io, { home: mkHome() })).toBe(2);
    expect(c.o.err).toContain('usage: memhive login');
  });

  it('config endpoint failure warns but still logs in and saves the key', async () => {
    const hubUrl = await fakeHub({ status: 500 });
    const home = mkHome(); const c = cap();
    expect(await loginCommand([hubUrl], c.io, { home, readKey: async () => KEY })).toBe(0);
    expect(c.o.out).toContain('logged in to');
    expect(c.o.out).toContain('warning: could not read hub config');
    expect(c.o.out + c.o.err).not.toContain(KEY);
    expect(loadCredentials(home).hubs[hubUrl]).toEqual({ key: KEY, user: 'alice' });
  });

  it('warns when the hub embedding model differs from local settings', async () => {
    const hubUrl = await fakeHub({ status: 200, body: { embedding_model: 'bge-m3', embedding_dims: 1024 } });
    const c = cap();
    expect(await loginCommand([hubUrl], c.io, { home: mkHome(), readKey: async () => KEY })).toBe(0);
    expect(c.o.out).toContain('hub embeds with bge-m3/1024');
    expect(c.o.out).toContain('no embedder');
  });

  it('a failed save leaves no .tmp file behind', () => {
    const home = mkHome();
    // credentials.json is a non-empty directory, so rename(tmp -> target) fails
    mkdirSync(path.join(home, 'credentials.json')); writeFileSync(path.join(home, 'credentials.json', 'keep'), 'x');
    expect(() => saveCredentials(home, { hubs: { 'https://b': { key: 'k', user: 'u' } } })).toThrow();
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
