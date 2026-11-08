import type { CliIo } from '../index.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadCredentials, normalizeHubUrl } from '../../sync/credentials.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';

export async function linkCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string; unlink?: boolean } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  let hubUrl: string | null = null;
  if (!opts.unlink) {
    if (!args[0]) { io.stderr('usage: memhub link <hub-url>\n'); return 1; }
    try { hubUrl = normalizeHubUrl(args[0]); } catch (e) { io.stderr(`memhub link: ${e instanceof Error ? e.message : e}\n`); return 1; }
    if (!loadCredentials(home).hubs[hubUrl]) { io.stderr(`not logged in to ${hubUrl}; run: memhub login ${hubUrl}\n`); return 1; }
  }
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhub: daemon unavailable\n'); return 1; }
  const daemon = new DaemonClient(info);
  try {
    const r = await daemon.request<{ project: { key: string; hubUrl: string | null } }>('POST', '/v1/projects/link', { cwd, hubUrl });
    io.stdout(hubUrl ? `linked ${r.project.key} -> ${hubUrl}\n` : `unlinked ${r.project.key}\n`);
    if (hubUrl) { const s = await daemon.request<{ pulled: number }>('POST', '/v1/sync', { cwd }, 30000); io.stdout(`initial sync: pulled ${s.pulled} rows\n`); }
    return 0;
  } catch (e) { io.stderr(`memhub ${opts.unlink ? 'unlink' : 'link'}: ${e instanceof DaemonError ? e.message : String(e)}\n`); return 1; }
}
