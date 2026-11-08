import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { SUMMARY_SYSTEM } from '../../src/observer/prompts.js';
import type { HookEvent } from '../../src/hooks/types.js';
import type { DaemonContext } from '../../src/daemon/context.js';
import { deadUrl } from '../helpers/closed-port.js';
import { waitFor } from '../helpers/wait.js';

const home = mkdtempSync(path.join(tmpdir(), 'mh-conc-'));
let ctx: DaemonContext;
let h: Awaited<ReturnType<typeof startDaemon>>;
let client: DaemonClient;
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 15));
const ev = (host: 'claude-code' | 'codex', id: string, p: Partial<HookEvent>): HookEvent => ({
  host,
  hostEvent: 'x',
  hostSessionId: id,
  cwd: home,
  event: 'session-start',
  at: new Date().toISOString(),
  ...p,
});

beforeAll(async () => {
  ctx = createDaemonContext(home, {
    MEMHIVE_LLM_PROVIDER: 'openai-compat',
    MEMHIVE_LLM_BASE_URL: deadUrl,
    MEMHIVE_LLM_MODEL: 'x',
  });
  // The fake LLM names its answer after the turn marker it was shown, so a row built from another session's events shows up.
  ctx.observer['deps'].provider = {
    complete: async ({ system, user }: { system: string; user: string }) => {
      await tick();
      // titles already observed are history, not this call's input
      const input = user.replace(/<already_observed>[\s\S]*?<\/already_observed>/, '');
      const marks = [...new Set(input.match(/MARK-[AB]-\d/g) ?? [])].sort().join('+') || 'none';
      return JSON.stringify(
        system === SUMMARY_SYSTEM
          ? { request: `sum ${marks}`, completed: 'c' }
          : { observations: [{ type: 'discovery', title: `obs ${marks}` }] }
      );
    },
  };
  h = await startDaemon(ctx, { port: 0, idleMs: 60_000 });
  client = new DaemonClient(h.info);
});
afterAll(async () => {
  await h.close();
});

describe('concurrent sessions on one daemon', () => {
  it('two hosts interleaving prompt/tool/stop: rows attach to their own session, one summary per Stop', async () => {
    const TURNS = 3;
    const run = async (host: 'claude-code' | 'codex', id: string, tag: 'A' | 'B') => {
      await client.request('POST', '/v1/sessions/start', ev(host, id, {}));
      const sessionId = () => ctx.store.getSessionByHost(host, id)!.id;
      for (let t = 1; t <= TURNS; t++) {
        const mark = `MARK-${tag}-${t}`;
        await client.request(
          'POST',
          '/v1/events',
          ev(host, id, { event: 'prompt', hostEvent: 'UserPromptSubmit', prompt: `do ${mark}` })
        );
        await Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            tick().then(() =>
              client.request(
                'POST',
                '/v1/events',
                ev(host, id, {
                  event: 'tool',
                  hostEvent: 'PostToolUse',
                  tool: { name: 'Read', input: { file_path: `${mark}-${i}` }, output: mark, failed: false },
                })
              )
            )
          )
        );
        await client.request('POST', '/v1/events', ev(host, id, { event: 'stop', hostEvent: 'Stop' }));
        // the next prompt comes once this turn is summarized, as a user reading the answer would
        await waitFor(
          () =>
            ctx.store
              .listRecentSummaries(ctx.store.getSession(sessionId())!.projectId, 50)
              .filter((s) => s.sessionId === sessionId()).length >= t,
          { timeout: 10_000, what: `${mark} summary` }
        );
      }
      return sessionId();
    };
    const [a, b] = await Promise.all([run('claude-code', 'conc-a', 'A'), run('codex', 'conc-b', 'B')]);
    await ctx.observer.close(); // let any stray work finish before counting
    const project = ctx.store.getSession(a)!.projectId;
    expect(ctx.store.getSession(b)!.projectId).toBe(project);
    const sums = ctx.store.listRecentSummaries(project, 50);
    for (const [sid, tag] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      const mine = sums
        .filter((s) => s.sessionId === sid)
        .map((s) => s.request)
        .sort();
      expect(mine).toEqual(Array.from({ length: TURNS }, (_, i) => `sum MARK-${tag}-${i + 1}`));
      const titles = ctx.store.listSessionObservations(sid, 100).map((o) => o.title);
      expect(titles.length).toBeGreaterThanOrEqual(TURNS);
      expect(
        titles.every((t) => new RegExp(`^obs MARK-${tag}-\\d$`).test(t)),
        titles.join(', ')
      ).toBe(true);
    }
    expect(sums).toHaveLength(2 * TURNS);
  });

  it('simultaneous SessionStarts for a new host session id create one session row', async () => {
    const before = ctx.store
      .listProjects()
      .map((p) => ctx.store.countSessions(p.id))
      .reduce((x, y) => x + y, 0);
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.request<{ context: string }>('POST', '/v1/sessions/start', ev('claude-code', 'brand-new', {}))
      )
    );
    expect(rs.every((r) => r.context.includes('memhive ·'))).toBe(true);
    const after = ctx.store
      .listProjects()
      .map((p) => ctx.store.countSessions(p.id))
      .reduce((x, y) => x + y, 0);
    expect(after - before).toBe(1);
    expect(ctx.store.getSessionByHost('claude-code', 'brand-new')).not.toBeNull();
  });
});
