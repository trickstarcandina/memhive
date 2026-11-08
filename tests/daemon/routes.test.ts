import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { handleRoute } from '../../src/daemon/routes.js';
import type { DaemonContext } from '../../src/daemon/context.js';
import { obs, sess } from '../store/store-contract.js';
import { deadUrl } from '../helpers/closed-port.js';
import { waitFor } from '../helpers/wait.js';

const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 36e5;

const OBS0 = '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
let ctx: DaemonContext;
let anchorId = '';
const KEY = 'github.com/acme/routes';
const route = (method: string, p: string, body?: unknown) =>
  handleRoute(ctx, method, new URL(p, 'http://127.0.0.1'), body);

beforeAll(() => {
  ctx = createDaemonContext(mkdtempSync(path.join(tmpdir(), 'mh-routes-')), env);
  const p = ctx.store.getOrCreateProject(KEY, 'routes');
  const a = sess(p.id);
  ctx.store.upsertSession(a);
  ctx.store.insertObservations([
    obs({ projectId: p.id, sessionId: a.id, title: 'ten days', createdAt: ago(240 * H) }),
    obs({ projectId: p.id, sessionId: a.id, title: 'three days', createdAt: ago(72 * H) }),
    obs({ projectId: p.id, sessionId: a.id, title: 'five hours', createdAt: ago(5 * H) }),
    obs({ projectId: p.id, sessionId: a.id, title: 'ten minutes', createdAt: ago(10 * 6e4) }),
  ]);
  // 120 rows in one session around an anchor, for the timeline clamps
  const b = sess(p.id);
  ctx.store.upsertSession(b);
  const line = Array.from({ length: 121 }, (_, i) =>
    obs({
      projectId: p.id,
      sessionId: b.id,
      title: `line ${i}`,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
    })
  );
  ctx.store.insertObservations(line);
  anchorId = line[60].id;
});
afterAll(() => ctx.store.close());

describe('daemon route matrix', () => {
  it.each([
    ['7d', ['ten minutes', 'five hours', 'three days']],
    ['12h', ['ten minutes', 'five hours']],
    ['30m', ['ten minutes']],
  ])('since=%s keeps only newer rows', async (since, titles) => {
    const r = await route('GET', `/v1/search?project_key=${KEY}&since=${since}&limit=100`);
    expect(r.status).toBe(200);
    expect(
      (r.body as { observations: Array<{ title: string }> }).observations
        .map((o) => o.title)
        .filter((t) => !t.startsWith('line'))
    ).toEqual(titles);
  });
  it('a since that is not a duration is passed through as a date, not an error', async () => {
    for (const since of ['garbage', '2026-01-01T00:00:00.000Z', '7x', '-1d'])
      expect((await route('GET', `/v1/search?project_key=${KEY}&since=${encodeURIComponent(since)}`)).status).toBe(200);
  });

  it.each([
    ['5', '5', 11],
    ['-3', '-3', 1],
    ['abc', 'NaN', 1],
    ['100', '100', 101],
    ['', '', 1],
    ['50', '0', 51],
  ])('timeline before=%s after=%s gives %i rows (0..50 each side)', async (before, after, n) => {
    const r = await route('GET', `/v1/timeline?project_key=${KEY}&anchor=${anchorId}&before=${before}&after=${after}`);
    expect(r.status).toBe(200);
    expect((r.body as { observations: unknown[] }).observations).toHaveLength(n);
  });
  it('timeline defaults to 5 on each side', async () => {
    expect(
      ((await route('GET', `/v1/timeline?project_key=${KEY}&anchor=${anchorId}`)).body as { observations: unknown[] })
        .observations
    ).toHaveLength(11);
  });

  it('timeline with all_projects=1 reaches the anchor; an anchor outside project_key or missing is 404', async () => {
    expect(
      (
        (await route('GET', `/v1/timeline?all_projects=1&anchor=${anchorId}&before=1&after=1`)).body as {
          observations: unknown[];
        }
      ).observations
    ).toHaveLength(3);
    for (const p of [
      `/v1/timeline?project_key=github.com/acme/elsewhere&anchor=${anchorId}`,
      `/v1/timeline?project_key=${KEY}`,
      `/v1/timeline?project_key=${KEY}&anchor=`,
    ]) {
      const r = await route('GET', p);
      expect(r.status, p).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it.each([
    ['POST', '/v1/sessions/start', {}, 'bad_event'],
    ['POST', '/v1/sessions/start', { hostSessionId: 'x' }, 'bad_event'],
    ['POST', '/v1/sessions/start', undefined, 'bad_event'],
    ['POST', '/v1/events', { hostSessionId: 'x', cwd: '/w' }, 'bad_event'],
    ['POST', '/v1/events', { cwd: '/w', event: 'tool' }, 'bad_event'],
    ['GET', `/v1/search?project_key=${KEY}&type=nonsense`, undefined, 'bad_type'],
    ['GET', '/v1/search?q=x', undefined, 'missing_project'],
    ['GET', `/v1/timeline?anchor=${OBS0}`, undefined, 'missing_project'],
    ['GET', `/v1/observations?ids=${OBS0}`, undefined, 'missing_project'],
  ])('%s %s %j -> 400 %s', async (method, p, body, code) => {
    const r = await route(method, p, body);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(code);
  });
});

describe('daemon HTTP edges', () => {
  let h: Awaited<ReturnType<typeof startDaemon>>;
  let home = '';
  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'mh-routes-'));
    h = await startDaemon(createDaemonContext(home, env), { port: 0, idleMs: 60_000 });
  });
  afterAll(async () => {
    await h.close();
  });

  const raw = (p: string, body: string | Buffer, token = h.info.token) =>
    new Promise<{ status: number; json: any; connection?: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: h.info.port,
          path: p,
          method: 'POST',
          headers: {
            'x-memhive-daemon-token': token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () =>
            resolve({ status: res.statusCode!, json: d ? JSON.parse(d) : null, connection: res.headers.connection })
          );
        }
      );
      req.on('error', reject);
      req.end(body);
    });

  it('invalid JSON is 400 bad_json', async () => {
    const r = await raw('/v1/events', '{"hostSessionId":');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_json');
  });
  it('a body over 2 MB is 413 and the connection is closed', async () => {
    const r = await raw('/v1/events', JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 10) })).catch(
      (e: NodeJS.ErrnoException) => ({ status: -1, json: null, connection: e.code })
    );
    // either the 413 arrives with connection: close, or the server already cut the socket while we were still sending
    if (r.status === -1) expect(['ECONNRESET', 'EPIPE']).toContain(r.connection);
    else {
      expect(r.status).toBe(413);
      expect(r.json.error.code).toBe('too_large');
      expect(r.connection).toBe('close');
    }
    expect((await raw('/v1/events', '{}')).status).toBe(400); // the daemon still serves
  });
  it('/v1/shutdown stops the daemon and removes daemon.json', async () => {
    // its own daemon, so the other tests here never meet a stopped one
    const own = mkdtempSync(path.join(tmpdir(), 'mh-routes-'));
    const d = await startDaemon(createDaemonContext(own, env), { port: 0, idleMs: 60_000 });
    try {
      const r = await fetch(`http://127.0.0.1:${d.info.port}/v1/shutdown`, {
        method: 'POST',
        headers: { 'x-memhive-daemon-token': d.info.token },
      });
      expect(r.status).toBe(200);
      await waitFor(() => !existsSync(path.join(own, 'daemon.json')), { what: 'daemon.json removed' });
      expect(existsSync(path.join(own, 'daemon.lock'))).toBe(false);
    } finally {
      await d.close();
    }
  });
});
