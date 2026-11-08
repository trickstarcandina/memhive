# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break settings or the hub protocol).

After upgrading, re-run `memhive install`.

## [Unreleased]

## [0.2.0] - 2026-11-09

### Upgrading

- Re-run `memhive install` after upgrading: it rewrites the plugin files for the new build and stops the old daemon.
- Hub operators:
  - Upgrade the hub before clients. The hub speaks protocol 2 (tombstones); a 0.2 client refuses a hub with a newer protocol and holds its tombstones for a protocol 1 hub.
  - `MEMHIVE_EMBED_DIMS` is checked against the database at start. If it changed, start once with `memhive serve --reset-vectors` (or `MEMHIVE_RESET_VECTORS=1`), which drops the hub's vectors.
  - The first admin key is written to `$MEMHIVE_HOME/hub-admin-key` (mode 0600; `/data/hub-admin-key` in compose) instead of the logs. `MEMHIVE_PRINT_ADMIN_KEY=1` also prints it.
  - A bare `memhive serve` listens on `127.0.0.1`. Set `HOST=0.0.0.0` (or `MEMHIVE_HOST`) to listen on all interfaces; the Docker image already does.
- Scripts: `memhive sync` exits 1 when the push or pull failed, and usage errors exit 2.
- Daemon API: `/v1/observations` and `/v1/timeline` need `project_key` (or `all_projects=1`).

### Added

- Forgetting: `memhive forget` and the MCP `forget` tool delete rows with a tombstone. On a linked hub the tombstone is pushed and every teammate drops the row on the next pull (hub protocol 2). A forgotten id is never pulled or accepted back.
- Pinned observations (MCP `pin` / `unpin`, `memhive edit --pin`), always listed first in the session-start context, and opt-in retention per type (`retentionDays`, `MEMHIVE_RETENTION_DAYS`).
- Opt-out: `MEMHIVE_DISABLED=1`, `excludeProjects` (`MEMHIVE_EXCLUDE_PROJECTS`), a committed `.memhive.json` with `{ "disabled": true }`, and `memhive pause` / `memhive resume`. `.memhive.json` can also give a monorepo package its own project key.
- CLI commands: `show`, `recent`, `edit`, `stats`, `backup`, `export` (jsonl or Markdown), `import`, and `embed --rebuild`. `search` takes `--json`, `--project`, `--all-projects` and `--offset`. Every command has `--help`, refuses unknown flags and exits 2 on usage errors.
- Hub admin commands: `memhive key create|list|revoke|rotate`, `memhive user list|remove`, `memhive project list`, all with `--json`.
- `memhive doctor` checks plugin paths and versions, `settings.json` parse errors, the database schema, sqlite-vec and missing embeddings, observer auth failures, and per linked project the login, hub protocol, backlog, backoff and quarantined rows. `--json` output.
- Session-start context is ranked by relevance: age, type, own rows, files under the working directory, same git branch, and rows recorded again. `context.scope: "mine"` (`MEMHIVE_CONTEXT_SCOPE`) keeps teammates' rows out of it.
- Search includes session summaries.
- The observer skips near-duplicate observations and counts them on the existing row instead.
- Embeddings record their model; a model or size change re-embeds, and the daemon backfills missing vectors steadily.
- `mcp.allowProjects` (`MEMHIVE_MCP_ALLOW_PROJECTS`) lists the other projects the MCP `search` tool may read.
- The daemon restarts an older running daemon after an upgrade, and refuses a database written by a newer memhive.
- `memhive uninstall --purge` deletes `~/.memhive` after asking.
- Pull requests can leave vectors out (`vectors=0`), and pull pages are capped at the hub's body limit.
- Releases are mirrored to GitHub Packages as `@trickstarcandina/memhive`.
- A clear error on Node.js older than 22.
- SECURITY.md, CONTRIBUTING.md, CHANGELOG.md and docs/ARCHITECTURE.md (components and hub protocol).

### Changed

