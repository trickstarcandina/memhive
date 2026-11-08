# memhub

memhub gives coding agents long-term memory. It watches sessions in Claude Code and Codex, distills what happened into short observations (decisions, bugfixes, config changes, and so on), and feeds the relevant ones back into the next session. Memory stays on your machine by default and can be shared through a team hub later.

## Install

```sh
npm install -g memhub && memhub install
```

`memhub install` asks which hosts to wire up (Claude Code, Codex) and which observer provider to use. Flags: `--host claude-code,codex`, `--provider anthropic|openai-compat`, `--yes` to skip prompts.

## How it works

- **Hooks.** Claude Code and Codex call `memhub hook <host> <event>` on session start, each prompt, each tool use, stop and session end. Hook commands always exit 0, so they never block the agent.
- **Daemon.** The first hook starts a local daemon (`memhub daemon status|start|stop|run`). It owns the SQLite database (`~/.memhub/memhub.db`) and a per-session event buffer.
- **Observer.** Buffered events are flushed to the LLM after 8 events, after 5 s of idle, or on stop. The LLM turns them into typed observations. A failed LLM call drops its batch; nothing is retried or replayed.
- **Context.** At session start the daemon builds a context block from recent and relevant observations, capped by `MEMHUB_CONTEXT_TOKENS`, and injects it into the agent.
- **MCP.** `memhub mcp` exposes the memory to the agent in three steps: `search` finds matching observations, `timeline` shows what happened around one, and `get_observations` fetches full records. `save_memory` stores an explicit note.

Observation types: `decision`, `bugfix`, `feature`, `refactor`, `discovery`, `config`, `problem`, `workaround`.

Ids are UUID v7. Anywhere an id is accepted you can pass a unique prefix or the short id, which is the last 8 characters of the id, as shown in CLI output.

## Commands

| Command | Purpose |
| --- | --- |
| `memhub install` / `memhub uninstall` | Wire memhub into Claude Code and Codex, or remove it. Your memory is kept. |
| `memhub search <query> [--type t] [--user u] [--since 7d] [--limit n]` | Search observations from the terminal. |
| `memhub embed [--missing\|--rebuild]` | Compute embeddings for observations. `--rebuild` after changing `MEMHUB_EMBED_DIMS`. |
| `memhub doctor` | Check settings, provider and embedder credentials, and daemon health. Reports whether each key is set; it never prints keys. |
| `memhub daemon run\|start\|stop\|status` | Control the background daemon. |
| `memhub hook <claude-code\|codex> <event>` | Hook entry point; called by the host, not by you. |
| `memhub mcp` | MCP server over stdio; called by the host. |
| `memhub version` | Print the version. |

## Configuration

Settings live in `~/.memhub/settings.json` (mode 0600). Environment variables override the file and use the same names as the settings keys shown here.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMHUB_HOME` | `~/.memhub` | Data directory (database, settings, daemon info, logs). |
| `MEMHUB_LLM_PROVIDER` | `anthropic` | Observer provider: `anthropic` or `openai-compat`. |
| `MEMHUB_ANTHROPIC_API_KEY` | none | Anthropic API key (provider `anthropic`). Required there. |
| `MEMHUB_ANTHROPIC_MODEL` | `claude-haiku-5-5` | Anthropic model alias. |
| `MEMHUB_LLM_BASE_URL` | none | OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1`. Required for `openai-compat`. |
| `MEMHUB_LLM_API_KEY` | none | Key for the OpenAI-compatible endpoint, if it needs one. |
| `MEMHUB_LLM_MODEL` | `claude-haiku-5-5` | Model name for the OpenAI-compatible endpoint. Set it: the default is an Anthropic model. |
| `MEMHUB_EMBED_BASE_URL` | none | OpenAI-compatible embeddings endpoint (Ollama, OpenAI, OpenRouter, ...). |
| `MEMHUB_EMBED_API_KEY` | none | Key for the embeddings endpoint, if needed. |
| `MEMHUB_EMBED_MODEL` | none | Embedding model name. |
| `MEMHUB_EMBED_DIMS` | unset | Vector size. Setting it enables vector search; unset means FTS-only search. |
| `MEMHUB_CONTEXT_TOKENS` | `2000` | Token budget for the injected context block (about 4 characters per token). |
| `MEMHUB_DEBUG` | unset | Set to `1` or `true` for debug lines in the logs. |

## Privacy

- **`<private>...</private>` is stripped first.** Anything inside these tags is removed from prompts and tool payloads before it is buffered. Nested blocks are handled, and an unclosed tag drops the rest of the text.
- **Secrets are redacted before anything is stored.** Keys and tokens in the usual formats (for example `sk-`, `ghp_`, `AKIA`, `Bearer`, and `password=`/`token=` assignments) are replaced with `<redacted>` in tool payloads, in generated observations and in `save_memory` notes.
- **Images are never stored.** Base64 image data and image content blocks are replaced with a placeholder.
- **Tool events are not written to disk.** Tool inputs and outputs live only in the daemon's memory buffer, capped at 128 events per session and 16 000 characters per field. Only the observations derived from them are saved.
- **Everything stays local** in the default setup. The only outbound calls are to the LLM and embedding endpoints you configure.

## Team hub

Coming in the hub release: `memhub login` and `memhub link` will share observations with a team server. Nothing is uploaded in v0.1.

## Troubleshooting

- Run `memhub doctor` first. It checks settings, credentials and daemon health.
- Logs are in `~/.memhub/logs/` (`hook.log`, `daemon.log`, and others). Set `MEMHUB_DEBUG=1` for more detail.
- If session context is missing, check that `memhub daemon status` reports the daemon running. Hooks start it automatically on the next session.

## License

MIT
