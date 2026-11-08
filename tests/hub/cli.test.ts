import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { serveCommand } from '../../src/cli/commands/serve.js';
import { keyCommand } from '../../src/cli/commands/key.js';
import { main } from '../../src/cli/index.js';

const cap = () => { const o = { out: '', err: '' }; return { o, io: { stdout: (s: string) => { o.out += s; }, stderr: (s: string) => { o.err += s; } } }; };

it('serve exits 1 with a clear error when DATABASE_URL is unset or unreachable, without listening', async () => {
  let c = cap(); expect(await serveCommand([], c.io, {})).toBe(1); expect(c.o.err).toMatch(/DATABASE_URL/);
  c = cap(); expect(await serveCommand([], c.io, { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', PORT: '0' })).toBe(1);
  expect(c.o.err).toMatch(/database unreachable/); expect(c.o.out).toBe('');
});
it('key create/list/revoke on a sqlite file, and --help is side-effect free', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-key-')); const env = { DATABASE_URL: `sqlite:${path.join(dir, 'h.db')}` };
  let c = cap(); expect(await keyCommand(['create'], c.io, env)).toBe(1); expect(c.o.err).toMatch(/usage/);
  c = cap(); expect(await keyCommand(['create', '--user', 'carol'], c.io, env)).toBe(0);
  const id = /Created key (\S+) for carol/.exec(c.o.out)![1]; expect(c.o.out).toMatch(/mh_[A-Za-z0-9_-]{43}/);
  c = cap(); await keyCommand(['list'], c.io, env); expect(c.o.out).toContain('carol'); expect(c.o.out).not.toMatch(/mh_/);
  c = cap(); await keyCommand(['revoke', id], c.io, env); expect(c.o.out).toMatch(/revoked/);
  c = cap(); await keyCommand(['list'], c.io, env); expect(c.o.out).toContain('REVOKED');
  const h = cap(); expect(await main(['serve', '--help'], h.io)).toBe(0); expect(h.o.out).toMatch(/usage: memhive serve/);
  const k = cap(); expect(await main(['key', '-h'], k.io)).toBe(0); expect(k.o.out).toMatch(/usage: memhive key/);
});
// Runs serve until `run` finishes, then stops it through the abort signal.
export async function withServe(args: string[], env: NodeJS.ProcessEnv, run: (out: { out: string; err: string }) => Promise<void> = async () => {}): Promise<{ code: number; out: string; err: string }> {
  const c = cap(); const ctl = new AbortController();
  const done = serveCommand(args, c.io, env, { signal: ctl.signal });
  const first = await Promise.race([done, (async () => { while (!c.o.out.includes('listening')) await new Promise((r) => setTimeout(r, 10)); return null; })()]);
  if (first === null) { await run(c.o); ctl.abort(); }
  return { code: await done, ...c.o };
}
const serveEnv = (dims: string) => { const dir = mkdtempSync(path.join(tmpdir(), 'mh-serve-')); return { DATABASE_URL: `sqlite:${path.join(dir, 'h.db')}`, MEMHIVE_HOME: dir, PORT: '0', MEMHIVE_EMBED_DIMS: dims }; };
it('serve refuses to start on a dims change; --reset-vectors (flag or env) lets it start', async () => {
  const env = serveEnv('4');
  expect((await withServe([], env)).code).toBe(0);
  const bad = await withServe([], { ...env, MEMHIVE_EMBED_DIMS: '8' });
  expect(bad.code).toBe(1); expect(bad.err).toContain('hub embedding dims is 4 in the database but MEMHIVE_EMBED_DIMS=8'); expect(bad.err).not.toMatch(/unreachable/);
  expect((await withServe(['--reset-vectors'], { ...env, MEMHIVE_EMBED_DIMS: '8' })).code).toBe(0);
  expect((await withServe([], { ...env, MEMHIVE_EMBED_DIMS: '16', MEMHIVE_RESET_VECTORS: '1' })).code).toBe(0);
  expect((await withServe([], { ...env, MEMHIVE_EMBED_DIMS: '8' })).code).toBe(1);
});
