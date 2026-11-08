import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CliIo } from '../index.js';
import { parseArgs } from '../args.js';
import { resolvePaths } from '../../shared/paths.js';
import { loadSettings } from '../../shared/settings.js';
import { readDaemonInfo } from '../../daemon/info.js';
import { DaemonClient } from '../../daemon/client.js';
import { createEmbedder, createProvider } from '../../providers/factory.js';
import { VERSION } from '../../shared/version.js';
import { DatabaseNewerThanBinary, schemaStatus } from '../../store/sqlite/store.js';
import { envDisabled, matchesAny, pausedUntil } from '../../shared/optout.js';
import { projectKeyFor } from '../../shared/project-key.js';
import { loadCredentials } from '../../sync/credentials.js';
import type { ProjectStats, SyncState } from '../../store/types.js';
import { packageRoot } from './install.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface Check {
  status: CheckStatus;
  check: string;
  message: string;
  hint?: string;
}
interface StatusProject {
  key: string;
  hubUrl: string | null;
  stats: ProjectStats;
  sync: SyncState;
  protocol: number | null;
}
interface DaemonStatus {
  observerAuthFailed?: boolean;
  pushBlocked?: string[];
  hubErrors?: Array<{ hub: string; error: string }>;
  vectors_degraded?: boolean;
  projects?: StatusProject[];
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' };
const LOG_WARN_BYTES = 10 * 1024 * 1024; // twice the rotation size: rotation is not keeping up
const REINSTALL = 'run `memhive install` again';
const when = (ms: number | null) => (ms ? new Date(ms).toISOString() : 'never');
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** NODE and BUNDLE paths of a rendered plugin file (hooks.json and .mcp.json: command + args[0]; codex-hooks.json: one sh string). */
export function renderedPaths(file: string): { node: string; bundle: string } | null {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const first =
    j.mcpServers?.memhive ??
    Object.values(j.hooks ?? {})
      .flat()
      .flatMap((m: any) => m.hooks ?? [])[0];
  if (!first) return null;
  if (Array.isArray(first.args)) return { node: first.command, bundle: first.args[0] };
  const m = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(first.command ?? ''); // shq() from plugin-files.ts
  return m ? { node: m[1].replace(/'\\''/g, "'"), bundle: m[2].replace(/'\\''/g, "'") } : null;
}

/** Line and column of the first character JSON.parse rejects. V8's own message can quote the file (API keys), so it is not shown. */
export function jsonErrorAt(text: string): { line: number; column: number } {
  // Every prefix before the bad character parses or fails only at its own end; bisect for the longest such prefix.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    try {
      JSON.parse(text.slice(0, mid));
      lo = mid;
    } catch (e) {
      const m = (e as Error).message;
      const pos = /at position (\d+)/.exec(m);
      if (/end of JSON input/i.test(m) || (pos && Number(pos[1]) >= mid)) lo = mid;
      else hi = mid - 1;
    }
  }
  const before = text.slice(0, lo).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

// Never prints secrets: API keys and the daemon token are reported only as set / not set.
export async function doctorCommand(
  args: string[],
  io: CliIo,
  opts: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    ping?: boolean;
    cwd?: string;
    nodeVersion?: string;
    nodePath?: string;
    bundle?: string;
  } = {}
): Promise<number> {
  const home = opts.home ?? resolvePaths().home;
  const env = opts.env ?? process.env;
  const paths = resolvePaths(home);
  const { flags } = parseArgs(args, 'doctor');
  const json = !!flags.json;
  const checks: Check[] = [];
  const add = (status: CheckStatus, check: string, message: string, hint?: string) => {
    checks.push({ status, check, message, ...(hint ? { hint } : {}) });
    if (!json) io.stdout(`${LABEL[status]} ${message}${hint ? ` (fix: ${hint})` : ''}\n`);
  };
  if (!json) io.stdout(`memhive ${VERSION} · home ${home}\n`);

  const node = opts.nodeVersion ?? process.versions.node;
  add(
    Number(node.split('.')[0]) >= 22 ? 'ok' : 'fail',
    'node',
    `node v${node} (memhive needs >= 22)`,
    Number(node.split('.')[0]) >= 22 ? undefined : 'install Node.js 22 or newer, then run `memhive install` with it'
  );

  // loadSettings ignores a file that does not parse; say so here, with the parser's position.
  if (existsSync(paths.settings)) {
    const text = readFileSync(paths.settings, 'utf8');
    try {
      JSON.parse(text);
      add('ok', 'settings', 'settings.json parses');
    } catch {
      const at = jsonErrorAt(text);
      add(
        'fail',
        'settings',
        `settings.json is not valid JSON at line ${at.line} column ${at.column}; defaults are used`,
        `fix ${paths.settings} or run \`memhive install\``
      );
    }
  } else add('info', 'settings', 'no settings.json (defaults and MEMHIVE_* env)', 'run `memhive install`');
  let s;
  try {
    s = loadSettings(home, env);
  } catch (e) {
    add('fail', 'settings', `settings: ${e instanceof Error ? e.message : e}`);
    return finish();
  }
  add(
    'ok',
    'provider',
    `provider ${s.llm.provider} model ${s.llm.model}${s.llm.baseUrl ? ` at ${s.llm.baseUrl}` : ''} (api key ${s.llm.apiKey ? 'set' : 'not set'})`
  );
  if (s.embed)
    add(
      'ok',
      'embedder',
      `embedder ${s.embed.model} (${s.embed.dims} dims) at ${s.embed.baseUrl} (api key ${s.embed.apiKey ? 'set' : 'not set'})`
    );
  else add('info', 'embedder', 'embedder: not configured (FTS-only search)');
  let provider;
  try {
    provider = createProvider(s);
    add('ok', 'provider', 'provider credentials present');
  } catch (e) {
    add('fail', 'provider', `provider: ${e instanceof Error ? e.message : e}`);
  }
  if (opts.ping !== false && !flags['no-ping']) {
    if (provider) {
      try {
        const t = await provider.complete({ system: 'Reply with the JSON {"ok":true}', user: 'ping', maxTokens: 20 });
        add(t.includes('ok') ? 'ok' : 'fail', 'provider-ping', `provider ping: ${t.slice(0, 40).replace(/\n/g, ' ')}`);
      } catch (e) {
        add('fail', 'provider-ping', `provider ping failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    try {
      const emb = createEmbedder(s);
      if (emb) {
        const [v] = await emb.embed(['ping']);
        add(v.length === emb.dims ? 'ok' : 'fail', 'embedder-ping', `embedder ping: ${v.length} dims`);
      }
    } catch (e) {
      add('fail', 'embedder-ping', `embedder ping failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  try {
    const st = schemaStatus(paths.db);
    if (!st) add('info', 'schema', 'no database yet (created by the first session)');
    else if (st.version > st.known)
      add(
        'fail',
        'schema',
        `database: ${new DatabaseNewerThanBinary(st.version, st.known).message}`,
        'npm install -g memhive'
      );
    else
      add(
        'ok',
        'schema',
        `database schema v${st.version} (this memhive knows up to v${st.known}${st.version < st.known ? '; the daemon migrates it on start' : ''})`
      );
  } catch (e) {
    add('fail', 'schema', `database unreadable: ${e instanceof Error ? e.message : e}`);
  }

  // Rendered plugin files point at one Node binary and one bundle; a Node version manager switch or an upgrade breaks them silently.
  const plugin = paths.plugin;
  if (!existsSync(plugin)) add('info', 'plugin', 'plugin files not rendered', 'run `memhive install`');
  else {
    const wantNode = opts.nodePath ?? process.execPath;
    const wantBundle = opts.bundle ?? path.join(packageRoot(), 'dist', 'memhive.cjs');
    for (const rel of ['hooks/hooks.json', 'hooks/codex-hooks.json', '.mcp.json']) {
      const file = path.join(plugin, rel);
      if (!existsSync(file)) continue;
      let p;
      try {
        p = renderedPaths(file);
      } catch (e) {
        add('warn', 'plugin', `${rel} unreadable: ${e instanceof Error ? e.message : e}`, REINSTALL);
        continue;
      }
      if (!p) {
        add('warn', 'plugin', `${rel} has no memhive command`, REINSTALL);
        continue;
      }
      const problems = [
        !existsSync(p.node) && `node ${p.node} does not exist`,
        !existsSync(p.bundle) && `bundle ${p.bundle} does not exist`,
        existsSync(p.node) && p.node !== wantNode && `runs node ${p.node}, not ${wantNode}`,
        existsSync(p.bundle) && p.bundle !== wantBundle && `runs bundle ${p.bundle}, not ${wantBundle}`,
      ].filter(Boolean);
      add(
        problems.length ? 'warn' : 'ok',
        'plugin',
        `plugin ${rel}: ${problems.length ? problems.join('; ') : 'node and bundle paths are current'}`,
        problems.length ? REINSTALL : undefined
      );
    }
    try {
      const v = JSON.parse(readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version;
      if (v !== VERSION)
        add('warn', 'plugin', `plugin files were rendered by memhive ${v}, this is ${VERSION}`, REINSTALL);
    } catch {
      /* no manifest: covered above */
    }
  }

  const until = envDisabled(env) ? Infinity : pausedUntil(home);
  if (until !== null)
    add(
      'info',
      'capture',
      `capture ${envDisabled(env) ? 'disabled by MEMHIVE_DISABLED' : until === Infinity ? 'paused until `memhive resume`' : `paused until ${new Date(until).toISOString()}`}`
    );
  const here = projectKeyFor(opts.cwd ?? process.cwd());
  if (here.disabled || matchesAny(s.excludeProjects, here.key, here.top))
    add(
      'info',
      'capture',
      `this project (${here.key}) is excluded from capture (${here.disabled ? '.memhive.json' : 'excludeProjects'})`
    );

  const info = readDaemonInfo(home);
  const client = info ? new DaemonClient(info) : null;
  const alive = client ? await client.health(1000) : false;
  add('ok', 'daemon', alive ? `daemon running on port ${info!.port}` : 'daemon not running (starts on first hook)');
  if (alive && (client!.version ?? info!.version) !== VERSION)
    add(
      'warn',
      'daemon',
      `daemon is memhive ${client!.version ?? info!.version ?? '< 0.2'}, this CLI is ${VERSION}`,
      'the next hook or command restarts it, or run `memhive daemon stop`'
    );
  if (alive) {
    try {
      const st = await client!.request<DaemonStatus>('GET', '/v1/status?projects=1', undefined, 10_000);
      add(
        st.observerAuthFailed ? 'fail' : 'ok',
        'observer',
        st.observerAuthFailed
          ? 'observer: provider rejected the API key (401/403); observations paused until settings.json changes (retried every 15 min)'
          : 'observer running'
      );
      if (st.vectors_degraded)
        add(
          'warn',
          'vectors',
          'sqlite-vec did not load: vector search is off (FTS only)',
          'reinstall memhive (npm install -g memhive) so the sqlite-vec binary matches this platform'
        );
      else if (s.embed) add('ok', 'vectors', 'sqlite-vec loaded');
      if (st.pushBlocked?.length)
        add(
          'fail',
          'sync',
          `sync: push to the hub keeps failing with a 404 or a non-hub 4xx for ${st.pushBlocked.length} project(s); check the hub URL and any proxy (see daemon log)`
        );
      for (const h of st.hubErrors ?? []) add('fail', 'sync', `sync: ${h.hub}: ${h.error}`, 'npm install -g memhive');
      const missing = (st.projects ?? []).reduce((n, p) => n + p.stats.missingEmbedding, 0);
      if (s.embed && missing)
        add(
          'info',
          'embeddings',
          `${missing} observation(s) without an embedding (the daemon backfills them)`,
          missing > 1000 ? 'memhive embed' : undefined
        );
      projectChecks(st.projects ?? [], home, add);
    } catch (e) {
      add('fail', 'observer', `observer status unavailable: ${e instanceof Error ? e.message : e}`);
    }
  }
  logChecks(paths.logs, add);
  return finish();

  function finish(): number {
    const problems = checks.filter((c) => c.status === 'fail').length;
    if (json) io.stdout(JSON.stringify({ version: VERSION, home, problems, checks }, null, 2) + '\n');
    else io.stdout(problems ? `${problems} problem(s) found\n` : 'all good\n');
    return problems ? 1 : 0;
  }
}

function projectChecks(
  projects: StatusProject[],
  home: string,
  add: (s: CheckStatus, c: string, m: string, h?: string) => void
): void {
  const creds = loadCredentials(home).hubs;
  for (const p of projects.filter((x) => x.hubUrl)) {
    const name = `${p.key} -> ${p.hubUrl}`;
    const cred = creds[p.hubUrl!];
    if (!cred) add('fail', 'project', `${name}: not logged in to this hub`, `memhive login ${p.hubUrl}`);
    else if (cred.authFailed)
      add(
        'fail',
        'project',
        `${name}: the hub rejected the key of ${cred.user} (401); sync stopped`,
        `memhive login ${p.hubUrl}`
      );
    else
      add('ok', 'project', `${name}: logged in as ${cred.user}, hub protocol ${p.protocol ?? 'unknown (unreachable)'}`);
    const u = p.stats.unsynced;
    add(
      'info',
      'project',
      `${name}: unsynced ${u.observations} observations, ${u.summaries} summaries, ${u.sessions} sessions, ${u.tombstones} forgets; last push ${when(p.sync.lastPushAt)}, last pull ${when(p.sync.lastPullAt)}`
    );
    const backoff = p.sync.backoffUntil && p.sync.backoffUntil > Date.now();
    if (backoff || p.sync.lastError)
      add(
        'warn',
        'project',
        `${name}: ${backoff ? `push backs off until ${when(p.sync.backoffUntil)}; ` : ''}last error ${p.sync.lastError ?? 'none'} at ${when(p.sync.lastErrorAt)}`,
        'check the daemon log; `memhive sync` retries now'
      );
    if (p.sync.quarantined)
      add(
        'warn',
        'project',
        `${name}: ${p.sync.quarantined} pulled row(s) quarantined (could not be stored)`,
        'see logs/daemon.log; a teammate on a newer memhive may need you to upgrade'
      );
  }
}

function logChecks(dir: string, add: (s: CheckStatus, c: string, m: string, h?: string) => void): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.log'));
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const size = statSync(path.join(dir, n)).size;
    const rotated = existsSync(path.join(dir, `${n}.1`));
    if (size > LOG_WARN_BYTES)
      add(
        'warn',
        'logs',
        `logs/${n} is ${mb(size)}: rotation (at 5 MB) is not keeping up`,
        `delete ${path.join(dir, n)}`
      );
    else add('info', 'logs', `logs/${n} ${mb(size)}${rotated ? ' (+ rotated .1)' : ''}`);
  }
}
