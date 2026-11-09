import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupCommand, exportCommand, importCommand } from '../../src/cli/commands/transfer.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { obs, sess } from '../store/store-contract.js';
import { deadUrl } from '../helpers/closed-port.js';
import { expectMode } from '../helpers/posix.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
const io = () => {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    },
    out: () => out,
    err: () => err,
  };
};
const KEY = 'github.com/acme/app';

const a = { home: mkHome(), cwd: mkHome() };
const b = { home: mkHome(), cwd: mkHome() };
let ha: Awaited<ReturnType<typeof startDaemon>>;
let hb: Awaited<ReturnType<typeof startDaemon>>;
let ca: ReturnType<typeof createDaemonContext>;
let cb: ReturnType<typeof createDaemonContext>;
let o1: ReturnType<typeof obs>;
let o2: ReturnType<typeof obs>;
let sid: string;

beforeAll(async () => {
  ca = createDaemonContext(a.home, env);
  cb = createDaemonContext(b.home, env);
  const p = ca.store.getOrCreateProject(KEY, 'app');
  const s = sess(p.id);
  sid = s.id;
  ca.store.upsertSession(s);
  o1 = obs({
    projectId: p.id,
    sessionId: s.id,
    title: 'Zebra parser fixed',
    type: 'bugfix',
    narrative: 'line one\nline two',
  });
  o2 = obs({
    projectId: p.id,
    sessionId: s.id,
    title: 'Bob note',
    userId: 'bob',
    origin: 'hub',
    syncedAt: new Date().toISOString(),
  });
  ca.store.insertObservations([o1, o2]);
  ca.store.setPinned(o1.id, true);
  ca.store.insertSummaries([
    {
      id: '0190aaaa-0000-7000-8000-000000000001',
      projectId: p.id,
      sessionId: s.id,
      userId: 'local',
      request: 'fix the parser',
      learned: 'l',
      completed: 'c',
      nextSteps: 'n',
      createdAt: new Date().toISOString(),
      origin: 'local',
      syncedAt: null,
    },
  ]);
  ha = await startDaemon(ca, { port: 0 });
  hb = await startDaemon(cb, { port: 0 });
});
afterAll(async () => {
  await ha.close();
  await hb.close();
});

describe('backup', () => {
  it('writes a 0600 copy outside the memhive home and refuses inside it or over an existing file', async () => {
    const dir = mkHome();
    let r = io();
    expect(await backupCommand(['snap.db'], r.io, { home: a.home, cwd: dir })).toBe(0);
    const file = path.join(dir, 'snap.db');
    // the daemon reports the real path (macOS: /private/var/...)
    expect(r.out()).toContain(`backup written to ${path.join(realpathSync(dir), 'snap.db')}`);
    expectMode(file, 0o600);
    const db = new Database(file, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) c FROM observations').get() as { c: number }).c).toBe(2);
    db.close();
    r = io();
    expect(await backupCommand([file], r.io, { home: a.home, cwd: dir })).toBe(1);
    expect(r.err()).toContain('already exists');
    r = io();
    expect(await backupCommand([path.join(a.home, 'logs', '..', 'copy.db')], r.io, { home: a.home })).toBe(1);
    expect(r.err()).toContain('inside the memhive home');
    r = io();
    expect(await backupCommand([path.join(a.home, '..x.db')], r.io, { home: a.home })).toBe(1); // a file in the home whose name starts with ..
    expect(r.err()).toContain('inside the memhive home');
    r = io();
    expect(await backupCommand(['x.db', 'y.db'], r.io, { home: a.home })).toBe(2);
  });
});

