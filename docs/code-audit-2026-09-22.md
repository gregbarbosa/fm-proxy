# Code audit, 2026-09-22

This audit examines `fm-proxy` before an open-source release. It was made on branch
`refactor/oss-quality` from `main` at `47a5032`, on macOS 27.2 Beta 2 (`26B5091g`).

## Bugs

Each bug was reproduced against a stub upstream or a live machine.

| # | Bug | Evidence | Fix |
|---|---|---|---|
| B1 | The proxy listens on every interface, not on loopback. With CORS `*`, an ignored API key, and the stripped `Origin` headers, any host on the LAN can use the model. | `lsof` shows `TCP *:1977 (LISTEN)`. `fm-proxy.js:1318` calls `listen(PROXY_PORT)` with no host. The docs say "loopback-only". | Bind to `127.0.0.1`. Add `PROXY_HOST` to change it. Add a test. |
| B2 | A terminal `503` is retried. `pcc` outside Terminal.app answers `503 ... not available in this context`. That text matches no branch in `classifyError`, so it gets the retryable default. | 5 upstream requests and 15 s before the client sees the error, on both paths. | Match the phrase and return `retry: false`, `code: "model_unavailable"`. Keep a bare `503` retryable. |
| B3 | A forced tool call with `stream: true` loses an upstream error. `emitSynthesisedStream` reads only `choices[0]`, so it sends a clean `finish_reason: "stop"` under the error status. It also reports `model: "system"` for every model. | A stub `400` produced a `400` event stream with a role frame, a `stop` frame, and no error text. | Send `errorFrame` when the buffered reply is an error. Carry the request's model. |

## Stale statements

The code and the docs say things that were true on an earlier build.

| Place | Statement | Now |
|---|---|---|
| `README.md:35-67`, `:130-131`, `:165-167` | Tested on `26B5086k`. PCC is "not ready" and fails with `systemNotReady`. | 27.2 Beta 2 fixed PCC. It works from Terminal.app, direct and through the proxy. |
| `README.md:119-121`, `fm-proxy.js:350-353`, `:1250-1258` | A cyclic `$defs` hangs `fm serve`, and a restart clears it. | On 27.2 Beta 2 the hang is below `fm serve`. A restart does not clear it. It clears after about 2 minutes. |
| `README.md:244` | An unknown model name, "`pcc`, for example", fails in about 2 ms. | `pcc` is a real model again. |
| `README.md:79-94`, `fm-proxy.js:18-19` | "Most replies" leak markers. | On 27.2 Beta 2, 1 of 20 replies had markers and 10 of 20 had bare `{"tool_call": ...}` JSON. |
| `fm-proxy.js:498-500` | `reasoning_effort` is dropped because `pcc` is gone. | `pcc` is back and accepts it. The proxy still drops it. Measure whether `pcc` uses it before you change the behaviour. |
| `fm-proxy.js:1321` | The start banner says "flat format". | Nested schemas pass through since Beta 3. |
| `fm-launch.sh` header | Beta 7 removed PCC, so Terminal.app does not matter. | It matters again for `pcc`. |
| `tools/TEST_PLAN.md` layer 3 | Run `tools/harness-check.sh`. | That file is in `.gitignore`. A public user does not have it. |

## Slop in the code

| Place | Problem | Kind |
|---|---|---|
| `fm-proxy.js:256` | A comment for a function that Beta 7 deleted. | Dead comment |
| `fm-proxy.js:388-390` | The comment for `fixResponseFormatSchema` sits above a different function. `fixResponseFormatSchema` has no comment. | Misplaced comment |
| `fm-proxy.js:554-561` | Two paragraphs state the same rule. | Duplicate comment |
| `fm-proxy.js:40-41`, `:848-852` | Two copies of the code that normalizes a `stop` list. | Duplication |
| `fm-proxy.js:484-566`, `:731-804` | `fixTools` does much more than fix tools. `prepareUpstreamRequest` serializes the body up to four times and returns 13 fields. | Structure |
| `fm-proxy.js:659-669` | `classifyErrorPayload` and `retryOrSurface` are one-line wrappers. | Indirection |
| `fm-proxy.js:95-97` | A 512-entry token cache and a `TOKEN_SUBCOMMAND` constant for a path that now runs only on a guardrail abort. | Surplus machinery |
| `fm-proxy.js:672-674` | `module.exports` sits in the middle of the file and exports a private helper. | Structure |
| `fm-proxy.js:1150-1223` | The body of `relayNonStreamingChat` has no indentation. | Formatting |
| `fm-proxy.js:1094` | `emitSynthesisedStream` has an unused `upstreamHeaders` parameter. | Dead code |
| `fm-proxy.js` | 373 of 1323 lines are comments. Many comments record how a bug was found, not what the code does. That history belongs in git and in the docs. | Comment volume |
| `fm-proxy.test.js` | One 2368-line file. Section names carry build history ("Beta 7 hang guard", "Beta 3 follow-up") and not behaviour. | Test structure |
| `tools/usage-tap.js` | Tracked, but no document names it. | Orphan file |

