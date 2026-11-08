import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { COMMANDS } from '../help.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { daemonUnavailableMessage } from '../daemon-unavailable.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';
import { formatIndex } from '../../mcp/format.js';
import { OBSERVATION_TYPES, type Observation, type ObservationType, type SearchResult } from '../../store/types.js';

export const printJson = (io: CliIo, v: unknown) => io.stdout(JSON.stringify(v, null, 2) + '\n');

/** The daemon for a CLI command, or null after printing why there is none. */
export async function daemonFor(home: string, io: CliIo): Promise<DaemonClient | null> {
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr(daemonUnavailableMessage(home)); return null; }
  return new DaemonClient(info);
}
/** --project, else the project of cwd; null (message printed) when cwd's project is excluded. */
export async function projectKeyFor(client: DaemonClient, flags: Record<string, string | boolean>, cwd: string, io: CliIo): Promise<string | null> {
  if (typeof flags.project === 'string') return flags.project;
  try { return (await client.request<{ project: { key: string } }>('GET', `/v1/project?cwd=${encodeURIComponent(cwd)}`)).project.key; }
  catch (e) { if (e instanceof DaemonError && e.status === 409) { io.stderr(`memhive: ${e.message}\n`); return null; } throw e; }
}

const intFlag = (v: string | boolean | undefined, dflt: number, min: number): number => v === undefined ? dflt : typeof v === 'string' && /^\d+$/.test(v) && Number(v) >= min ? Number(v) : NaN;   // bare --limit is true

/** `search <query>`, or `recent` (opts.recent): an empty query lists the newest observations under the filters. */
export async function searchCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string; recent?: boolean } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  const cmd = opts.recent ? 'recent' : 'search';
  const { positional, flags } = parseArgs(args, cmd);
  const query = opts.recent ? '' : positional.join(' ');
  const usage = COMMANDS[cmd].usage;
  if (!opts.recent && !query && typeof flags.since !== 'string' && typeof flags.type !== 'string') { io.stderr(usage); return 2; }
  const limit = intFlag(flags.limit, opts.recent ? 10 : 20, 1); const offset = intFlag(flags.offset, 0, 0);
  if (!Number.isInteger(limit)) { io.stderr(`memhive ${cmd}: --limit must be a positive integer\n${usage}`); return 2; }
  if (!Number.isInteger(offset)) { io.stderr(`memhive ${cmd}: --offset must be a non-negative integer\n${usage}`); return 2; }
  if (flags.type !== undefined && !OBSERVATION_TYPES.includes(flags.type as ObservationType)) { io.stderr(`memhive ${cmd}: --type must be one of ${OBSERVATION_TYPES.join(', ')}\n`); return 2; }
  if (flags['all-projects'] && typeof flags.project === 'string') { io.stderr(`memhive ${cmd}: use --project or --all-projects, not both\n`); return 2; }
  const client = await daemonFor(home, io); if (!client) return 1;
  const q = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  if (flags['all-projects']) q.set('all_projects', '1');
  else { const key = await projectKeyFor(client, flags, cwd, io); if (key === null) return 1; q.set('project_key', key); }
  for (const k of ['type', 'user', 'since']) if (typeof flags[k] === 'string') q.set(k, flags[k] as string);
  try {
    const r = await client.request<{ results?: SearchResult[]; observations: Observation[] }>('GET', `/v1/search?${q}`);
    const results = r.results ?? r.observations.map((o) => ({ ...o, kind: 'observation' as const }));
    if (flags.json) printJson(io, { results }); else io.stdout(formatIndex(results) + '\n');
    return 0;
  } catch (e) { if (e instanceof DaemonError) { io.stderr(`memhive ${cmd}: ${e.message}\n`); return 1; } throw e; }
}
