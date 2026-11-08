import { VERSION } from '../shared/version.js';

/** One entry per command: its usage text, the flags that take a value, and the flags that never do. */
export interface CommandSpec { usage: string; value: string[]; bool: string[] }

const spec = (usage: string, value: string[] = [], bool: string[] = []): CommandSpec => ({ usage, value, bool });

export const COMMANDS: Record<string, CommandSpec> = {
  install: spec('usage: memhive install [--yes] [--host claude-code,codex] [--provider anthropic|openai-compat] [--no-ping]\n', ['host', 'provider'], ['yes', 'no-ping']),
  uninstall: spec(`usage: memhive uninstall [--purge [--yes]]   (removes the plugin from Claude Code and Codex; your memory stays)
  --purge  also delete the memhive home (database, logs, settings.json and credentials.json with API keys) after a confirmation
  --yes    with --purge: do not ask
`, [], ['purge', 'yes']),
  doctor: spec(`usage: memhive doctor [--no-ping] [--json]   (checks setup; exit 1 when any check fails)
  --no-ping  skip the provider and embedder calls
  --json     {"version", "home", "problems", "checks": [{"status": "ok|warn|fail|info", "check", "message", "hint"?}]}
`, [], ['no-ping', 'json']),
  stats: spec(`usage: memhive stats [--project key] [--json]   (row counts per project; observer counters since the daemon started)
  --json  {"db_bytes", "projects": [{"key", "name", "hubUrl", "observations": {"local", "hub"}, "byType", "sessions", "summaries", "pinned", "unsynced", "missingEmbedding", "lastPushAt", "lastPullAt"}], "observer": {"since", "calls", "failures", "unparseable", "stored", "duplicates"}}
`, ['project'], ['json']),
  backup: spec('usage: memhive backup [path] [--json]   (consistent copy of the database through the daemon; default ./memhive-backup-<time>.db; never inside the memhive home; --json {"path", "bytes"})\n', [], ['json']),
  export: spec(`usage: memhive export [--project key] [--format jsonl|md] [--out file [--force]]   (every session, observation and summary of the project; default the current one, to stdout)
  jsonl: one row per line with "kind" (project, session, observation, summary) and its fields; md: grouped by session
  --out is created 0600 and never overwritten unless --force (then replaced, not written through)
`, ['project', 'format', 'out'], ['force']),
  import: spec(`usage: memhive import <file.jsonl> [--project key] [--sync] [--json]   (rows from memhive export, into the current project or --project)
  rows are cleaned like pulled ones; ids already here or forgotten are skipped; rows are marked synced unless --sync
  (then they are imported as your own rows and a linked project pushes them)
  --json  {"project", "imported": {"sessions", "observations", "summaries"}, "skipped"}
`, ['project'], ['sync', 'json']),
  hook: spec('usage: memhive hook <claude-code|codex> <event>\n'),
  daemon: spec('usage: memhive daemon <run|start|stop|status> [--json]   (--json: status only, {"running", "port", "pid", "startedAt", "version"})\n', [], ['json']),
  mcp: spec('usage: memhive mcp\n'),
  search: spec(`usage: memhive search <query> [--type t] [--user u] [--since 7d] [--limit n] [--offset n] [--project key | --all-projects] [--json]
  an empty query with --since or --type lists the newest observations under those filters
  --json  {"results": [observation or summary, each with "kind"]}
`, ['type', 'user', 'since', 'limit', 'offset', 'project'], ['json', 'all-projects']),
  recent: spec('usage: memhive recent [--limit n] [--offset n] [--type t] [--user u] [--since 7d] [--project key | --all-projects] [--json]   (newest observations; --json as search)\n', ['limit', 'offset', 'type', 'user', 'since', 'project'], ['json', 'all-projects']),
  show: spec('usage: memhive show <id...> [--json]   (full observations or session summaries; --json {"observations": [...], "summaries": [...]})\n', [], ['json']),
  edit: spec(`usage: memhive edit <id> [--title text] [--narrative text] [--pin | --unpin] [--project key] [--json]
  title and narrative: only your own rows, and the change stays on this machine; pin: any row of the project
  --json  {"observation": {...}}
`, ['title', 'narrative', 'project'], ['pin', 'unpin', 'json']),
  forget: spec('usage: memhive forget <id...> [--yes] [--force] [--project key] [--json]   (deletes observations or summaries; asks first unless --yes)\n  --force  also remove someone else\'s row, from this machine only (the hub and teammates keep it)\n  --json   needs --yes; {"deleted": [...], "not_owner": [...], "not_found": [...], "propagates": true|false|null}\n', ['project'], ['yes', 'force', 'json']),
  embed: spec('usage: memhive embed [--missing|--rebuild]\n', [], ['missing', 'rebuild']),
  serve: spec('usage: memhive serve [--reset-vectors]   (env: DATABASE_URL, PORT, MEMHIVE_EMBED_MODEL, MEMHIVE_EMBED_DIMS, MEMHIVE_RESET_VECTORS)\n  --reset-vectors  after a MEMHIVE_EMBED_DIMS change, drop every stored vector instead of refusing to start\n', [], ['reset-vectors']),
  key: spec('usage: memhive key <create --user <name> [--label <text>] | list | revoke <id> | rotate <id|user>> [--json]   (env: DATABASE_URL of the hub)\n', ['user', 'label'], ['json']),
  user: spec('usage: memhive user <list | remove <name>> [--json]   (remove revokes every key of the user; their rows stay on the hub)\n', [], ['json']),
  project: spec('usage: memhive project list [--json]   (projects on the hub with row counts)\n', [], ['json']),
  login: spec('usage: memhive login <hub-url> [--key-stdin]   (prompts for the API key without echo; --key-stdin reads it from stdin)\n', [], ['key-stdin']),
  link: spec('usage: memhive link <hub-url>   (links the current project to a hub you are logged in to)\n'),
  unlink: spec('usage: memhive unlink   (stops syncing the current project)\n'),
  sync: spec('usage: memhive sync [--json]   (push and pull the current project now; --json {"pushed", "pulled", "error"?})\n', [], ['json']),
  pause: spec('usage: memhive pause [duration like 30m, 1h, 2d]   (record nothing until then; no duration: until memhive resume)\n'),
  resume: spec('usage: memhive resume   (ends a pause)\n'),
  version: spec('usage: memhive version\n'),
};