describe('export and import', () => {
  it('jsonl round-trips into another machine, marked synced, idempotent, forgotten ids stay forgotten', async () => {
    const out = path.join(mkHome(), 'app.jsonl');
    let r = io();
    expect(await exportCommand(['--project', KEY, '--out', out], r.io, { home: a.home })).toBe(0);
    expectMode(out, 0o600);
    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(['project', 'session', 'observation', 'observation', 'summary']);
    expect(lines[2]).not.toHaveProperty('syncedAt');
    expect(lines[2]).not.toHaveProperty('projectId');

    r = io();
    expect(await importCommand([out, '--project', KEY], r.io, { home: b.home })).toBe(0);
    expect(r.out()).toContain(`imported into ${KEY}: 1 sessions, 2 observations, 1 summaries; 0 skipped`);
    const p = cb.store.getProjectByKey(KEY)!;
    const [x] = cb.store.getObservations([o1.id]);
    expect(x).toMatchObject({
      title: 'Zebra parser fixed',
      narrative: 'line one\nline two',
      pinned: true,
      embeddingModel: null,
      projectId: p.id,
    });
    expect(x.syncedAt).not.toBeNull();
    expect(cb.store.listUnsynced('observations', p.id, 10)).toEqual([]);
    expect(cb.store.getObservations([o2.id])[0]).toMatchObject({ userId: 'bob', origin: 'hub' });

    r = io();
    expect(await importCommand([out, '--project', KEY, '--json'], r.io, { home: b.home })).toBe(0);
    expect(JSON.parse(r.out())).toEqual({
      project: KEY,
      imported: { sessions: 0, observations: 0, summaries: 0 },
      skipped: 4,
    });

    cb.store.deleteObservations([o1.id], { projectId: p.id }); // forgotten on machine b
    r = io();
    expect(await importCommand([out, '--project', KEY, '--json'], r.io, { home: b.home })).toBe(0);
    expect(JSON.parse(r.out()).imported.observations).toBe(0);
    expect(cb.store.getObservations([o1.id])).toEqual([]); // an old export does not bring a forgotten row back
  });
  it("--sync imports the rows as this user's (origin local) and leaves them unsynced", async () => {
    const c = { home: mkHome() };
    const cc = createDaemonContext(c.home, env);
    const hc = await startDaemon(cc, { port: 0 });
    try {
      const out = path.join(mkHome(), 'app.jsonl');
      await exportCommand(['--project', KEY, '--out', out], io().io, { home: a.home });
      expect(await importCommand([out, '--project', KEY, '--sync'], io().io, { home: c.home })).toBe(0);
      const p = cc.store.getProjectByKey(KEY)!;
      expect(
        cc.store
          .listUnsynced('observations', p.id, 10)
          .map((o) => o.id)
          .sort()
      ).toEqual([o1.id, o2.id].sort());
      expect(cc.store.getObservations([o2.id])[0].origin).toBe('local');
    } finally {
      await hc.close();
    }
  });
  it('--out refuses an existing file or symlink; --force replaces it with a 0600 file', async () => {
    const dir = mkHome();
    const out = path.join(dir, 'x.jsonl');
    writeFileSync(out, 'old');
    chmodSync(out, 0o644);
    let r = io();
    expect(await exportCommand(['--project', KEY, '--out', out], r.io, { home: a.home })).toBe(1);
    expect(r.err()).toContain('already exists');
    expect(readFileSync(out, 'utf8')).toBe('old');
    r = io();
    expect(await exportCommand(['--project', KEY, '--out', out, '--force'], r.io, { home: a.home })).toBe(0);
    expectMode(out, 0o600);
    expect(readFileSync(out, 'utf8')).toContain('"kind":"project"');
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'keep');
    const link = path.join(dir, 'link.jsonl');
    symlinkSync(victim, link);
    r = io();
    expect(await exportCommand(['--project', KEY, '--out', link], r.io, { home: a.home })).toBe(1);
    r = io();
    expect(await exportCommand(['--project', KEY, '--out', link, '--force'], r.io, { home: a.home })).toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    const sub = path.join(dir, 'adir');
    mkdirSync(sub);
    r = io();
    expect(await exportCommand(['--project', KEY, '--out', sub, '--force'], r.io, { home: a.home })).toBe(1);
    expect(r.err()).toMatch(/^memhive export: cannot write .*adir: E[A-Z]+\n$/);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('cleans imported rows like pulled ones: secrets redacted, private blocks and control characters gone', async () => {
    const c = { home: mkHome() };
    const cc = createDaemonContext(c.home, env);
    const hc = await startDaemon(cc, { port: 0 });
    try {
      const sid2 = '0190bbbb-0000-7000-8000-000000000001';
      const oid = '0190bbbb-0000-7000-8000-000000000002';
      const now = new Date().toISOString();
      const file = path.join(mkHome(), 'evil.jsonl');
      writeFileSync(
        file,
        [
          {
            kind: 'session',
            id: sid2,
            userId: 'mallory\u001b[2J',
            host: 'claude-code',
            hostSessionId: 'h',
            startedAt: now,
          },
          {
            kind: 'observation',
            id: '0190bbbb-0000-7000-8000-000000000003',
            sessionId: sid2,
            userId: 'u',
            type: 'discovery',
            title: 'no origin',
            facts: [],
            createdAt: now,
          },
          {
            kind: 'observation',
            id: oid,
            sessionId: sid2,
            userId: 'mallory\u001b[31m',
            type: 'discovery',
            title: 'T <private>hidden</private>',
            facts: ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'],
            narrative: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
            createdAt: now,
            origin: 'hub',
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n'
      );
      expect(await importCommand([file, '--project', KEY], io().io, { home: c.home })).toBe(0);
      const [o] = cc.store.getObservations([oid]);
      expect(o.userId).toBe('mallory?[31m');
      expect(cc.store.getSession(sid2)!.userId).toBe('mallory?[2J');
      expect(o.narrative + o.facts.join(' ')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
      expect(o.title).not.toContain('hidden');
      expect(o.origin).toBe('hub'); // without --sync the file's origin is kept
      expect(cc.store.getObservations(['0190bbbb-0000-7000-8000-000000000003'])[0].origin).toBe('hub'); // none given: not ours
    } finally {
      await hc.close();
    }
  });
  it('md groups by session; bad input is refused', async () => {
    let r = io();
    expect(await exportCommand(['--project', KEY, '--format', 'md'], r.io, { home: a.home })).toBe(0);
    expect(r.out()).toMatch(new RegExp(`^# ${KEY}\\n\\n## Session #${sid.slice(-8)} · claude-code · local · `));
    expect(r.out()).toContain('Zebra parser fixed');
    expect(r.out()).toContain('fix the parser');
    r = io();
    expect(await exportCommand(['--format', 'csv'], r.io, { home: a.home })).toBe(2);
    const bad = path.join(mkHome(), 'bad.jsonl');
    writeFileSync(bad, '{"kind":"observation"\n');
    r = io();
    expect(await importCommand([bad], r.io, { home: b.home, cwd: b.cwd })).toBe(1);
    expect(r.err()).toContain('line 1 is not JSON');
    writeFileSync(
      bad,
      JSON.stringify({
        kind: 'observation',
        id: 'x',
        sessionId: sid,
        userId: 'u',
        type: 'nope',
        title: 't',
        facts: [],
        createdAt: new Date().toISOString(),
      }) + '\n'
    );
    r = io();
    expect(await importCommand([bad, '--project', KEY], r.io, { home: b.home })).toBe(1);
    expect(r.err()).toMatch(/row 0: type: /);
    r = io();
    expect(await importCommand([], r.io, { home: b.home })).toBe(2);
  });
});
