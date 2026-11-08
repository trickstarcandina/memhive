# memhive

memhive gives coding agents long-term memory. It watches sessions in Claude Code and Codex, distills what happened into short observations (decisions, bugfixes, config changes, and so on), and feeds the relevant ones back into the next session. Memory stays on your machine by default and can be shared through a team hub later.

## Install

```sh
npm install -g memhive && memhive install
```

`memhive install` asks which hosts to wire up (Claude Code, Codex) and which observer provider to use. Flags: `--host claude-code,codex`, `--provider anthropic|openai-compat`, `--yes` to skip prompts.

## How it works

- **Hooks.** Claude Code and Codex call `memhive hook <host> <event>` on session start, each prompt, each tool use, stop and session end. Hook commands always exit 0, so they never block the agent.
- **Daemon.** The first hook starts a local daemon (`memhive daemon status|start|stop|run`). It owns the SQLite database (`~/.memhive/memhive.db`) and a per-session event buffer.
- **Observer.** Buffered events are flushed to the LLM after 8 events, after 5 s of idle, or on stop. The LLM turns them into typed observations. A failed LLM call drops its batch; nothing is retried or replayed.
- **Context.** At session start the daemon builds a context block from recent and relevant observations, capped by `MEMHIVE_CONTEXT_TOKENS`, and injects it into the agent.
- **MCP.** `memhive mcp` exposes the memory to the agent in three steps: `search` finds matching observations, `timeline` shows what happened around one, and `get_observations` fetches full records. `save_memory` stores an explicit note.

Observation types: `decision`, `bugfix`, `feature`, `refactor`, `discovery`, `config`, `problem`, `workaround`.

Ids are UUID v7. Anywhere an id is accepted you can pass a unique prefix or the short id, which is the last 8 characters of the id, as shown in CLI output.

## Commands

| Command | Purpose |
| --- | --- |
| `memhive install` / `memhive uninstall` | Wire memhive into Claude Code and Codex, or remove it. Your memory is kept. |
| `memhive search <query> [--type t] [--user u] [--since 7d] [--limit n]` | Search observations from the terminal. |
| `memhive embed [--missing\|--rebuild]` | Compute embeddings for observations. `--rebuild` after changing `MEMHIVE_EMBED_DIMS`. |
| `memhive doctor` | Check settings, provider and embedder credentials, and daemon health. Reports whether each key is set; it never prints keys. |
| `memhive daemon run\|start\|stop\|status` | Control the background daemon. |
| `memhive hook <claude-code\|codex> <event>` | Hook entry point; called by the host, not by you. |
| `memhive mcp` | MCP server over stdio; called by the host. |
| `memhive version` | Print the version. |

## Configuration

Settings live in `~/.memhive/settings.json` (mode 0600). Environment variables override the file and use the same names as the settings keys shown here.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMHIVE_HOME` | `~/.memhive` | Data directory (database, settings, daemon info, logs). |
| `MEMHIVE_LLM_PROVIDER` | `anthropic` | Observer provider: `anthropic` or `openai-compat`. |
| `MEMHIVE_ANTHROPIC_API_KEY` | none | Anthropic API key (provider `anthropic`). Required there. |
| `MEMHIVE_ANTHROPIC_MODEL` | `claude-haiku-5-5` | Anthropic model alias. |
| `MEMHIVE_LLM_BASE_URL` | none | OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1`. Required for `openai-compat`. |
| `MEMHIVE_LLM_API_KEY` | none | Key for the OpenAI-compatible endpoint, if it needs one. |
| `MEMHIVE_LLM_MODEL` | `claude-haiku-5-5` | Model name for the OpenAI-compatible endpoint. Set it: the default is an Anthropic model. |
| `MEMHIVE_EMBED_BASE_URL` | none | OpenAI-compatible embeddings endpoint (Ollama, OpenAI, OpenRouter, ...). |
| `MEMHIVE_EMBED_API_KEY` | none | Key for the embeddings endpoint, if needed. |
| `MEMHIVE_EMBED_MODEL` | none | Embedding model name. |
| `MEMHIVE_EMBED_DIMS` | unset | Vector size. Setting it enables vector search; unset means FTS-only search. |
| `MEMHIVE_CONTEXT_TOKENS` | `2000` | Token budget for the injected context block (about 4 characters per token). |
| `MEMHIVE_DEBUG` | unset | Set to `1` or `true` for debug lines in the logs. |

## Privacy

