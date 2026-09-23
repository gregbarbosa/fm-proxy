# Clients

## Running Pi against fm-proxy

### Set `contextWindow` to 8192, not 4096

Caution: with `"contextWindow": 4096` for the `system` model, every reply stops after one to
four tokens, and Pi shows "Response was truncated before completion".

Pi keeps a fixed 4096-token safety margin when it computes the output budget
(`CONTEXT_SAFETY_TOKENS` in `pi-ai/dist/api/simple-options.js`):

```
max_completion_tokens = min(maxTokens, max(1, contextWindow - input - 4096))
```

For a 4096-token window that is always 1. No Pi setting changes the margin. Declare the
window as the real window plus the margin in `~/.pi/agent/models.json`:

```json
{ "id": "system", "contextWindow": 8192, "maxTokens": 4096 }
```

Pi then sends `4096 - input` tokens of output budget. Measured on 2026-09-23: 3678 with no
context file and no tools, and 1820 in this repository with tools. `fm serve` still
enforces the real 4096-token window, and an overflow returns `context_length_exceeded`.
Pi's gauge then reads against 8.2k, so read it as twice the real fraction.


Pi works against the on-device model for chat. It cannot use tools, because it sends
`tool_choice: "auto"`, and auto is the mode that stays broken. A client that can force a
tool does get real `tool_calls`; see "Forced tool calling works, through a schema" in `docs/upstream-behaviour.md`. What
stops Pi in practice is project context, not the harness.

Run `pi -ne -ns -np --no-themes`, and select the `FM`
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
