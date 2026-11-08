import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient } from '../../daemon/client.js';
import { formatIndex } from '../../mcp/format.js';
import type { Observation } from '../../store/types.js';

export async function searchCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) { io.stderr('usage: memhub search <query> [--type t] [--user u] [--since 7d] [--limit n]\n'); return 1; }
  const limit = flags.limit === undefined ? 20 : typeof flags.limit === 'string' ? Number(flags.limit) : NaN;   // bare --limit is true, and Number(true) is 1
  if (!Number.isInteger(limit) || limit < 1) { io.stderr('memhub search: --limit must be a positive integer\nusage: memhub search <query> [--type t] [--user u] [--since 7d] [--limit n]\n'); return 2; }
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhub: daemon unavailable\n'); return 1; }
  const client = new DaemonClient(info);
  const key = (await client.request<{ project: { key: string } }>('GET', `/v1/project?cwd=${encodeURIComponent(cwd)}`)).project.key;
  const q = new URLSearchParams({ q: query, project_key: key, limit: String(limit) });
  for (const k of ['type', 'user', 'since']) if (typeof flags[k] === 'string') q.set(k, flags[k] as string);
  const r = await client.request<{ observations: Observation[] }>('GET', `/v1/search?${q}`);
  io.stdout(formatIndex(r.observations) + '\n');
  return 0;
}
