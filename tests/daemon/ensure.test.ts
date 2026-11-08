import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDaemon, olderThan } from '../../src/daemon/ensure.js';
import { readDaemonInfo, writeDaemonInfo } from '../../src/daemon/info.js';
import { SqliteStore, DatabaseNewerThanBinary } from '../../src/store/sqlite/store.js';
import { VERSION } from '../../src/shared/version.js';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { daemonUnavailableMessage } from '../../src/cli/daemon-unavailable.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { deadUrl } from '../helpers/closed-port.js';

describe('ensureDaemon', () => {
  it('returns running daemon info without spawning', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' }), { port: 0 });
    let spawned = 0;
    const info = await ensureDaemon(home, { wait: true, spawn: () => { spawned++; } });
    expect(info!.port).toBe(h.info.port); expect(spawned).toBe(0);
    await h.close();
  });
  it('overwrites a stale daemon.json and spawns', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeDaemonInfo(home, { port: 1, pid: 999999, token: 't', startedAt: '2020-01-01T00:00:00Z' });
    let spawned = 0;
    const info = await ensureDaemon(home, { wait: false, spawn: () => { spawned++; } });
    expect(info).toBeNull(); expect(spawned).toBe(1);
  });
  it('wait=true gives up after waitMs when the daemon never comes up', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const info = await ensureDaemon(home, { wait: true, spawn: () => {}, waitMs: 300 });
    expect(info).toBeNull();
  });
  it('respawns when daemon.json names a live foreign pid that never answers and is old', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeDaemonInfo(home, { port: 1, pid: process.pid, token: 't', startedAt: '2020-01-01T00:00:00Z' });
    let spawned = 0;
    expect(await ensureDaemon(home, { wait: false, spawn: () => { spawned++; } })).toBeNull();
    expect(spawned).toBe(1);
  });
});

describe('daemon version', () => {
  const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
  it('daemon.json and /healthz carry the version', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    expect(readDaemonInfo(home)!.version).toBe(VERSION);
    expect((await (await fetch(`http://127.0.0.1:${h.info.port}/healthz?nonce=n`)).json()).version).toBe(VERSION);
    await h.close();
  });
  it('a daemon of another version is shut down gracefully and a new one spawned', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const old = await startDaemon(createDaemonContext(home, env), { port: 0 });
    let spawned = 0;
    let fresh: Awaited<ReturnType<typeof startDaemon>> | null = null;
    const info = await ensureDaemon(home, { wait: true, waitMs: 3000, version: '9.9.9', spawn: () => { spawned++; void startDaemon(createDaemonContext(home, env), { port: 0 }).then((h) => { fresh = h; writeDaemonInfo(home, { ...h.info, version: '9.9.9' }); }); } });
    expect(spawned).toBe(1);
    expect(info!.token).not.toBe(old.info.token);
    expect(info!.version).toBe('9.9.9');
    await old.close(); await fresh!.close();
  });
  it('a hook that cannot wait only asks the stale daemon to stop', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const old = await startDaemon(createDaemonContext(home, env), { port: 0 });
    let spawned = 0;
    expect(await ensureDaemon(home, { wait: false, version: '9.9.9', spawn: () => { spawned++; } })).toBeNull();
    expect(spawned).toBe(0);
    for (let i = 0; i < 100 && readDaemonInfo(home); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readDaemonInfo(home)).toBeNull();
    await old.close();
  });
  it('refuses a database migrated by a newer memhive; doctor and daemon run say so', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const s = new SqliteStore(path.join(home, 'memhive.db'), { dims: null }); s.migrate();
    (s as any).db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(999, 'x'); s.close();
    expect(() => createDaemonContext(home, env)).toThrow(DatabaseNewerThanBinary);
    expect(() => createDaemonContext(home, env)).toThrow(/schema version 999.*Upgrade memhive/);
    const err: string[] = [];
    expect(await daemonCommand(['run'], { stdout: () => {}, stderr: (x) => err.push(x) }, { home })).toBe(1);
    expect(err.join('')).toContain('newer memhive');
    const out: string[] = [];
    await doctorCommand([], { stdout: (x) => out.push(x), stderr: () => {} }, { home, env, ping: false, cwd: home });
    expect(out.join('')).toMatch(/FAIL database: .*schema version 999/);
    expect(readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8')).toContain('cannot open the database');
    expect(daemonUnavailableMessage(home)).toMatch(/schema version 999/);   // what search, embed, link, sync, daemon start print
    expect(daemonUnavailableMessage(mkdtempSync(path.join(tmpdir(), 'mh-')))).toContain('daemon unavailable');
  });
});

describe('version skew direction and the lock (M1, M4)', () => {
  const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
  it('olderThan compares x.y.z, treats a missing version and pre-releases as older', () => {
    expect([olderThan('0.1.9', '0.2.0'), olderThan('0.10.0', '0.9.9'), olderThan(undefined, '0.2.0'), olderThan('0.2.0-rc.1', '0.2.0'), olderThan('0.2.0', '0.2.0'), olderThan('0.3.0', '0.2.0')])
      .toEqual([true, false, true, true, false, false]);
  });
  it('an older caller uses a newer daemon as it is, warns once, sends no shutdown', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    const urls: string[] = []; const warns: string[] = [];
    const fetchImpl = (async (u: string, i?: RequestInit) => { urls.push(String(u)); return fetch(u, i); }) as typeof fetch;
    for (let i = 0; i < 2; i++) expect((await ensureDaemon(home, { wait: true, version: '0.0.1', fetchImpl, warn: (m) => warns.push(m), spawn: () => { throw new Error('no spawn'); } }))!.token).toBe(h.info.token);
    expect(urls.some((u) => u.includes('/v1/shutdown'))).toBe(false);
    expect(warns).toHaveLength(1);
    await h.close();
  });
  it('a new daemon never breaks the lock of a live daemon that is still shutting down', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'memhive', 'daemon', 'run'], { env: { ...process.env, MEMHIVE_HOME: home }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const lock = path.join(home, 'daemon.lock');
      writeFileSync(lock, String(old.pid)); utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      const c1 = createDaemonContext(home, env);
      await expect(startDaemon(c1, { port: 0, lockWaitMs: 300 })).rejects.toMatchObject({ name: 'DaemonAlreadyRunning' });
      c1.store.close();
      expect(readFileSync(lock, 'utf8')).toBe(String(old.pid));   // not broken
      setTimeout(() => old.kill('SIGKILL'), 200);
      const d = await startDaemon(createDaemonContext(home, env), { port: 0, lockWaitMs: 5000 });   // waits, then takes over
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      await d.close();
    } finally { old.kill('SIGKILL'); }
  });
});
