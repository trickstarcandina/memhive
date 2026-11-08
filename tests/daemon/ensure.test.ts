import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDaemon } from '../../src/daemon/ensure.js';
import { writeDaemonInfo } from '../../src/daemon/info.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';

describe('ensureDaemon', () => {
  it('returns running daemon info without spawning', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' }), { port: 0 });
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
});
