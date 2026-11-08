import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';

export async function syncCommand(_args: string[], io: CliIo, opts: { home?: string; cwd?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhub: daemon unavailable\n'); return 1; }
  try {
    const r = await new DaemonClient(info).request<{ pushed: { accepted: { observations: number; summaries: number; sessions: number }; rejected: unknown[] } | null; pulled: number }>('POST', '/v1/sync', { cwd }, 60000);
    io.stdout(r.pushed ? `pushed ${r.pushed.accepted.observations} observations, ${r.pushed.accepted.summaries} summaries (${r.pushed.rejected.length} rejected); pulled ${r.pulled} rows\n` : `push skipped (not logged in or key rejected); pulled ${r.pulled} rows\n`);
    return 0;
  } catch (e) { io.stderr(`memhub sync: ${e instanceof DaemonError ? e.message : String(e)}\n`); return 1; }
}