- **`<private>...</private>` is stripped first.** Anything inside these tags is removed from prompts and tool payloads before it is buffered. Nested blocks are handled, and an unclosed tag drops the rest of the text.
- **Secrets are redacted before anything is stored.** Keys and tokens in the usual formats (for example `sk-`, `ghp_`, `AKIA`, `Bearer`, and `password=`/`token=` assignments) are replaced with `<redacted>` in tool payloads, in generated observations and in `save_memory` notes.
- **Images are never stored.** Base64 image data and image content blocks are replaced with a placeholder.
- **Tool events are not written to disk.** Tool inputs and outputs live only in the daemon's memory buffer, capped at 128 events per session and 16 000 characters per field. Only the observations derived from them are saved.
- **Everything stays local** in the default setup. The only outbound calls are to the LLM and embedding endpoints you configure.

## Team hub

A hub shares the observations, summaries and session records of linked projects across a team. Personal memory stays local unless a project is linked.

### Run the hub

The hub is a Node service backed by Postgres with pgvector. The compose stack in `docker/` runs both.

```sh
cd docker
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env   # once; never commit .env
docker compose up -d
docker compose logs hub
```

On first start the hub creates user `admin` and prints its API key once. The line is in `docker compose logs hub`. Store it somewhere safe; it cannot be shown again.

The hub speaks plain HTTP on port 7777. Put it behind a TLS reverse proxy (Caddy, nginx, a cloud load balancer) that serves `https://hub.example.com` and forwards to the hub. Clients refuse any `http://` hub except `localhost`, `127.0.0.1` and `::1`. Compose publishes the hub on `127.0.0.1:7777` only, so the plain HTTP port is not reachable from the network. The proxy must run on the same host. If it runs elsewhere, change the port mapping in `docker/compose.yml` to a reachable address, and keep the hub behind TLS.

Hub settings are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | `postgres://…` or `sqlite:<path>`. Compose sets the Postgres URL. |
| `PORT` | `7777` | Listen port. |
| `MEMHIVE_EMBED_MODEL` | none | Embedding model the hub expects. Compose sets `bge-m3`. |
| `MEMHIVE_EMBED_DIMS` | unset | Vector size the hub expects. Compose sets `1024`. |
| `MEMHIVE_HUB_BODY_LIMIT` | `2097152` (2 MB) | Maximum request body, in bytes. |
| `MEMHIVE_HOME` | `~/.memhive` | Directory for hub logs. Compose sets `/data`. |

`POSTGRES_PASSWORD` is required: compose refuses to start without it. Compose reads it from `docker/.env` and passes it to the hub as `PGPASSWORD`, outside the connection URL, so any characters work.

The hub limits each key to 60 requests per minute.

### Add members

Create one key per person or machine. Run these from `docker/`:

```sh
docker compose exec hub node dist/memhive.cjs key create --user alice --label laptop
docker compose exec hub node dist/memhive.cjs key list
docker compose exec hub node dist/memhive.cjs key revoke <id>
```

The new key is printed once and starts with `mh_`. Give it to its owner through a private channel. `key revoke` takes the id shown by `key list`.

### Connect a machine

On each machine, log in once. The command asks for the key without echoing it:

```sh
memhive login https://hub.example.com
```

To script it, pipe the key on stdin. Never pass the key as a command-line argument, because arguments show up in shell history and process listings:

```sh
printf '%s' "$MEMHIVE_KEY" | memhive login https://hub.example.com --key-stdin
```

Then, inside each project you want to share:

```sh
memhive link https://hub.example.com
```

`link` runs an initial pull. `memhive sync` pushes and pulls the current project now. `memhive unlink` stops syncing the current project; its local memory stays.

### What syncs

Observations, summaries and session records of linked projects are pushed to the hub. Prompts and raw tool output never leave the machine, and `<private>` blocks and redacted secrets are removed before anything is stored.

### Embedding model must match

Clients that embed must use the same embedding model and vector size as the hub. Set `MEMHIVE_EMBED_MODEL` and `MEMHIVE_EMBED_DIMS` on the hub to the `embed` model and dims in each client's `~/.memhive/settings.json`. The hub rejects a pushed row whose embedding model differs from its own, or whose vector length differs from `MEMHIVE_EMBED_DIMS`, with `422 embedding_model_mismatch`. Rows without a vector are accepted. `memhive login` warns when the local settings differ from the hub's.

Hub-side search is full-text only, because the hub runs no embedder. Client search stays hybrid over local rows, including rows pulled from the hub.

## Troubleshooting

- Run `memhive doctor` first. It checks settings, credentials and daemon health.
- Logs are in `~/.memhive/logs/` (`hook.log`, `daemon.log`, and others). Set `MEMHIVE_DEBUG=1` for more detail.
- If session context is missing, check that `memhive daemon status` reports the daemon running. Hooks start it automatically on the next session.

## License

MIT
