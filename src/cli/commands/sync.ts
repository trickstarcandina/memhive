import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { daemonUnavailableMessage } from '../daemon-unavailable.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';

// The daemon keeps syncing after the CLI stops waiting (a large backlog can take minutes), so a timeout is not a failure.
export const SYNC_WAIT_MS = 60_000;
export const SYNC_IN_BACKGROUND =
  'sync is still running in the daemon and continues in the background; run `memhive sync` later to see the result\n';
export const isTimeout = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

export async function syncCommand(
  _args: string[],
  io: CliIo,
  opts: { home?: string; cwd?: string; waitMs?: number } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const cwd = opts.cwd ?? process.cwd();
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) {
    io.stderr(daemonUnavailableMessage(home));
    return 1;
  }
  try {
    const r = await new DaemonClient(info).request<{
      pushed: { accepted: { observations: number; summaries: number; sessions: number }; rejected: unknown[] } | null;
      pulled: number;
      error?: string;
    }>('POST', '/v1/sync', { cwd }, opts.waitMs ?? SYNC_WAIT_MS);
    if (_args.includes('--json')) {
      io.stdout(JSON.stringify(r, null, 2) + '\n');
      return r.error ? 1 : 0;
    }
    io.stdout(
      r.pushed
        ? `pushed ${r.pushed.accepted.observations} observations, ${r.pushed.accepted.summaries} summaries (${r.pushed.rejected.length} rejected); pulled ${r.pulled} rows\n`
        : `push skipped (not logged in or key rejected); pulled ${r.pulled} rows\n`
    );
    if (r.error) {
      io.stderr(`memhive sync: ${r.error}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (isTimeout(e)) {
      io.stdout(SYNC_IN_BACKGROUND);
      return 0;
    }
    io.stderr(`memhive sync: ${e instanceof DaemonError ? e.message : String(e)}\n`);
    return 1;
  }
}
