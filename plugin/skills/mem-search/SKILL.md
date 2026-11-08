---
name: mem-search
description: Search memhub's memory of past sessions in three steps — search, timeline, get_observations. Use when the user asks "did we already do X?", "how did we solve this before?", or when starting work that may have history.
---

# Searching past work

Memory is layered so you spend tokens only on what you open.

1. `search(query, type?, user?, since?, limit?)` — returns an index: id, time, type, title, user, estimated tokens. Read it and pick 1–5 relevant ids.
2. `timeline(anchor_id, before?, after?)` — shows what happened around one id in the same session. Use it when an index row needs context.
3. `get_observations(ids)` — full details, batched. Only for ids you selected.

Ids are 8-character prefixes like `#01933f2a`; pass them without the `#`.

Use `save_memory(text, title?, type?)` to record a decision, a gotcha or a convention for future sessions.

Types: decision, bugfix, feature, refactor, discovery, config, problem, workaround. Filter with `type` when the question is about one of these.
