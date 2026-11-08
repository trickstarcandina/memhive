import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { z } from 'zod';
import { DaemonClient, DaemonError } from '../daemon/client.js';
import { ensureDaemon } from '../daemon/ensure.js';
import { shortId } from '../shared/ids.js';
import { resolvePaths } from '../shared/paths.js';
import { envDisabled, matchesAny } from '../shared/optout.js';
import { readDaemonInfo } from '../daemon/info.js';
import { loadSettings } from '../shared/settings.js';
import { VERSION } from '../shared/version.js';
import { OBSERVATION_TYPES, type Observation, type SearchResult, type Summary } from '../store/types.js';
import { formatFull, formatIndex } from './format.js';

// Accepts the `#abcd1234` form the context footer and index print.
const id = z.preprocess((v) => (typeof v === 'string' ? v.replace(/^#/, '') : v), z.string().max(64).regex(/^[0-9a-f-]+$/i));

/** Re-resolves the daemon (it may have idle-exited and restarted with a new port/token). */
export type Reconnect = () => Promise<DaemonClient | null>;

export interface McpDeps {
  client: DaemonClient | null; cwd: string; reconnect?: Reconnect; env?: NodeJS.ProcessEnv;
  /** The token in daemon.json now; a change (or none) means the daemon restarted, or the port may belong to someone else. */
  currentToken?: () => string | null;
  /** settings.mcp.allowProjects: keys or globs `search` may read besides the current project. */
  allowProjects?: string[];
}
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'memhive', version: VERSION });
  let current = deps.client;
  // One retry after re-ensuring the daemon on a connection failure or 401; timeouts and other daemon errors pass through.
  const rpc = {
    async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      // Re-prove the daemon (ensureDaemon runs the HMAC health check) before talking to a port it may have given up.
      if (!current || (deps.currentToken && deps.currentToken() !== current.token)) { current = (await deps.reconnect?.()) ?? null; if (!current) throw new Error('memhive daemon unavailable'); }
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
    inputSchema: { query: z.string().max(2000), type: z.enum(OBSERVATION_TYPES).optional(), user: z.string().max(200).optional(), since: z.string().max(64).optional().describe('ISO date or relative like 7d, 12h'), project: z.string().max(1000).optional().describe('project key; defaults to the current repo (others only if allowlisted in settings)'), limit: z.number().int().min(1).max(100).default(20) },
  }, async (a) => {
    // Another project's memory only when allowlisted: text in an untrusted repo must not steer the agent into reading it.
    const here = await projectKey();
    const allowed = !a.project || a.project === here || matchesAny(deps.allowProjects ?? [], a.project);
    const q = new URLSearchParams({ q: a.query, project_key: allowed && a.project ? a.project : here, limit: String(a.limit) });
    if (a.type) q.set('type', a.type);
    if (a.user) q.set('user', a.user);
    if (a.since) q.set('since', a.since);
    const r = await rpc.request<{ results?: SearchResult[]; observations: Observation[] }>('GET', `/v1/search?${q}`);
    const note = allowed ? '' : `Note: project "${a.project!.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}" is not in settings.mcp.allowProjects; searched the current project instead.\n\n`;
    return textResult(note + formatIndex(r.results ?? r.observations));
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

  tool('forget', {
    description: 'Permanently delete observations or session summaries of this project (full ids, unique prefixes or 8-char short ids), e.g. a secret recorded by mistake. Only rows recorded on this machine can be forgotten; on a linked hub the deletion reaches teammates too.',
    inputSchema: { ids: z.array(id).min(1).max(50) },
  }, async (a) => {
    // Never force: an agent steered by text in a repo must not be able to wipe teammates' memory.
    const r = await rpc.request<ForgetResult>('POST', '/v1/forget', { projectKey: await projectKey(), ids: a.ids });
    return textResult(formatForget(r));
  });

  return server;
}

export interface ForgetRow { id: string; kind: 'observation' | 'summary'; type: string; title: string; userId: string; createdAt: string }
export interface ForgetResult { deleted: ForgetRow[]; not_owner: ForgetRow[]; not_found: string[]; propagates: boolean | null }
const line = (r: ForgetRow) => `#${shortId(r.id)} · ${r.type} · ${r.title.replace(/\s+/g, ' ').slice(0, 200)}`;
export function formatForget(r: ForgetResult, verb = 'Forgot'): string {
  const out: string[] = [];
  if (r.deleted.length) out.push(`${verb} ${r.deleted.length}:`, ...r.deleted.map(line));
  else out.push('Nothing was forgotten.');
  if (r.not_owner.length) out.push('Not forgotten (recorded by someone else; only rows recorded on this machine can be forgotten):', ...r.not_owner.map(line));
  if (r.not_found.length) out.push(`Not found in this project: ${r.not_found.map((x) => x.replace(/[^0-9a-f#-]/gi, '?').slice(0, 64)).join(', ')}`);
  if (r.deleted.length) out.push(r.propagates === true ? 'The deletion is pushed to the hub and removed from teammates on their next pull.'
    : r.propagates === null ? 'The hub could not be reached; the deletion is queued and pushed once the hub answers (protocol 2 or later).'
    : 'Removed from this machine only (project not linked to a hub, or the hub is older than protocol 2: the deletion stays queued).');
  return out.join('\n');
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
  const server = createMcpServer({ client: info ? new DaemonClient(info) : null, cwd: mcpCwd(), reconnect, currentToken: () => readDaemonInfo(home)?.token ?? null, allowProjects: loadSettings(home).mcp.allowProjects });
  await server.connect(new StdioServerTransport());
  await new Promise(() => {}); // stdio transport keeps the process alive until the host closes it
  return 0;
}
