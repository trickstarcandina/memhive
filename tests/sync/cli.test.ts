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
import { projectKeyFor } from '../../src/shared/project-key.js';
import { obs, sess } from '../store/store-contract.js';
import { main } from '../../src/cli/index.js';
import { deadUrl } from '../helpers/closed-port.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const cap = () => {
  const o = { out: '', err: '' };
  return {
    o,
    io: {
      stdout: (s: string) => {
        o.out += s;
      },
      stderr: (s: string) => {
        o.err += s;
      },
    },
  };
};
const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
let hub: Awaited<ReturnType<typeof startHub>>;
let hubUrl: string;
let key: string;
let hs: SqliteHubStore;
beforeAll(async () => {
  hs = new SqliteHubStore(':memory:', { dims: null });
  await hs.migrate();
  hub = await startHub(hs, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
  hubUrl = `http://127.0.0.1:${hub.port}`;
  await hs.createUser('alice');
  const k = generateApiKey();
  await hs.createApiKey('alice', 'l', k.hash);
  key = k.raw;
});
afterAll(async () => {
  await hub.close();
});

describe('login / link / sync / unlink', () => {
  it('login stores the key, never prints it, rejects a bad key, and clears authFailed', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    let c = cap();
    expect(await loginCommand([hubUrl], c.io, { home, readKey: async () => 'mh_' + 'B'.repeat(43) })).toBe(1);
    expect(c.o.err).toMatch(/login failed/);
    expect(loadCredentials(home).hubs[hubUrl]).toBeUndefined();
    saveCredentials(home, { hubs: { [hubUrl]: { key: 'old', user: 'alice', authFailed: true } } });
    c = cap();
    expect(await loginCommand([hubUrl], c.io, { home, readKey: async () => key })).toBe(0);
    expect(c.o.out).toContain('as alice');
    expect(c.o.out + c.o.err).not.toContain(key);
    expect(loadCredentials(home).hubs[hubUrl]).toEqual({ key, user: 'alice' });
    c = cap();
    expect(await loginCommand(['http://example.com'], c.io, { home, readKey: async () => key })).toBe(1);
    expect(c.o.err).toMatch(/https/);
  });
  it('link requires login, links, syncs; unlink clears; sync reports', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'mh-cwd-'));
    const d = await startDaemon(createDaemonContext(home, env), { port: 0 });
    try {
      let c = cap();
      expect(await linkCommand([hubUrl], c.io, { home, cwd })).toBe(1);
      expect(c.o.err).toMatch(/not logged in/);
      c = cap();
      expect(await syncCommand([], c.io, { home, cwd })).toBe(1);
      expect(c.o.err).toMatch(/not linked/);
      await loginCommand([hubUrl], cap().io, { home, readKey: async () => key }); // stops the daemon: restart it
      for (
        let i = 0;
        i < 40 &&
        (await fetch(`http://127.0.0.1:${d.info.port}/healthz`).then(
          () => true,
          () => false
        ));
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
    } finally {
      await d.close().catch(() => {});
    }
    const d2 = await startDaemon(createDaemonContext(home, env), { port: 0 });
    try {
      let c = cap();
      expect(await linkCommand([hubUrl], c.io, { home, cwd })).toBe(0);
      expect(c.o.out).toMatch(/linked .* -> /);
      expect(c.o.out).toMatch(/initial sync: pushed 0 observations, pulled 0 rows/);
      c = cap();
      expect(await syncCommand([], c.io, { home, cwd })).toBe(0);
      expect(c.o.out).toMatch(/pushed 0 observations/);
      c = cap();
      expect(await linkCommand([], c.io, { home, cwd, unlink: true })).toBe(0);
      expect(c.o.out).toMatch(/unlinked/);
      c = cap();
      expect(await syncCommand([], c.io, { home, cwd })).toBe(1);
    } finally {
      await d2.close().catch(() => {});
    }
  });
  it('relinking to a new hub resets sync state', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'mh-cwd-'));
    await loginCommand([hubUrl], cap().io, { home, readKey: async () => key });
    const ctx = createDaemonContext(home, env);
    const d = await startDaemon(ctx, { port: 0 });
    try {
      const { key: pk, name } = projectKeyFor(cwd);
      const p = ctx.store.getOrCreateProject(pk, name);
      const s = sess(p.id);
      ctx.store.upsertSession(s);
      ctx.store.insertObservations([obs({ projectId: p.id, sessionId: s.id })]);
      const theirs = sess(p.id, { userId: 'bob', origin: 'hub', syncedAt: 'pulled' });
      ctx.store.upsertSession(theirs); // a teammate's session pulled from the old hub
      ctx.store.markSynced('sessions', [s.id], 'now');
      ctx.store.markSynced(
        'observations',
        ctx.store.listUnsynced('observations', p.id, 5).map((o) => o.id),
        'now'
      );
      ctx.store.setPullCursor(p.id, 999999);
      expect(ctx.store.listUnsynced('sessions', p.id, 5)).toHaveLength(0);
      const c = cap();
      expect(await linkCommand([hubUrl], c.io, { home, cwd })).toBe(0);
      expect(c.o.out).toMatch(/initial sync: pushed 1 observations, pulled \d+ rows/);
      // the new hub's log holds exactly what we pushed (session + observation), so a cursor restarted from 0 ends at that seq
      const hubProject = (await hs.getProjectByKey(pk))!;
      expect(ctx.store.getPullCursor(p.id)).toBe(await hs.maxSeq(hubProject.id));
      expect((await hs.listSyncLog(hubProject.id, 0, 10)).map((e) => e.rowId)).toHaveLength(2);
      expect(await hs.getSessions([theirs.id])).toEqual([]); // not re-published under our name
      expect(ctx.store.getSession(theirs.id)!.syncedAt).toBe('pulled');
      expect(ctx.store.listRecentObservations(p.id, 1)[0].syncedAt).not.toBe('now'); // re-pushed to the new hub
      expect(ctx.store.getProject(p.id)!.hubUrl).toBe(hubUrl);
      expect(ctx.store.countObservations(p.id)).toBe(1);
    } finally {
      await d.close().catch(() => {});
    }
  });
  it('sync that outlasts the CLI wait reports it continues in the background, not an error', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'mh-cwd-'));
    await loginCommand([hubUrl], cap().io, { home, readKey: async () => key });
    const ctx = createDaemonContext(home, env);
    const d = await startDaemon(ctx, { port: 0 });
    try {
      expect(await linkCommand([hubUrl], cap().io, { home, cwd })).toBe(0);
      ctx.sync!.syncNow = () => new Promise((r) => setTimeout(() => r({ pushed: null, pulled: 0 }), 300));
      const c = cap();
      expect(await syncCommand([], c.io, { home, cwd, waitMs: 50 })).toBe(0);
      expect(c.o.out).toMatch(/continues in the background/);
      expect(c.o.err).toBe('');
    } finally {
      await d.close().catch(() => {});
    }
  });
  it('--help for new commands has no side effects', async () => {
    for (const cmd of ['login', 'link', 'unlink', 'sync']) {
      const home = mkdtempSync(path.join(tmpdir(), 'mh-help-'));
      const prev = process.env.MEMHIVE_HOME;
      process.env.MEMHIVE_HOME = home;
      try {
        const c = cap();
        expect(await main([cmd, '--help'], c.io)).toBe(0);
        expect(c.o.out).toContain(`memhive ${cmd}`);
        expect(c.o.err).toBe('');
      } finally {
        if (prev === undefined) delete process.env.MEMHIVE_HOME;
        else process.env.MEMHIVE_HOME = prev;
      }
      expect(readdirSync(home)).toEqual([]);
    }
  });
});
