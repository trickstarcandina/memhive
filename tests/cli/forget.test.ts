import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forgetCommand } from '../../src/cli/commands/forget.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import { obs, sess } from '../store/store-contract.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }; };
const baseEnv = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };
const stdin = (s: string) => Readable.from([s]);

describe('memhive forget', () => {
  it('shows the rows, asks, and deletes only on yes; teammate rows need --force and stay unpushed', async () => {
    const home = mkHome(); const cwd = mkHome();
    const ctx = createDaemonContext(home, baseEnv);
    const { key, name } = projectKeyFor(cwd);
    const p = ctx.store.getOrCreateProject(key, name); const s = sess(p.id); ctx.store.upsertSession(s);
    const mine = obs({ projectId: p.id, sessionId: s.id, title: 'Pasted a password', userId: 'alice' });
    const theirs = obs({ projectId: p.id, sessionId: s.id, title: 'Bob note', userId: 'bob', origin: 'hub', syncedAt: new Date().toISOString() });
    ctx.store.insertObservations([mine, theirs]);
    const h = await startDaemon(ctx, { port: 0 });
    try {
      const id8 = mine.id.slice(-8); const their8 = theirs.id.slice(-8);
      let r = io();
      expect(await forgetCommand([id8], r.io, { home, cwd, input: stdin('n\n') })).toBe(1);
      expect(r.out.join('')).toMatch(new RegExp(`#${id8} · discovery · Pasted a password · alice · \\d{4}-\\d\\d-\\d\\d`));
      expect(r.err.join('')).toContain('aborted');
      expect(ctx.store.getObservations([mine.id])).toHaveLength(1);

      r = io();
      expect(await forgetCommand([id8, their8], r.io, { home, cwd, input: stdin('y\n') })).toBe(0);
      expect(r.err.join('')).toMatch(/someone else.*--force[\s\S]*Bob note · bob/);
      expect(r.out.join('')).toContain('Forgot 1:');
      expect(ctx.store.getObservations([mine.id])).toEqual([]);
      expect(ctx.store.listPendingTombstones(p.id, 10).map((t) => t.id)).toEqual([mine.id]);

      r = io();
      expect(await forgetCommand([their8, '--project', 'github.com/else/where', '--yes'], r.io, { home, cwd })).toBe(1);
      expect(r.err.join('')).toContain(`not found in github.com/else/where: ${their8}`);

      r = io();
      expect(await forgetCommand(['--force', their8, '--yes'], r.io, { home, cwd })).toBe(0);   // --force before the id: not swallowed
      expect(ctx.store.getObservations([theirs.id])).toEqual([]);
      expect(ctx.store.listPendingTombstones(p.id, 10).map((t) => t.id)).toEqual([mine.id]);   // the forced removal is not pushed
      expect(ctx.store.forgottenIds(p.id, [theirs.id]).size).toBe(1);

      r = io();
      expect(await forgetCommand([], r.io, { home, cwd })).toBe(1);
      expect(r.err.join('')).toContain('usage: memhive forget');
    } finally { await h.close(); }
  });
});
