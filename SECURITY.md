# Security policy

## Supported versions

memhive is pre-1.0. Fixes go into the latest release only.

| Version | Supported |
| --- | --- |
| Latest 0.x release | Yes |
| Older releases | No, upgrade first |

## Reporting a vulnerability

Report it privately through
[GitHub security advisories](https://github.com/trickstarcandina/memhive/security/advisories/new)
("Report a vulnerability" on the repo's Security tab). Do not open a public issue.

Include the version (`memhive version`), your OS and Node version, and steps to reproduce.
Leave out real API keys and private memory contents.

You get a first response within 7 days. Once a fix is released, the advisory is published with credit,
unless you ask to stay anonymous.

## Scope

In scope: the `memhive` npm package (CLI, hooks, local daemon, MCP server, observer) and the hub
(`memhive serve`, the Docker image built from `docker/`).

Things that are by design, and how they are meant to be deployed:

- **Local daemon.** It listens on `127.0.0.1` only and requires a random token from `~/.memhive/daemon.json`
  (mode 0600). Anything running as your user can read that file; memhive does not defend against
  other processes of the same user.
- **Hub.** It speaks plain HTTP and must sit behind a TLS reverse proxy. Clients refuse `http://` hubs
  other than loopback. Exposing the hub's plain HTTP port to a network is a deployment error, not a
  vulnerability.
- **Hub members.** Every key on a hub can read every linked project on that hub. Per-project access
  control does not exist yet.
- **LLM provider.** Tool inputs and outputs (truncated, with `<private>` blocks and recognized secrets
  removed) are sent to the provider you configure. Redaction is best effort: a secret in an unusual
  format can reach the provider.

Reports that a redaction pattern misses a common secret format are welcome.
