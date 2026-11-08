import { mkdtempSync, readFileSync, statSync } from 'node:fs';
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
it('serve writes the initial admin key to a 0600 file, not stdout', async () => {
  const env = serveEnv('4'); const file = path.join(env.MEMHIVE_HOME, 'hub-admin-key');
  let me = 0;
  const first = await withServe([], env, async (o) => {
    const port = /listening on 127\.0\.0\.1:(\d+)/.exec(o.out)![1];
    me = (await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { authorization: `Bearer ${readFileSync(file, 'utf8').trim()}` } })).status;
  });
  expect(first.code).toBe(0); expect(me).toBe(200);
  expect(statSync(file).mode & 0o777).toBe(0o600); expect(readFileSync(file, 'utf8')).toMatch(/^mh_[A-Za-z0-9_-]{43}\n$/);
  expect(first.out).toContain(file); expect(first.out).not.toMatch(/mh_/); expect(first.err).toBe('');
  const second = await withServe([], env); expect(second.out).not.toContain('First start');
  const other = serveEnv('4'); const custom = path.join(other.MEMHIVE_HOME, 'sub', 'admin.key');
  const printed = await withServe([], { ...other, MEMHIVE_ADMIN_KEY_FILE: custom, MEMHIVE_PRINT_ADMIN_KEY: '1' });
  expect(printed.out).toContain(custom); expect(printed.out).toContain(readFileSync(custom, 'utf8').trim());
  const blocked = serveEnv('4');
  const fail = await withServe([], { ...blocked, MEMHIVE_ADMIN_KEY_FILE: path.join(blocked.DATABASE_URL.slice(7), 'nested', 'k') });   // parent is a file
  expect(fail.code).toBe(1); expect(fail.err).toMatch(/cannot write the admin key/);
  const retry = await withServe([], blocked); expect(retry.out).toContain('First start');   // no key was stored, so the next start makes one
});
it('key rotate, key list --json, user list/remove, project list on a sqlite hub', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-admin-')); const env = { DATABASE_URL: `sqlite:${path.join(dir, 'h.db')}` };
  const run = async (fn: typeof keyCommand, args: string[]) => { const c = cap(); const code = await fn(args, c.io, env); return { code, ...c.o }; };
  const { userCommand, projectCommand } = await import('../../src/cli/commands/hub-admin.js');
  const created = JSON.parse((await run(keyCommand, ['create', '--user', 'dave', '--label', 'laptop', '--json'])).out);
  expect(created).toMatchObject({ userName: 'dave', label: 'laptop', key: expect.stringMatching(/^mh_/) });
  const rot = await run(keyCommand, ['rotate', 'dave']); expect(rot.code).toBe(0);
  const newKey = /\n {2}(mh_\S+)/.exec(rot.out)![1]; expect(newKey).not.toBe(created.key); expect(rot.out).toContain(`Rotated ${created.id}`);
  const keys = JSON.parse((await run(keyCommand, ['list', '--json'])).out);
  expect(keys.map((k: any) => [k.userName, k.label, !!k.revokedAt])).toEqual([['dave', 'laptop', true], ['dave', 'laptop', false]]);
  expect(JSON.stringify(keys)).not.toMatch(/mh_/);
  const byId = JSON.parse((await run(keyCommand, ['rotate', keys[1].id, '--json'])).out); expect(byId).toMatchObject({ revoked: keys[1].id, userName: 'dave' });
  await run(keyCommand, ['create', '--user', 'dave', '--label', 'desk']);
  const amb = await run(keyCommand, ['rotate', 'dave']); expect(amb.code).toBe(1); expect(amb.err).toMatch(/2 active keys; rotate one by id/);
  expect((await run(keyCommand, ['rotate', 'nobody'])).code).toBe(1);
  expect((await run(keyCommand, ['rotate'])).err).toMatch(/usage/);
  const users = JSON.parse((await run(userCommand, ['list', '--json'])).out); expect(users).toEqual([expect.objectContaining({ name: 'dave', activeKeys: 2, observations: 0, lastSeen: null })]);
  expect((await run(userCommand, ['list'])).out).toMatch(/dave\s+2 keys/);
  const rm = await run(userCommand, ['remove', 'dave']); expect(rm.code).toBe(0); expect(rm.out).toMatch(/revoked 2 key\(s\) of dave\. Kept on the hub: 0 sessions, 0 observations, 0 summaries/);
  expect(JSON.parse((await run(userCommand, ['list', '--json'])).out)[0].activeKeys).toBe(0);
  expect((await run(userCommand, ['remove', 'dave', '--json'])).out).toContain('"revokedKeys": 0');
  expect((await run(userCommand, ['remove', 'ghost'])).code).toBe(1);
  expect((await run(userCommand, ['nope'])).err).toMatch(/usage: memhive user/);
  const { SqliteHubStore } = await import('../../src/hub/store/sqlite.js');
  const st = new SqliteHubStore(path.join(dir, 'h.db'), { dims: null }); await st.migrate(); await st.getOrCreateProject('github.com/a/b', 'b'); await st.close();
  expect(JSON.parse((await run(projectCommand, ['list', '--json'])).out)).toEqual([expect.objectContaining({ key: 'github.com/a/b', observations: 0, sessions: 0, lastActivity: null })]);
  expect((await run(projectCommand, ['list'])).out).toMatch(/github\.com\/a\/b {2}\(b\) {2}0 observations/);
  for (const cmd of ['user', 'project']) { const h = cap(); expect(await main([cmd, '--help'], h.io)).toBe(0); expect(h.o.out).toMatch(new RegExp(`usage: memhive ${cmd}`)); }
});
const pgUrl = process.env.TEST_DATABASE_URL;
it.skipIf(!pgUrl)('key rotate against postgres', async () => {
  // own database: other suites drop the public schema of TEST_DATABASE_URL in parallel
  const { Pool } = await import('pg'); const name = 'memhive_test_cli';
  const admin = new Pool({ connectionString: pgUrl }); if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const u = new URL(pgUrl!); u.pathname = '/' + name; const env = { DATABASE_URL: u.toString(), MEMHIVE_EMBED_DIMS: '4' };
  const p = new Pool({ connectionString: env.DATABASE_URL }); await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;'); await p.end();
  let c = cap(); expect(await keyCommand(['create', '--user', 'erin', '--json'], c.io, env)).toBe(0); const old = JSON.parse(c.o.out);
  c = cap(); expect(await keyCommand(['rotate', 'erin', '--json'], c.io, env)).toBe(0); const rot = JSON.parse(c.o.out);
  expect(rot).toMatchObject({ revoked: old.id, userName: 'erin' });
  const { PostgresHubStore } = await import('../../src/hub/store/postgres.js'); const { hashApiKey } = await import('../../src/hub/auth.js');
  const st = new PostgresHubStore(env.DATABASE_URL, { dims: 4 });
  expect(await st.authenticate(hashApiKey(old.key))).toBeNull(); expect(await st.authenticate(hashApiKey(rot.key))).toEqual({ keyId: rot.id, userName: 'erin' });
  await st.close();
  // an admin command with other dims (and a reset flag in its env) neither refuses nor touches the vector column
  c = cap(); expect(await keyCommand(['list'], c.io, { ...env, MEMHIVE_EMBED_DIMS: '8', MEMHIVE_RESET_VECTORS: '1' })).toBe(0); expect(c.o.err).toBe('');
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  expect((await pool.query(`SELECT format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid = 'observations'::regclass AND attname = 'embedding'`)).rows[0].t).toBe('vector(4)');
  await pool.end();
});
it('admin commands skip the dims guard and never reset vectors (sqlite)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-admindims-')); const file = path.join(dir, 'h.db');
  const { SqliteHubStore } = await import('../../src/hub/store/sqlite.js'); const { hobs, hsess } = await import('./hub-store-contract.js');
  const st = new SqliteHubStore(file, { dims: 4 }); await st.migrate();
  const p = await st.getOrCreateProject('k', 'n'); const a = hsess(p.id); await st.upsertSessions([a]);
  const o = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0], embeddingModel: 'm' }); await st.insertObservations([o]); await st.close();
  const { userCommand, projectCommand } = await import('../../src/cli/commands/hub-admin.js');
  for (const env of [{ DATABASE_URL: `sqlite:${file}` }, { DATABASE_URL: `sqlite:${file}`, MEMHIVE_EMBED_DIMS: '8', MEMHIVE_RESET_VECTORS: '1' }]) {
    for (const [fn, args] of [[keyCommand, ['list']], [userCommand, ['list']], [projectCommand, ['list']]] as const) {
      const c = cap(); expect(await fn([...args], c.io, env)).toBe(0); expect(c.o.err).toBe('');
    }
  }
  const again = new SqliteHubStore(file, { dims: 4 }); await again.migrate();   // still a dims-4 hub, vector kept
  expect((await again.getObservations([o.id]))[0].embedding).toEqual([1, 0, 0, 0]); await again.close();
});
