import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { ensureDaemon } from '../../daemon/ensure.js';
import { DaemonClient, DaemonError } from '../../daemon/client.js';
import { shortId } from '../../shared/ids.js';
import { formatForget, type ForgetResult, type ForgetRow } from '../../mcp/format-forget.js';

const USAGE = 'usage: memhive forget <id...> [--yes] [--force] [--project key]\n';
const show = (r: ForgetRow) => `  #${shortId(r.id)} · ${r.type} · ${r.title.replace(/\s+/g, ' ').slice(0, 120)} · ${r.userId.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)} · ${r.createdAt.slice(0, 10)}\n`;

export async function forgetCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string; input?: Readable } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args, 'forget');
  if (!positional.length || (flags.json && flags.yes !== true)) { io.stderr(flags.json ? 'memhive forget: --json needs --yes (no prompt)\n' : USAGE); return 2; }
  const info = await ensureDaemon(home, { wait: true, waitMs: 5000 });
  if (!info) { io.stderr('memhive: daemon unavailable\n'); return 1; }
  const client = new DaemonClient(info);
  try {
    const projectKey = typeof flags.project === 'string' ? flags.project : (await client.request<{ project: { key: string } }>('GET', `/v1/project?cwd=${encodeURIComponent(cwd)}`)).project.key;
    const req = { projectKey, ids: positional, force: flags.force === true };
    const preview = await client.request<ForgetResult>('POST', '/v1/forget', { ...req, preview: true });
    if (preview.not_owner.length) io.stderr(`recorded by someone else (use --force to remove only this machine's copy):\n${preview.not_owner.map(show).join('')}`);
    if (preview.not_found.length) io.stderr(`not found in ${projectKey}: ${preview.not_found.join(', ')}\n`);
    if (!preview.deleted.length) { io.stderr('memhive forget: nothing to forget\n'); return 1; }
    if (!flags.json) io.stdout(`will forget ${preview.deleted.length}:\n${preview.deleted.map(show).join('')}`);
    if (flags.yes !== true) {
      io.stdout(`Forget ${preview.deleted.length} row(s) permanently? [y/N] `);
      const rl = createInterface({ input: opts.input ?? process.stdin, terminal: false });
      const answer = await new Promise<string>((r) => { rl.once('line', r); rl.once('close', () => r('')); }); rl.close();   // end of input = no
      if (!/^y(es)?$/i.test(answer.trim())) { io.stderr('aborted; nothing was deleted\n'); return 1; }
    }
    const done = await client.request<ForgetResult>('POST', '/v1/forget', req);
    io.stdout(flags.json ? JSON.stringify(done, null, 2) + '\n' : formatForget(done) + '\n');
    return 0;
  } catch (e) { io.stderr(`memhive forget: ${e instanceof DaemonError ? e.message : String(e)}\n`); return 1; }
}