## Documentation layout

- The README and AGENTS.md state the same facts twice: the marker leak, the forced
  dispatch, the error types, and the cyclic hang. Each fact must have one home.
- AGENTS.md is 43 KB. Most of it is an audit notebook: fingerprint tables, release
  history, and model-catalog research. An agent loads the whole file, and it overflows the
  4096-token window of the model that this project serves.
- Proposed layout:

| File | Reader | Content |
|---|---|---|
| `README.md` | A user | What it does, the licence warning, install, start, connect, options, what it corrects, limits |
| `AGENTS.md` | An agent that edits the code | Build and test commands, code map, rules. Short. |
| `docs/upstream-behaviour.md` | A maintainer | What `fm serve` does on the current build |
| `docs/audit-recipe.md` | A maintainer | The audit steps and the fingerprint table |
| `docs/release-history.md` | A maintainer | The per-build history |

## Open-source packaging

These items are missing. Each one is a decision for the owner.

| Item | Cost |
|---|---|
| `package.json` with `engines`, `scripts.test`, and a `bin` entry for `npx fm-proxy` | Small. `npx` use also makes a later npm release possible. |
| A GitHub Actions workflow that runs the unit tests on Linux | Small. The unit tests do not need `fm`, because they skip the live cases. |
| `CHANGELOG.md` | Small. The tags start at `v1.3.0`. |
| Split `fm-proxy.js` into modules: schema, errors, relays, server | Medium. The size stays about the same, but each part can be read alone. |
| `.claude/` in `.gitignore` | Trivial |

## Plan

1. Take a wire baseline with `FM_BIN=/nonexistent`.
2. Fix B1, B2, and B3. Each fix gets a test and its own commit. Each fix changes behaviour,
   so record the baseline diff in the commit.
3. Take a new baseline.
4. Remove the slop. Each cut must give an empty baseline diff. Mark each cut
   structural or cheap.
5. Correct the stale statements, and apply the documentation layout.
6. Apply the packaging items that the owner accepts.

## Outcome

Done on branch `refactor/oss-quality`, 2026-09-22.

| Item | Commit |
|---|---|
| B1, B2, B3 fixed, with tests | `a768a3f` |
| `fm-proxy.js` split into `src/`; slop removed; a lost `stop` cut in the stream relay fixed | `d57ee30` |
| Tests split into `test/`; `package.json`; CI on Node 18, 20 and 22 | `2c3407e` |
| Documentation layout applied; stale statements corrected; a missing chunked-upload test added | `80d32bf` |
| A provider's wrapped 4xx is no longer retried (found in the live check) | `60840d3` |

The code went from 1323 lines to about 1150, in 12 files. Comment lines went from 373 to
about 170. Most of the line reduction is comments, which is the cheap kind. The
structural changes are the module split, one serialisation per request, one `stop`
normaliser, the removed wrappers and token cache, and the five bug fixes.

The proposed `docs/audit-recipe.md` and `docs/release-history.md` became one file,
`docs/audit.md`. `CHANGELOG.md` was not added.

The wire baseline changed in one place only: the cyclic-schema error text. `npm test`
passes 155 of 155. Against a live `fm serve` on `26B5091g`, the deviation probe handled 11
of 11, and `pcc`, forced dispatch on `pcc`, and a streamed `stop` all worked.