export const USAGE = `memhive ${VERSION}
usage: memhive <command>   (memhive <command> --help for its flags)
  install | uninstall [--purge] | doctor [--json] | stats [--project key] [--json]
  hook <claude-code|codex> <event>
  daemon <run|start|stop|status>
  mcp
  search <query> [--type t] [--user u] [--since 7d] [--limit n] [--project key|--all-projects] [--json]
  recent [--limit n]   show <id...>   edit <id> [--title t] [--narrative t] [--pin|--unpin]
  forget <id...> [--yes] [--force] [--project key]
  embed [--missing|--rebuild]
  backup [path] | export [--project key] [--format jsonl|md] [--out file] | import <file.jsonl> [--sync]
  serve [--reset-vectors]
  key <create|list|revoke|rotate>   user <list|remove>   project list
  login <hub-url> [--key-stdin]
  link <hub-url> | unlink | sync
  pause [30m|1h|2d] | resume
  version
--json: machine-readable output for commands that print data (see each --help)
exit codes: 0 ok, 1 error, 2 usage
`;

/** A usage error for argv of cmd (unknown flag, or a value flag without its value), or null. */
export function flagError(cmd: string, argv: string[]): string | null {
  const s = COMMANDS[cmd];
  if (!s || cmd === 'hook') return null;   // hooks are called by the host and must never fail on argv
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') continue;
    const eq = a.indexOf('='); const name = a.slice(2, eq > 0 ? eq : undefined);
    if (s.bool.includes(name)) continue;
    if (!s.value.includes(name)) return `unknown flag --${name} for ${cmd}; see memhive ${cmd} --help\n`;
    if (eq > 0) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return `memhive ${cmd}: --${name} needs a value; see memhive ${cmd} --help\n`;
    i++;
  }
  return null;
}
