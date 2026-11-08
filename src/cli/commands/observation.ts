import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { COMMANDS } from '../help.js';
import { resolvePaths } from '../../shared/paths.js';
import { DaemonError } from '../../daemon/client.js';
import { formatFull } from '../../mcp/format.js';
import { shortId } from '../../shared/ids.js';
import type { Observation, Summary } from '../../store/types.js';
import { daemonFor, printJson, projectKeyFor } from './search.js';

/** `show <id...>`: full observations or session summaries (full ids, unique prefixes or 8-char short ids). */
export async function showCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const { positional, flags } = parseArgs(args, 'show');
  const ids = positional.map((x) => x.replace(/^#/, ''));
  if (!ids.length || ids.length > 50) { io.stderr(COMMANDS.show.usage); return 2; }
  const client = await daemonFor(home, io); if (!client) return 1;
  const r = await client.request<{ observations: Observation[]; summaries?: Summary[] }>('GET', `/v1/observations?ids=${encodeURIComponent(ids.join(','))}`);
  const summaries = r.summaries ?? [];
  if (flags.json) printJson(io, { observations: r.observations, summaries });
  else io.stdout(formatFull(r.observations, summaries) + '\n');
  return r.observations.length + summaries.length ? 0 : 1;
}

/** `edit <id>`: title, narrative (own rows only; stays on this machine) and pin. */
export async function editCommand(args: string[], io: CliIo, opts: { home?: string; cwd?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home; const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args, 'edit');
  const str = (k: string) => (typeof flags[k] === 'string' ? flags[k] as string : undefined);
  const patch = { title: str('title'), narrative: str('narrative'), pinned: flags.pin ? true : flags.unpin ? false : undefined };
  if (positional.length !== 1 || (flags.pin && flags.unpin) || Object.values(patch).every((v) => v === undefined)) { io.stderr(COMMANDS.edit.usage); return 2; }
  const client = await daemonFor(home, io); if (!client) return 1;
  try {
    const projectKey = await projectKeyFor(client, flags, cwd, io); if (projectKey === null) return 1;
    const r = await client.request<{ observation: Observation }>('POST', '/v1/observations/edit', { projectKey, id: positional[0], ...patch });
    const o = r.observation;
    if (flags.json) printJson(io, r); else io.stdout(`edited #${shortId(o.id)} · ${o.type} · ${o.title.replace(/\s+/g, ' ').slice(0, 120)}${o.pinned ? ' · pinned' : ''}\n`);
    return 0;
  } catch (e) { if (e instanceof DaemonError) { io.stderr(`memhive edit: ${e.message}\n`); return 1; } throw e; }
}
