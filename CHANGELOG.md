# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break settings or the hub protocol).

After upgrading, re-run `memhive install`.

## [Unreleased]

### Changed

- `memhive sync` prints the push or pull error and exits 1 when the sync call failed (it used to exit 0).

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

[Unreleased]: https://github.com/trickstarcandina/memhive/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/trickstarcandina/memhive/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/trickstarcandina/memhive/releases/tag/v0.1.1
