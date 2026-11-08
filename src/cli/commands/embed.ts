import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { daemonUnavailableMessage } from '../daemon-unavailable.js';
import { DaemonClient } from '../../daemon/client.js';

export async function embedCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const { flags } = parseArgs(args);
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr(daemonUnavailableMessage(home)); return 1; }
  const client = new DaemonClient(info);
  // A dims or model change already resets vectors when the daemon starts; --rebuild forces it (for example after the
  // embedding server swapped weights under the same model name).
  if (flags.rebuild) io.stdout('Dropping every stored vector and embedding all observations again…\n');
  let total = 0;
  for (let first = true; ; first = false) {
    const r = await client.request<{ embedded: number }>('POST', '/v1/embed', { limit: 200, ...(first && flags.rebuild ? { rebuild: true } : {}) }, 120000);
    total += r.embedded; if (r.embedded < 200) break;
  }
  io.stdout(`embedded ${total} observations\n`);
  return 0;
}
