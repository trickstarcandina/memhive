import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { COMMANDS } from '../help.js';
import { resolvePaths } from '../../shared/paths.js';
import { writeFileAtomic } from '../../shared/fs.js';
import { DaemonError, type DaemonClient } from '../../daemon/client.js';
import { formatFull } from '../../mcp/format.js';
import { shortId } from '../../shared/ids.js';
import type { Observation, Session, Summary } from '../../store/types.js';
import { daemonFor, printJson, projectKeyFor } from './search.js';

const fail = (io: CliIo, cmd: string, e: unknown): number => {
  if (e instanceof DaemonError) {
    io.stderr(`memhive ${cmd}: ${e.message}\n`);
    return 1;
  }
  throw e;
};

/** `backup [path]`: VACUUM INTO through the daemon (consistent while it writes); default ./memhive-backup-<time>.db. */
export async function backupCommand(
  args: string[],
  io: CliIo,
  opts: { home?: string; cwd?: string } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args, 'backup');
  if (positional.length > 1) {
    io.stderr(COMMANDS.backup.usage);
    return 2;
  }
  const file = path.resolve(
    cwd,
    positional[0] ?? `memhive-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
  );
  const client = await daemonFor(home, io);
  if (!client) return 1;
  try {
    const r = await client.request<{ path: string; bytes: number }>('POST', '/v1/backup', { path: file }, 120_000);
    if (flags.json) printJson(io, r);
    else
      io.stdout(
        `backup written to ${r.path} (${(r.bytes / 1024 / 1024).toFixed(1)} MB, mode 0600; it holds your memory, not your API keys)\n`
      );
    return 0;
  } catch (e) {
    return fail(io, 'backup', e);
  }
}

type Kind = 'session' | 'observation' | 'summary';
async function* exportPages(client: DaemonClient, key: string, kind: Kind) {
  for (let after: number | null = 0; after !== null; ) {
    const r: { rows: Array<Record<string, unknown>>; next: number | null } = await client.request(
      'GET',
      `/v1/export?project_key=${encodeURIComponent(key)}&kind=${kind}&after=${after}`,
      undefined,
      30_000
    );
    yield* r.rows;
    after = r.next;
  }
}

/** `export [--project key] [--format jsonl|md] [--out file]`: every session, observation and summary of one project. */
export async function exportCommand(
  args: string[],
  io: CliIo,
  opts: { home?: string; cwd?: string } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args, 'export');
  const format = flags.format ?? 'jsonl';
  if (positional.length || (format !== 'jsonl' && format !== 'md') || flags.out === true) {
    io.stderr(COMMANDS.export.usage);
    return 2;
  }
  const client = await daemonFor(home, io);
  if (!client) return 1;
  try {
    const key = await projectKeyFor(client, flags, cwd, io);
    if (key === null) return 1;
    const rows: Array<Record<string, unknown>> = [];
    for (const kind of ['session', 'observation', 'summary'] as const)
      for await (const r of exportPages(client, key, kind)) rows.push(r);
    const clean = rows.map(({ projectId: _p, syncedAt: _s, embeddingModel: _e, ...r }) => r); // the importing machine decides these
    const text =
      format === 'jsonl'
        ? [JSON.stringify({ kind: 'project', key }), ...clean.map((r) => JSON.stringify(r))].join('\n') + '\n'
        : markdown(key, rows);
    if (typeof flags.out === 'string') {
      const file = path.resolve(cwd, flags.out);
      if (existsSync(file) && flags.force !== true) {
        io.stderr(`memhive export: ${file} already exists (--force replaces it)\n`);
        return 1;
      }
      try {
        if (flags.force !== true) writeNew(file, text);
        else writeFileAtomic(file, text, 0o600); // replaces a file or symlink, never writes through it; no temp copy left
      } catch (e) {
        io.stderr(
          `memhive export: cannot write ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}\n`
        );
        return 1;
      }
      io.stderr(`exported ${rows.length} rows of ${key} to ${flags.out}\n`);
    } else io.stdout(text);
    return 0;
  } catch (e) {
    return fail(io, 'export', e);
  }
}

// 0600 from the first byte (an export holds the same memory as the database); wx: never through an existing file or symlink.
function writeNew(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function markdown(key: string, rows: Array<Record<string, unknown>>): string {
  const sessions = rows.filter((r) => r.kind === 'session') as unknown as Session[];
  const of = <T>(kind: string, sid: string) =>
    rows.filter((r) => r.kind === kind && r.sessionId === sid) as unknown as T[];
  const out = [`# ${key}`, ''];
  for (const s of sessions) {
    out.push(`## Session #${shortId(s.id)} · ${s.host} · ${s.userId} · ${s.startedAt}`, '');
    out.push(formatFull(of<Observation>('observation', s.id), of<Summary>('summary', s.id)), '');
  }
  return out.join('\n');
}

/** `import <file.jsonl> [--project key] [--sync]`: idempotent on ids; rows are marked synced unless --sync. */
export async function importCommand(
  args: string[],
  io: CliIo,
  opts: { home?: string; cwd?: string } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const cwd = opts.cwd ?? process.cwd();
  const { positional, flags } = parseArgs(args, 'import');
  if (positional.length !== 1) {
    io.stderr(COMMANDS.import.usage);
    return 2;
  }
  let lines: unknown[];
  try {
    lines = readFileSync(path.resolve(cwd, positional[0]), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new Error(`line ${i + 1} is not JSON`);
        }
      });
  } catch (e) {
    io.stderr(`memhive import: ${(e as Error).message}\n`);
    return 1;
  }
  const client = await daemonFor(home, io);
  if (!client) return 1;
  try {
    const projectKey = await projectKeyFor(client, flags, cwd, io);
    if (projectKey === null) return 1;
    const total = { sessions: 0, observations: 0, summaries: 0 };
    let skipped = 0;
    // Batches stay under the daemon's 2 MB body limit; file order keeps sessions before the rows that need them.
    for (let i = 0; i < lines.length; ) {
      const batch: unknown[] = [];
      let bytes = 0;
      while (i < lines.length && batch.length < 500 && bytes < 1_000_000) {
        bytes += JSON.stringify(lines[i]).length;
        batch.push(lines[i++]);
      }
      const r = await client.request<{ imported: typeof total; skipped: number }>(
        'POST',
        '/v1/import',
        { projectKey, rows: batch, sync: flags.sync === true },
        60_000
      );
      for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += r.imported[k];
      skipped += r.skipped;
    }
    if (flags.json) printJson(io, { project: projectKey, imported: total, skipped });
    else
      io.stdout(
        `imported into ${projectKey}: ${total.sessions} sessions, ${total.observations} observations, ${total.summaries} summaries; ${skipped} skipped (already here, forgotten, or without their session)${flags.sync ? '' : '; marked synced, so nothing is pushed'}\n`
      );
    return 0;
  } catch (e) {
    return fail(io, 'import', e);
  }
}
