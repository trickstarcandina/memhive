# Contributing to memhive

Bug reports, fixes and new host adapters are welcome. For anything bigger than a bugfix, open an
issue first so the design can be agreed before you write the code.

## Setup

Node.js 22 or newer.

```sh
git clone https://github.com/trickstarcandina/memhive.git
cd memhive
npm ci
npm run typecheck
npm run build      # bundles dist/memhive.cjs
npm test
```

`npm run pack:check` lists what `npm pack` would publish and fails on a missing or unexpected file.

Never point a development build at your real `~/.memhive`, `~/.claude` or `~/.codex`. The tests use
temporary directories through `MEMHIVE_HOME`, `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; do the same
when you try a build by hand.

## Postgres tests

Without `TEST_DATABASE_URL`, the hub runs its tests against its SQLite store and the Postgres suites
are skipped. To run them, start a pgvector database whose name contains `test`:

```sh
docker run -d --name memhive-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=memhive_test \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/memhive_test PGPASSWORD=test npm test
```

The suites drop the database's `public` schema, which is why its name must contain `test`.
To try the full hub stack instead, see `docker/compose.yml` and the README's Team hub section.

## Pull requests

- Every behavior change comes with a test. Write the failing test first.
- `npm run typecheck`, `npm run build` and `npm test` must pass. CI runs them on Linux, macOS and
  Windows with Node 22 and 24, plus the Postgres suites.
- Comments explain why, not what.
- No new runtime dependency without a reason in the PR description; every client installs them.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `test:`,
`docs:`, `ci:`, `build:`, `chore:`, with an optional scope (`fix(sync): ...`). The subject says what
changes for the user, in the imperative, without a trailing period.

## Releases

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`). It is the only
   place the version is written; the build inlines it.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date.
3. Commit as `chore: release <x.y.z>` and push to `main`.
4. Draft a GitHub release with tag `v<x.y.z>` and publish it. The `publish` workflow checks that the
   tag matches `package.json`, runs the tests, packs the tarball once, and publishes that tarball to
   npmjs (with provenance) and to GitHub Packages.
