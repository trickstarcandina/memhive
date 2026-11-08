import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadCredentials, normalizeHubUrl } from '../../sync/credentials.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';
import { SYNC_IN_BACKGROUND, SYNC_WAIT_MS, isTimeout } from './sync.js';

export async function linkCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string; unlink?: boolean } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  let hubUrl: string | null = null;
  if (!opts.unlink) {
    if (!args[0]) { io.stderr('usage: memhive link <hub-url>\n'); return 1; }
    try { hubUrl = normalizeHubUrl(args[0]); } catch (e) { io.stderr(`memhive link: ${e instanceof Error ? e.message : e}\n`); return 1; }
    if (!loadCredentials(home).hubs[hubUrl]) { io.stderr(`not logged in to ${hubUrl}; run: memhive login ${hubUrl}\n`); return 1; }
  }
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhive: daemon unavailable\n'); return 1; }
  const daemon = new DaemonClient(info);
  try {
    const r = await daemon.request<{ project: { key: string; hubUrl: string | null } }>('POST', '/v1/projects/link', { cwd, hubUrl });
    io.stdout(hubUrl ? `linked ${r.project.key} -> ${hubUrl}\n` : `unlinked ${r.project.key}\n`);
    if (hubUrl) {
      const s = await daemon.request<{ pushed: { accepted: { observations: number } } | null; pulled: number }>('POST', '/v1/sync', { cwd }, SYNC_WAIT_MS);
      io.stdout(`initial sync: pushed ${s.pushed?.accepted.observations ?? 0} observations, pulled ${s.pulled} rows\n`);
    }
    return 0;
  } catch (e) {
    if (isTimeout(e)) { io.stdout(SYNC_IN_BACKGROUND); return 0; } io.stderr(`memhive ${opts.unlink ? 'unlink' : 'link'}: ${e instanceof DaemonError ? e.message : String(e)}\n`); return 1; }
}
