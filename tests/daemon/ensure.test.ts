import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDaemon } from '../../src/daemon/ensure.js';
import { readDaemonInfo, writeDaemonInfo } from '../../src/daemon/info.js';
import { SqliteStore, DatabaseNewerThanBinary } from '../../src/store/sqlite/store.js';
import { VERSION } from '../../src/shared/version.js';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';

describe('ensureDaemon', () => {
  it('returns running daemon info without spawning', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' }), { port: 0 });
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
  const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };
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
  });
});
