import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient } from '../../daemon/client.js';

export async function embedCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const { flags } = parseArgs(args);
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhub: daemon unavailable\n'); return 1; }
  const client = new DaemonClient(info);
  if (flags.rebuild) io.stdout('Restart the daemon after changing MEMHUB_EMBED_DIMS; the vector index is rebuilt on start. Backfilling now…\n');
  let total = 0;
  for (;;) { const r = await client.request<{ embedded: number }>('POST', '/v1/embed', { limit: 200 }, 120000); total += r.embedded; if (r.embedded < 200) break; }
  io.stdout(`embedded ${total} observations\n`);
  return 0;
}
