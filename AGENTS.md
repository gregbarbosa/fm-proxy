# AGENTS.md

> **Licence.** Apple's `fm` licence forbids programmatic access to Apple models "except
> as expressly permitted". `fm-proxy` does exactly that, so it conflicts with the terms
> that its user accepts. Keep it to local research. Do not remove the warning from the
> README.

`fm-proxy` puts an OpenAI-compatible API in front of Apple's `fm serve` and corrects the
places where `fm serve` departs from the OpenAI API. It supports macOS 27.2 and
later. It has no dependencies.

## Commands

| Task | Command |
|---|---|
| Unit and integration tests | `npm test` |
| Start `fm serve` and the proxy | `./fm-launch.sh` |
| Prove that a refactor changed nothing on the wire | `FM_BIN=/nonexistent node tools/wire-baseline.js /tmp/after.json`, then diff against a run on the old revision |
| Check a running proxy against every known deviation | `node tools/deviation-probe.js 1977` |
| Regenerate the `fm` CLI reference | `python3 tools/gen-fm-docs.py` |

`tools/TEST_PLAN.md` explains the three test layers and how to read a failure.

## Code map

| File | Job |
|---|---|
| `fm-proxy.js` | Entry point. Starts the server. |
| `src/config.js` | Every environment setting, read once. |
| `src/request.js` | Rewrites the client's request and builds the upstream request. |
| `src/schema.js` | Rewrites tool and `response_format` schemas into what `fm serve` accepts. |
| `src/dispatch.js` | Translates a forced `tool_choice` into structured output, and back. |
| `src/errors.js` | Types `fm serve`'s errors and decides which ones to retry. |
| `src/server.js` | HTTP server, retry plan, and attempt gate. |
| `src/relay-stream.js` | Relays a streaming completion. |
| `src/relay-json.js` | Relays a non-streaming completion. |
| `src/text.js` | `stop` sequences. |
| `src/tokens.js` | Token counts for the one case where `fm serve` sends no usage. |
| `src/http.js` | CORS headers, response heads, and logging. |

## Rules

- Keep the proxy free of dependencies.
- Give every correction a test. If it changes what goes upstream, add a case to
  `tools/wire-baseline.js` too.
- `rewriteRequest` returns the values that the relays need, such as `stop`. Do not put
  them back on the parsed body: anything on it goes upstream.
- Use a function replacement in `String.replace` when the replacement holds model text.
  A string replacement expands `$&` and `$n`.
- Token counting forks `fm` and blocks the event loop. Call it only when `fm serve`
  sends no usage.
- Never hand-edit `docs/fm-reference.md`. Regenerate it from the installed binary.

## Where facts live

| File | Content |
|---|---|
| `README.md` | What a user needs: install, start, connect, options, corrections, limits |
| `docs/upstream-behaviour.md` | What `fm serve` does on the current build, and why the proxy does what it does |
| `docs/audit.md` | The audit steps after an OS update, the build fingerprints, and the release history |
| `docs/clients.md` | Notes for specific clients, such as Pi |
| `docs/fm-internals-and-resources.md` | The on-device model family, asset paths, and external resources |
| `docs/fm-reference.md` | The generated `fm` CLI reference for the current build |

Record a new upstream fact in one of these files only.
