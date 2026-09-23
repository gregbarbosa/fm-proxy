# Clients

## Running Pi against fm-proxy

Pi works against the on-device model for chat. It cannot use tools, because it sends
`tool_choice: "auto"`, and auto is the mode that stays broken. A client that can force a
tool does get real `tool_calls`; see "Forced tool calling works, through a schema" in `docs/upstream-behaviour.md`. What
stops Pi in practice is project context, not the harness.

Use `pi-minimal`, an alias for `pi -ne -ns -np --no-themes`, and select the `FM`
provider's `system` model. In a directory with no context file it assembles to about
1188 tokens of the 4096-token window and returns HTTP 200. The lean toolset is only
about 499 of those.

The window goes to your documents, not to Pi. The same command in a directory holding
this repo's old 40 KB `AGENTS.md` (replaced on 2026-09-22 by a 3 KB file) assembled to
about 9582 tokens and failed:

| Directory | Assembled | Result |
|---|---|---|
| empty | 1188 | HTTP 200 |
| plus the 40 KB `AGENTS.md` | 9582 | context exceeded |

A 40 KB context file is roughly 8.4k tokens, twice the whole window. Keep Pi out of
directories that hold a large `AGENTS.md` or `CLAUDE.md`.

Pi's own gauge counts only `messages[].content`, so it under-reports. It read `0.2%/4.1k`
for a request that really assembled to 9508. Do not trust it. Judge by whether the
request returns `context_length_exceeded`.

Pass an image with `@path`, as a separate argv entry:
`pi ... @/tmp/poster.png "What does this say?"`. Folding `@path` into the `-p` string
makes Pi read the whole string as a filename.
