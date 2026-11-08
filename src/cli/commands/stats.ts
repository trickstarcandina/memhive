import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import type { ProjectStats } from '../../store/types.js';
import { daemonFor, printJson } from './search.js';

export interface StatsResult {
  db_bytes: number;
  projects: Array<ProjectStats & { key: string; name: string; hubUrl: string | null; lastPushAt: number | null; lastPullAt: number | null }>;
  observer: { since: string; calls: number; failures: number; unparseable: number; stored: number; duplicates: number };
}
const when = (ms: number | null) => (ms ? new Date(ms).toISOString() : 'never');

/** `stats [--project key] [--json]`: row counts per project and the observer's counters since the daemon started. */
export async function statsCommand(args: string[], io: CliIo, opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const { flags } = parseArgs(args, 'stats');
  const client = await daemonFor(home, io); if (!client) return 1;
  const r = await client.request<StatsResult>('GET', `/v1/stats${typeof flags.project === 'string' ? `?project_key=${encodeURIComponent(flags.project)}` : ''}`);
  if (flags.json) { printJson(io, r); return 0; }
  io.stdout(`database ${(r.db_bytes / 1024 / 1024).toFixed(1)} MB\n`);
  if (!r.projects.length) io.stdout(typeof flags.project === 'string' ? `no project ${flags.project}\n` : 'no projects yet\n');
  for (const p of r.projects) {
    io.stdout(`${p.key}${p.hubUrl ? ` (linked to ${p.hubUrl})` : ''}: ${p.observations.local + p.observations.hub} observations (${p.observations.local} own, ${p.observations.hub} team), ${p.sessions} sessions, ${p.summaries} summaries, ${p.pinned} pinned\n`);
    const types = Object.entries(p.byType).map(([t, n]) => `${t} ${n}`).join(', ');
    if (types) io.stdout(`  by type: ${types}\n`);
    if (p.hubUrl) io.stdout(`  last push ${when(p.lastPushAt)}, last pull ${when(p.lastPullAt)}\n`);
  }
  const o = r.observer;
  io.stdout(`observer since daemon start (${o.since}): ${o.calls} provider calls, ${o.failures} failed, ${o.unparseable} unparseable, ${o.stored} observations stored, ${o.duplicates} duplicates skipped\n`);
  return 0;
}
