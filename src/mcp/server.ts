import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { z } from 'zod';
import { DaemonClient, DaemonError } from '../daemon/client.js';
import { ensureDaemon } from '../daemon/ensure.js';
import { shortId } from '../shared/ids.js';
import { resolvePaths } from '../shared/paths.js';
import { envDisabled } from '../shared/optout.js';
import { VERSION } from '../shared/version.js';
import { OBSERVATION_TYPES, type Observation, type SearchResult, type Summary } from '../store/types.js';
import { formatFull, formatIndex } from './format.js';

// Accepts the `#abcd1234` form the context footer and index print.
const id = z.preprocess((v) => (typeof v === 'string' ? v.replace(/^#/, '') : v), z.string().max(64).regex(/^[0-9a-f-]+$/i));

/** Re-resolves the daemon (it may have idle-exited and restarted with a new port/token). */
export type Reconnect = () => Promise<DaemonClient | null>;

export function createMcpServer(deps: { client: DaemonClient | null; cwd: string; reconnect?: Reconnect; env?: NodeJS.ProcessEnv }): McpServer {
  const server = new McpServer({ name: 'memhive', version: VERSION });
  let current = deps.client;
  // One retry after re-ensuring the daemon on a connection failure or 401; timeouts and other daemon errors pass through.
  const rpc = {
    async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      if (!current) { current = (await deps.reconnect?.()) ?? null; if (!current) throw new Error('memhive daemon unavailable'); }
      try { return await current.request<T>(method, path, body); }
      catch (e) {
        const stale = e instanceof DaemonError ? e.status === 401 : (e as Error)?.name !== 'AbortError';
        const next = stale && deps.reconnect ? await deps.reconnect() : null;
        if (!next) throw e;
        current = next;
        return current.request<T>(method, path, body);
      }
    },
  };
  const projectKey = async () => (await rpc.request<{ project: { key: string } }>('GET', `/v1/project?cwd=${encodeURIComponent(deps.cwd)}`)).project.key;
  const textResult = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  // Checked per call, so the server never needs a daemon while MEMHIVE_DISABLED is set.
  const tool: typeof server.registerTool = (name, config, cb) => server.registerTool(name, config, (async (...a: unknown[]) => (envDisabled(deps.env ?? process.env) ? textResult('memhive disabled (MEMHIVE_DISABLED is set); nothing was read or saved.') : (cb as (...x: unknown[]) => unknown)(...a))) as typeof cb);

  tool('search', {
    description: 'Step 1 of 3. Search past observations and session summaries for this project. Returns a compact index (ids, types, titles; summaries have type session-summary). Follow with timeline and get_observations.',
    inputSchema: { query: z.string().max(2000), type: z.enum(OBSERVATION_TYPES).optional(), user: z.string().max(200).optional(), since: z.string().max(64).optional().describe('ISO date or relative like 7d, 12h'), project: z.string().max(1000).optional().describe('project key; defaults to the current repo'), limit: z.number().int().min(1).max(100).default(20) },
  }, async (a) => {
    const q = new URLSearchParams({ q: a.query, project_key: a.project ?? (await projectKey()), limit: String(a.limit) });
    if (a.type) q.set('type', a.type);
    if (a.user) q.set('user', a.user);
    if (a.since) q.set('since', a.since);
    const r = await rpc.request<{ results?: SearchResult[]; observations: Observation[] }>('GET', `/v1/search?${q}`);
    return textResult(formatIndex(r.results ?? r.observations));
  });

  tool('timeline', {
    description: 'Step 2 of 3. Show observations recorded before and after an anchor observation (same session), as an index.',
    inputSchema: { anchor_id: id, before: z.number().int().min(0).max(50).default(5), after: z.number().int().min(0).max(50).default(5) },
  }, async (a) => {
    const r = await rpc.request<{ observations: Observation[] }>('GET', `/v1/timeline?anchor=${encodeURIComponent(a.anchor_id)}&before=${a.before}&after=${a.after}`);
    return textResult(formatIndex(r.observations));
  });

  tool('get_observations', {
    description: 'Step 3 of 3. Fetch full details for selected observation or session-summary ids (full ids, unique prefixes or 8-char short ids). Batch several ids per call.',
    inputSchema: { ids: z.array(id).min(1).max(50) },
  }, async (a) => {
    const r = await rpc.request<{ observations: Observation[]; summaries?: Summary[] }>('GET', `/v1/observations?ids=${encodeURIComponent(a.ids.join(','))}`);
    return textResult(formatFull(r.observations, r.summaries ?? []));
  });

  tool('save_memory', {
    description: 'Save a note for future sessions of this project (a decision, a gotcha, a convention).',
    inputSchema: { text: z.string().min(1).max(20000), title: z.string().max(2000).optional(), type: z.enum(OBSERVATION_TYPES).default('discovery') },
  }, async (a) => {
    const r = await rpc.request<{ observation: Observation }>('POST', '/v1/memories', { projectKey: await projectKey(), text: a.text, title: a.title, type: a.type });
    return textResult(`Saved #${shortId(r.observation.id)} · ${r.observation.type} · ${r.observation.title.replace(/\s+/g, ' ')}`);
  });

  // Tools that change one observation by id (pin, unpin; forget joins them) share this shape.
  const idTool = (name: string, description: string, run: (id: string) => Promise<string>) =>
    tool(name, { description, inputSchema: { id } }, async (a) => textResult(await run(a.id)));
  const pin = (pinned: boolean) => async (oid: string) => {
    const r = await rpc.request<{ observation: Observation }>('POST', '/v1/observations/pin', { id: oid, pinned });
    return `${pinned ? 'Pinned' : 'Unpinned'} #${shortId(r.observation.id)} · ${r.observation.title.replace(/\s+/g, ' ')}`;
  };
  idTool('pin', 'Pin an observation (full id or 8-char short id): it always appears in the session-start context and is never expired by retention.', pin(true));
  idTool('unpin', 'Unpin an observation so it is ranked and expired like any other.', pin(false));

  return server;
}

/** MEMHIVE_CWD from the plugin's .mcp.json, unless the host left it empty or unexpanded; then the process cwd. */
export function mcpCwd(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const v = env.MEMHIVE_CWD;
  return v && path.isAbsolute(v) && !v.includes('${') ? v : cwd;
}

export async function runMcp(): Promise<number> {
  const home = resolvePaths().home;
  const info = envDisabled() ? null : await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info && !envDisabled()) { process.stderr.write('memhive: daemon could not be started\n'); return 1; }
  const reconnect: Reconnect = async () => { const i = await ensureDaemon(home, { wait: true, waitMs: 5000 }); return i ? new DaemonClient(i) : null; };
  const server = createMcpServer({ client: info ? new DaemonClient(info) : null, cwd: mcpCwd(), reconnect });
  await server.connect(new StdioServerTransport());
  await new Promise(() => {}); // stdio transport keeps the process alive until the host closes it
  return 0;
}
