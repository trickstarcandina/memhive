import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { startHub } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { loginCommand } from '../../src/cli/commands/login.js';
import { linkCommand } from '../../src/cli/commands/link.js';
import { syncCommand } from '../../src/cli/commands/sync.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { loadCredentials, saveCredentials } from '../../src/sync/credentials.js';
import { main } from '../../src/cli/index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const cap = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => { o.out += s; }, stderr: (s: string) => { o.err += s; } } }; };
const env = { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' };
let hub: Awaited<ReturnType<typeof startHub>>; let hubUrl: string; let key: string;
beforeAll(async () => {
  const hs = new SqliteHubStore(':memory:', { dims: null }); await hs.migrate();
  hub = await startHub(hs, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
  hubUrl = `http://127.0.0.1:${hub.port}`;
  await hs.createUser('alice'); const k = generateApiKey(); await hs.createApiKey('alice', 'l', k.hash); key = k.raw;
});
afterAll(async () => { await hub.close(); });

describe('login / link / sync / unlink', () => {
  it('login stores the key, never prints it, rejects a bad key, and clears authFailed', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    let c = cap(); expect(await loginCommand([hubUrl], c.io, { home, readKey: async () => 'mh_' + 'B'.repeat(43) })).toBe(1);
    expect(c.o.err).toMatch(/login failed/); expect(loadCredentials(home).hubs[hubUrl]).toBeUndefined();
    saveCredentials(home, { hubs: { [hubUrl]: { key: 'old', user: 'alice', authFailed: true } } });
    c = cap(); expect(await loginCommand([hubUrl], c.io, { home, readKey: async () => key })).toBe(0);
    expect(c.o.out).toContain('as alice'); expect(c.o.out + c.o.err).not.toContain(key);
    expect(loadCredentials(home).hubs[hubUrl]).toEqual({ key, user: 'alice' });
    c = cap(); expect(await loginCommand(['http://example.com'], c.io, { home, readKey: async () => key })).toBe(1);
    expect(c.o.err).toMatch(/https/);
  });
  it('link requires login, links, syncs; unlink clears; sync reports', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-')); const cwd = mkdtempSync(path.join(tmpdir(), 'mh-cwd-'));
    const d = await startDaemon(createDaemonContext(home, env), { port: 0 });
    try {
      let c = cap(); expect(await linkCommand([hubUrl], c.io, { home, cwd })).toBe(1); expect(c.o.err).toMatch(/not logged in/);
      c = cap(); expect(await syncCommand([], c.io, { home, cwd })).toBe(1); expect(c.o.err).toMatch(/not linked/);
      await loginCommand([hubUrl], cap().io, { home, readKey: async () => key });   // stops the daemon: restart it
      for (let i = 0; i < 40 && (await fetch(`http://127.0.0.1:${d.info.port}/healthz`).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 50));
    } finally { await d.close().catch(() => {}); }
    const d2 = await startDaemon(createDaemonContext(home, env), { port: 0 });
    try {
      let c = cap(); expect(await linkCommand([hubUrl], c.io, { home, cwd })).toBe(0); expect(c.o.out).toMatch(/linked .* -> /); expect(c.o.out).toMatch(/initial sync: pulled 0/);
      c = cap(); expect(await syncCommand([], c.io, { home, cwd })).toBe(0); expect(c.o.out).toMatch(/pushed 0 observations/);
      c = cap(); expect(await linkCommand([], c.io, { home, cwd, unlink: true })).toBe(0); expect(c.o.out).toMatch(/unlinked/);
      c = cap(); expect(await syncCommand([], c.io, { home, cwd })).toBe(1);
    } finally { await d2.close().catch(() => {}); }
  });
  it('--help for new commands has no side effects', async () => {
    for (const cmd of ['login', 'link', 'unlink', 'sync']) {
      const home = mkdtempSync(path.join(tmpdir(), 'mh-help-')); const prev = process.env.MEMHUB_HOME; process.env.MEMHUB_HOME = home;
      try { const c = cap(); expect(await main([cmd, '--help'], c.io)).toBe(0); expect(c.o.out).toContain(`memhub ${cmd}`); expect(c.o.err).toBe(''); }
      finally { if (prev === undefined) delete process.env.MEMHUB_HOME; else process.env.MEMHUB_HOME = prev; }
      expect(readdirSync(home)).toEqual([]);
    }
  });
});