- The hub validates push bodies with zod schemas and field caps. An over-cap row is rejected on its own (`invalid_row` with the field), so the rest of the body lands.
- Session working directories and git branches stay on the machine: clients stop sending `cwd`, and the hub stops storing and relaying it.
- Rows pulled from a hub show only their title in the context, and their file lists give no boost.
- Session start no longer waits for the hub pull.
- Sync backoff state survives a restart, and 404 or a bare 4xx (no hub error body) back off too, with a bounded give-up.
- Pulled rows are validated one by one; a row that cannot be stored is quarantined locally instead of skipped.
- Retention is opt-in: nothing expires unless `retentionDays` is set.
- Stored prompts are pruned.
- Hub writes use batch inserts, and the hub and client stores have new indexes (short ids, unsynced sessions, missing embeddings, cheaper dedupe lookups).
- `memhive uninstall` resets Codex's `[features] hooks` only if `memhive install` turned it on.
- MCP tools and `get_observations` / `timeline` are scoped to the current project.
- `package.json` is the only place the version is written; the bundle no longer ships a sourcemap.
- The Docker build stage no longer installs a compiler toolchain.
- CI runs Node 22 and 24 on Linux, macOS and Windows with a packed-tarball smoke test, pinned actions and a read-only token, plus Biome lint, a coverage report and an optional shuffled run. `npm run pack:check` asserts the published file list. Dependabot watches npm, GitHub Actions and the Docker images.
- Code is formatted and linted with Biome (`npm run format`, `npm run lint`).

### Deprecated

- `context.includeOtherUsers: false` / `MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS=0`: use `context.scope: "mine"`.

### Fixed

- Vector search fills its limit under selective filters (type, user, since).
- The daemon finishes in-flight observer work (summaries, embedding backfill) before it shuts down, and two daemons never overlap after an upgrade.
- `settings.json` and Codex `config.toml` are written atomically (temp file and rename); `config.toml` is backed up before the first edit.
- `memhive install` refuses a Codex config edit that would change more than the one key.
- The MCP server re-checks the daemon when its token changes.
- Opt-out also covers MCP `save_memory` and project lookups; a lookup no longer creates a project row.
- Facts and subtitles such as `---` can no longer render as Markdown thematic breaks.
- Dedupe compares only against local rows, so a pushed row cannot suppress the user's own observations.
- A hub request URL that cannot be parsed gets 400 instead of crashing the hub.

### Security

- Secret redaction covers connection strings, JWTs without `Bearer`, PGP and other private key blocks, `Authorization: Basic`, cookies, URL userinfo, `curl -u`, Slack webhooks and more vendor token formats (Stripe, Google, GitLab, npm, Hugging Face, SendGrid, Twilio), with fewer false positives (ports are not passwords).
- Rows pulled from a hub are redacted and clipped again before they are stored; quarantined raw rows are redacted too.
- Hub responses are validated, redirects are refused, and response bodies are capped for hub, provider and daemon clients.
- The hub throttles failed authentication per client address (`MEMHIVE_TRUST_PROXY=1` behind a proxy).
- The hub's first admin key goes to a 0600 file, not the logs; the hub listens on loopback by default.
- `.memhive.json` can only narrow a repo's own project key, so a cloned repo cannot point the agent at another project's memory; MCP `search` reads other projects only from `mcp.allowProjects`.
- `docker/.env` and other nested env files stay out of the Docker build context.

## [0.1.2] - 2026-11-08

### Changed

- README rewritten, with a daily npm downloads chart.

## [0.1.1] - 2026-11-08

### Fixed

- The `bin` entry uses the path form npm normalizes to (`dist/memhive.cjs`, no leading `./`).

### Changed

- Releases are published from GitHub Actions through npm Trusted Publishing, with provenance.
- `package.json` links the repository, homepage and issue tracker.

## 0.1.0 - 2026-11-08

Initial release.

- Hooks for Claude Code and Codex, a local daemon, and an LLM observer that turns tool use into typed observations.
- Context block injected at session start, within a token budget.
- Hybrid search (SQLite FTS plus optional vectors) from the CLI and through MCP tools.
- Anthropic and OpenAI-compatible providers for the observer and embeddings.
- `<private>` stripping and secret redaction before anything is stored.
- Self-hosted team hub (Postgres + pgvector) with per-user API keys, push/pull sync and hub reset detection.

[Unreleased]: https://github.com/trickstarcandina/memhive/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/trickstarcandina/memhive/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/trickstarcandina/memhive/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/trickstarcandina/memhive/releases/tag/v0.1.1
