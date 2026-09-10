> **License, as of Beta 5.** `sudo fm license` must be accepted before any `fm`
> subcommand runs. Its terms include "agreeing to NOT programmatically access or use
> Apple models through Apple software or services except as expressly permitted".
> `fm-proxy` does exactly that, so this project conflicts with the terms it accepts.
> Keep it to local research. The README carries the full warning — do not remove it.

## Project direction

**`fm-proxy.js`** sits in front of Apple's `fm serve` and speaks the OpenAI Chat
Completions dialect, so an ordinary OpenAI client works against the on-device model
without code changes. It supports **Beta 7 and later, including the 27.0 RC**; code for
earlier betas is removed.

An earlier in-process Swift `fms` app was explored and dropped: it could not run
inference on Private Cloud Compute, which needed the Apple-private entitlement
`com.apple.modelmanager.inference`. That question is now moot — Beta 7 removes PCC from
the `fm` binary altogether.

## `fm` CLI reference

Generate the full `fm` command tree before you work on the CLI surface:

```bash
python3 tools/gen-fm-docs.py
```

That writes `docs/fm-reference.md`, a per-command option table that greps well and reads
well as agent context. It runs `fm --experimental-dump-help` once, rather than scraping
`--help` recursively.

**The file is committed on purpose.** It is generated, so committing it is unusual, but
it is the only record of Apple's CLI surface per build. The committed copy is the "before"
side of the structure diff in the audit recipe below, and its history is how a change like
Beta 7's PCC removal stays visible. Read it for the build it was generated from, which
the release-history table names.

Regenerate it after any `fm` update and commit the result. Never hand-edit it: the source
of truth is the installed binary.

Some tools are local-only and are not in the repo: `tools/harness-check.sh` drives `pi`,
and `tools/ask-image.sh` is a manual probe.

### Fingerprinting the `fm` version (no `--version` flag)

`fm --version` does **not** exist (errors "Unknown option"). To detect when Apple ships a
new `fm`/FoundationModels build across macOS betas, fingerprint the binary:

| What | How | Beta 2 value | Beta 3 value | Beta 4 value | Beta 5 value | Beta 6 value | Beta 7 value | Beta 8 value | 27.0 RC |
|---|---|---|---|---|---|---|---|---|---|
| fm source version | `otool -l /usr/bin/fm \| grep -A2 LC_SOURCE_VERSION` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` | `2.0.68.1.402` |
| Framework version | `plutil -p /System/Library/Frameworks/FoundationModels.framework/Resources/Info.plist \| grep CFBundleVersion` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` | `2.0.68.1.402` |
| Runtime version | `codesign -dvvv /usr/bin/fm` → `Runtime Version=` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` |
| Rebuild date | `ls -la /usr/bin/fm` (mtime) | Jun 19 2026 | Jul 3 2026 | Jul 17 2026 | Aug 7 2026 | Aug 14 2026 | Aug 21 2026 | Aug 27 2026 | Sep 3 2026 |
| macOS build | `sw_vers` → `BuildVersion` | `26A5368g` (27.0 Beta 2) | `26A5378j` (27.0 Beta 3) | `26A5388g` (27.0 Beta 4) | `26A5406e` (27.0 Beta 5) | `26A5416b` (27.0 Beta 6) | `26A5421a` (27.0 Beta 7) | `26A5425a` (27.0 Beta 8) | `26A428` (27.0 RC) |

Audit recipe after any OS update:

1. **Structure** — regenerate the CLI tree and diff it against the committed copy:

   ```bash
   python3 tools/gen-fm-docs.py --outdir /tmp/fmnew
   diff docs/fm-reference.md /tmp/fmnew/fm-reference.md
   ```

   The tree is a compile-time dump, so a diff here is authoritative: Beta 7's was all
   deletions, which is how PCC's removal was caught.

   Commit the regenerated file as part of the audit, whether or not it changed. An empty
   diff is a result, and the commit records which build the tree belongs to.
2. **Behaviour** — the help tree can stay identical while behaviour changes, and the
   reverse also happens, so re-test the known walls separately. Run the three test
   layers in `tools/TEST_PLAN.md`, then re-check by hand:
   - tool calling — still broken upstream (`tool_calls` never populated)
   - `$defs` in `response_format` — undecorated 400s; a **cyclic** one hangs `fm serve`
     permanently, so test it last and restart the server afterwards
   - forced `tool_choice` — 500 "unsupported generation guide"
   - a tool with no `function.description` — 400s the whole request
   - omitted `stream` — returns SSE, not JSON
   - `n > 1` — 400s
   - prompt framing — `hello world` should be 57 `prompt_tokens`
   - the 4096-token window — a ~4056-token prompt passes, ~8056 does not
   - tool-call content — check the reply text for `<start_of_turn>` and `<ctrl NN>`
     markers, and send at least 10 requests, because the leak is intermittent
3. **Licence** — run `fm license --status` and `fm license --show`. Both print without
   prompting. Compare the agreed version and the terms against the previous section.

Record the result as a new section, and fold the previous one into the release-history
table.

Warning: a cyclic `$defs` request hangs `fm serve` permanently. Run that test last, and
restart `fm serve` afterwards.

Caution: for the first hour after an OS update, do not trust a failure. The machine may
still be settling its model assets, and `com.apple.SensitiveContentAnalysisML error 15`
can appear and then clear itself. `fm available` does not detect that state.

## Running Pi against fm-proxy

Pi works against the on-device model for chat. It cannot use tools, because `fm serve`
never populates `tool_calls`. What stops it in practice is project context, not the
harness.

Use `pi-minimal`, an alias for `pi -ne -ns -np --no-themes`, and select the `FM`
provider's `system` model. In a directory with no context file it assembles to about
1188 tokens of the 4096-token window and returns HTTP 200. The lean toolset is only
about 499 of those.

The window goes to your documents, not to Pi. The same command in a directory holding
this repo's `AGENTS.md` assembles to about 9582 tokens and fails:

| Directory | Assembled | Result |
|---|---|---|
| empty | 1188 | HTTP 200 |
| plus `AGENTS.md` | 9582 | context exceeded |

A 40 KB context file is roughly 8.4k tokens, twice the whole window. Keep Pi out of
directories that hold a large `AGENTS.md` or `CLAUDE.md`.

Pi's own gauge counts only `messages[].content`, so it under-reports. It read `0.2%/4.1k`
for a request that really assembled to 9508. Do not trust it. Judge by whether the
request returns `context_length_exceeded`.

Pass an image with `@path`, as a separate argv entry:
`pi ... @/tmp/poster.png "What does this say?"`. Folding `@path` into the `-p` string
makes Pi read the whole string as a filename.

## OpenAI-compatible usage (plug-and-play base URL)

The proxy is a drop-in OpenAI endpoint — point any OpenAI client at it and go:

- **Base URL:** `http://127.0.0.1:1977/v1`
- **API key:** any non-empty dummy string (e.g. `sk-local`). It's loopback-only; the
  key is ignored, not validated, but most SDKs refuse to start without *some* key set.
- **Endpoints:** `POST /v1/chat/completions` (translated), `GET /v1/models` and
  `GET /health` (passed straight through to `fm serve`). `system` is the only model.
- **Streaming** (`stream: true`) and **non-streaming** both work; usage is repaired
  either way (see "Token usage repair").
- **Tools:** standard OpenAI `tools` / `tool_calls`. Rich/nested schemas are accepted —
  the proxy flattens them to fm serve's flat-only subset transparently (see above).
- **Vision:** supported via the standard `image_url` content part with a base64 data
  URL — `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`. The image must
  be a valid PNG/JPEG; degenerate or corrupt images are rejected upstream as
  "not an image" (the model answers from text only). Verified end-to-end: a solid-blue
  PNG returns "Blue". Image file paths and non-standard shapes (`input_image`, Anthropic
  `source`) are **not** supported — use the data-URL form.
- **CORS:** enabled (`Access-Control-Allow-Origin: *`, override with `CORS_ORIGIN`;
  `Allow-Headers: Authorization, *` so the OpenAI SDK's `x-stainless-*` headers clear
  preflight), so browser-based clients connect directly. The proxy also **strips**
  `Origin`, `Referer` and `Sec-Fetch-*` before the upstream hop: fm serve answers any
  request carrying them with `403 Cross-site requests are not allowed`, and a browser
  sets them automatically.
- **Errors:** returned as OpenAI-shaped objects — `{"error":{"message","type","code"}}`.
  The proxy **classifies** fm serve's distinct failure modes so clients can branch on
  `type`/`finish_reason` instead of string-matching Apple's prose:
  - **Safety-guardrail abort** → **`finish_reason:"content_filter"`** (NOT an error). The
    model emits valid output, then fm serve interrupts (`"The model's safety guardrails
    were triggered."`). OpenAI-idiomatic: the proxy keeps any partial text already
    streamed and ends the completion with `finish_reason:"content_filter"` — so SDK
    clients receive the partial + a documented finish_reason instead of an exception.
    Deterministic + terminal (retrying the identical request re-fails identically), so
    don't retry; change the request (rephrase or simplify — there is no second model).
    Benign code triggers it — it is **not** a judgment that your content is unsafe.
  - `type: "invalid_request_error"` (`code: "invalid_request"`) — any upstream HTTP 400,
    such as an unknown model name or `n > 1`. Terminal: fm serve rejects it in ~7 ms and
    a retry re-sends the same rejection, so the proxy surfaces it immediately.
  - `type: "invalid_request_error"` (`code: "context_length_exceeded"`) — the prompt is
    larger than the 4096-token window (`"The session's transcript exceeded the model's
    context size."`). fm serve reports it as a 500, but the request is fixed, so every
    retry re-sends the same oversized transcript. Terminal: trim the prompt. The HTTP
    status stays fm serve's 500 — branch on `type`, as with `tool_choice_unsupported`.
  - `type: "invalid_request_error"` (`code: "cyclic_schema"`) — a `response_format`
    schema whose `$defs` refer to themselves. Rejected by the proxy before any upstream
    connection, because forwarding one hangs `fm serve` permanently.
  - `type: "rate_limit_exceeded"` (`code: -1`) — capacity/rate-limit
    (`LanguageModelError -1`), transient. The proxy retries these with backoff before
    surfacing; if you still see one, back off and retry.
  - `type: "invalid_request_error"` (`code: "tool_choice_unsupported"`) — `model:"system"`
    with a forced `tool_choice` (`"required"`, or a specific `{type:"function",...}`
    pin) is rejected with `500 "An unsupported generation guide was used."` Deterministic
    and permanent (retrying re-fails identically), so the proxy does **not** retry it —
    without this it would retry-loop a permanent bug for ~19.5s before surfacing it
    mislabeled as `rate_limit_exceeded`. Use `tool_choice:"auto"`, or omit it. There is
    no second model to switch to.
  - `type: "server_error"` (`code: "internal_error"` / `"upstream_unreachable"`) —
    anything else, including the `502` when `fm serve` is down.

### Upstream behaviour on the 27.0 RC

Audited 2026-09-09 against a live `fm serve` on `system`, build `26A428`, `fm`
2.0.68.1.402. Treat the RC as the final build. This table is the single statement of
what `fm serve` does; do not re-derive it from the release history below.

| Behaviour | What `fm serve` does |
|---|---|
| Tool calling | Never populates `tool_calls`. `finish_reason` is `stop`. |
| Tool-call content | Leaks raw chat-template markers. See below. |
| Forced `tool_choice` | `500 An unsupported generation guide was used.` |
| Tool with no `function.description` | `400` for the whole request |
| `stream` omitted | Returns `text/event-stream`, not one JSON object |
| `n > 1` | `400 n=2 is not supported.` |
| `parallel_tool_calls` | Accepted, then ignored |
| `max_tokens` | Ignored. The proxy truncates. |
| Prompt framing | `hello world` is 57 `prompt_tokens` |
| Context window | 4096 tokens. 4045 passes, ~4255 overflows. |
| `$defs` + dialect, non-cyclic | `200` in one to three seconds |
| `$defs` + dialect, **cyclic** | Hangs permanently. Restart `fm serve`. |
| `$defs`, no dialect | `400` naming `x-order` |
| Titled string schema | `400` unless it carries a non-empty `enum` |
| `array<array<object>>` tool param | Accepted natively |
| Vision | Real image understanding. A 256 px PNG costs 131 `prompt_tokens`. |
| Private Cloud Compute | Removed from the binary in Beta 7. `system` is the only model. |
| Cross-site headers | `403` if the request carries `Origin`, `Referer`, or `Sec-Fetch-*` |

The licence is `FM1 version 1.0`, unchanged since Beta 5. Read it with `fm license
--show` and check it with `fm license --status`; both print without prompting, once a
privileged user has accepted it. Acceptance survives an OS update.

#### Tool-call replies leak chat-template markers

When a request carries `tools`, most replies contain raw template markers in `content`:
`<start_of_turn>` and `<ctrl46>`. Measured at 7 of 10 replies direct to `fm serve` and 9
of 10 through the proxy, from one prompt and one tool each. Read that as "most replies",
not as a difference between the paths.

The leak needs `tools`. The same prompt without them leaked 0 of 4 times, and an
unrelated prompt leaked 0 of 4 times. Underneath the markers the model emits a correct
call: `<start_of_turn>model\n{"tool_call": [{"name": "get_weather", ...`.

The Beta 7 and Beta 8 audits saw no markers here. Their samples were too small. They
missed the leak. The leak is not new in the RC. The clean-room reimplementation records
the markers on Beta 7. The evidence is the header comment of its `fm-proxy.js`, line 20,
committed 2026-08-18. It names `<ctrl46>` and `<start_of_turn>` in `content`. The leak is
intermittent. Send at least 10 requests before you call a build clean.

Stripping is opt-in. Set `FM_STRIP_TEMPLATE_MARKERS=1` and the proxy removes the markers
from `content` on both paths. It is off by default for two reasons: the proxy otherwise
corrects only envelopes and schemas and does not filter content, and the markers are the
signal an audit uses to detect the upstream bug.

Verified live on the RC. With the flag off, 8 of 10 replies leaked. With it on, 0 of 10
leaked over the non-streaming path and 0 markers appeared across 4 streaming runs, while
the rate at which replies carried a real tool call did not change.

The markers are single tokens in the vocabulary, so each arrives whole in one delta and
never straddles a chunk boundary. That is why a per-delta regex is enough and no
hold-back buffer is needed.

#### Operational notes

- **`fm available` is not a health check.** It reports "System model available" even
  while every inference request fails. Test health with a real request.
- **`com.apple.SensitiveContentAnalysisML error 15` is environmental.** It appears on a
  machine still settling after an OS update, and it clears itself: on the RC it cleared
  in about 20 to 30 minutes with no intervention. An experiment ruled out both the cyclic
  hang and an `fm serve` restart as causes. Wait before you investigate.
- **After a restart, the first request takes about 25 seconds** while the model reloads.

#### Expected test results

108 unit tests pass. The wire baseline records 14 cases and 3 endpoints.
`node tools/deviation-probe.js 1977` reports 11 of 11 handled. `tools/harness-check.sh`
reports 6 passed and 1 failed; the failure is the `pi` case described in
`tools/TEST_PLAN.md`.

A test skips when `fm` cannot answer, so a run during a model-service fault reports 106
passed and 2 skipped. That is the machine, not the code.

Caution: pin `FM_BIN` to a path that does not exist for **both** runs when you compare
wire baselines. The stub replaces the upstream engine, but the proxy still shells out to
`fm count-tokens` for its usage fallback, so a machine whose model service is down
produces a different baseline from identical code. Pinning it forces the fixed
`chars / 4.4` heuristic, and the baseline then depends only on the code.

```bash
FM_BIN=/nonexistent node tools/wire-baseline.js /tmp/after.json
```

### Release history

Beta 7 and later are the supported builds. The proxy carries no code for earlier ones.
This table records how the upstream behaviour arrived where it is. The table above is
authoritative for what is true now.

| Build | `fm` | What it changed |
|---|---|---|
| Beta 2 `26A5368g` | 2.0.55.1.402 | Baseline. On-device model flaky after the update. |
| Beta 3 `26A5378j` | 2.0.59 | Non-streaming token counts fixed. Nested tool params decoded natively. CORS preflight answered, real request still 403. |
| Beta 4 `26A5388g` | 2.0.62.1.402 | `token-count` renamed `count-tokens`; `--load-transcript` renamed `--resume`. Object chains of any depth decoded. |
| Beta 5 `26A5406e` | 2.0.68.1.401 | Licence gate added. `stream` default flipped to SSE. Tool calling broke. `$defs` with the dialect began hanging the server. |
| Beta 6 `26A5416b` | 2.0.68.1.401 | Rebuilt binary, identical CLI surface. No behaviour change. |
| Beta 7 `26A5421a` | 2.0.68.1.402 | **PCC removed from the binary**, with `fm quota-usage`. Non-cyclic `$defs` fixed. `array<array<object>>` accepted. Titled strings began requiring an `enum`. Audit fixed two proxy hazards in `57f26d3`: a forwarded cyclic schema, and a retried terminal 400. |
| Beta 8 `26A5425a` | 2.0.68.1.402 | Rebuilt binary, identical CLI surface. No behaviour change. Audit fixed a proxy bug: a capped stream emitted two `finish_reason` values. |
| RC `26A428` | 2.0.68.1.402 | Rebuilt binary, identical CLI surface. The RC audit found the tool-call marker leak. A clean-room record shows Beta 7 leaked too. |

Three builds now share `fm` 2.0.68.1.402 and produce a byte-identical help tree, so only
the binary's mtime distinguishes them. The help tree does not show behaviour. Audit both layers
after any OS update.

### Vision: how the on-device model encodes images

The on-device model does **real** image understanding, not OCR. Given a text-free crop
of a travel poster it described the scene ("people surfing and walking on a sunny beach
with palm trees and sailboats"), named the sun's colour, and confirmed someone was
surfing. It miscounted 3 sailboats as 4 — ordinary counting weakness, not blindness.

The token cost is flat, and that is the useful part:

| Image | `system` |
|---|---|
| 699×420, 545 KB | 187 |
| 699×1024, 1.3 MB | 187 |
| 1696×2482, 7.5 MB | 187 |

`system` charges a **flat** cost per image no matter the resolution or file size — 14×
the pixels costs the same 187 tokens, so roughly 130 tokens for the image on top of a
~57-token turn. It evidently downsamples to a fixed grid and emits a fixed-size
embedding.

Two practical consequences. Resizing before sending is pointless: it cannot save tokens
and it only discards detail. And the fixed budget is why the model reads large text
reliably but miscounts small repeated objects — there is only so much grid.

Unrelated bug: `fm count-tokens --image <path>` fails with
`ModelManagerServices.ModelManagerError error 1001`, so image token costs have to be
read from `fm serve`'s `usage` instead of the CLI.

Every feature works on the on-device model, but only if the whole request fits the
4096-token window. Through the raw API that is easy: a plain turn frames to 57 tokens
and a 1024px poster image to 195. Through an agent harness it is not. See "Context
budget" and "Running Pi against fm-proxy".

**Proxy feature sweep on Beta 5 (through the proxy, 12 checks):** non-streaming chat,
streaming chat, streaming usage relay, `stream`-omitted → JSON, structured output with
`$defs`, missing-description backfill, vision (`image_url`), CORS preflight,
`GET /v1/models`, `GET /health`, and fast non-retryable forced-`tool_choice` rejection
(154 ms) all pass. Only tool calling fails, and that is upstream.

> **Testing caution.** Once `fm serve` is poisoned (see `$defs` above), every later
> request fails with `com.apple.SensitiveContentAnalysisML error 15`,
> `LanguageModelError error -1`, or a hang — regardless of what you are testing.
> Those errors are a property of the server's state, not a verdict about the feature
> under test. Restart `fm serve` and re-run a control that is known to pass before you
> trust any negative result. An early Beta 5 run wrongly concluded that object `title`
> caused a hang; it passes on a clean server.
>
> The error 15 part of that caution did not reproduce on the 27.0 RC. A deliberate hang
> plus a restart returned a healthy server twice, and error 15 never followed. Either the
> link was specific to Beta 5, or the Beta 5 run hit the same environmental fault that the
> RC audit later traced to a settling machine. Treat error 15 as environmental first.

### Known limits

- Tool-parameter **nested** schemas decode natively at every depth, `array<array<object>>`
  included. Earlier betas needed a JSON-string round-trip for that one shape; Beta 7
  accepts it, so the round-trip machinery is gone. `response_format` nested schemas get
  `$defs` dialect injection only — see "Structured output" below.
- `n > 1` is rejected: `400 "n=3 is not supported. Only a single completion per request
  is implemented."` Earlier betas accepted and silently ignored it. The proxy types the
  400 as `invalid_request_error` and does not retry it.
- `parallel_tool_calls: false` is **not honored** — fm serve accepts the field (200,
  no error) but ignores it entirely. Verified live: identical multi-tool-call responses
  whether the field is `true`, `false`, or omitted, on `tool_choice:"auto"`, both
  directly against `fm serve` and through the real proxy (streaming and non-streaming).
  The proxy deliberately does **not** emulate this by truncating the response to one
  `tool_call` — OpenAI's real semantics constrain *generation* so only one call is ever
  produced, whereas post-hoc truncation would silently discard tool calls the model
  already decided were necessary, corrupting the conversation with no error signal
  (worse than passing all of them through, since most tool-calling clients iterate the
  whole `tool_calls` array regardless of what they requested). Treated the same as
  `n > 1`: a real fm serve gap, documented rather than faked.
  (Unlike `n > 1`, `parallel_tool_calls` is still accepted silently rather than 400'd.)
- `stop` is withheld from `fm serve`, which 400s on it, and applied by the proxy. Other
  sampling params (`temperature`, `top_p`, …) are passed through as-is; whatever
  `fm serve` supports applies.

> Implementation note: the proxy buffers each request body and sets its own
> `Content-Length`, stripping any inbound/upstream `Transfer-Encoding` so a client that
> streams its upload (chunked) can't produce illegal `CL + TE` framing. Covered by the
> integration tests in `fm-proxy.test.js`.

### Token usage

`fm serve` reports real usage on both paths, and the proxy relays it.

Streaming needs an opt-in that real clients never send: `fm serve` emits a final usage
chunk only when the request carries `stream_options: {include_usage: true}`. The proxy
sets that flag on every streaming request it forwards, then relays the real numbers.

The client's own ask is honoured on the way back out. An explicit
`stream_options.include_usage: false` suppresses the usage field in the relayed stream.
Absent or `true` keeps it. The `finish_reason` is emitted either way: a `content_filter`
abort carries it only on that final chunk, so declining usage must not also drop it.

The proxy counts tokens itself only when `fm serve` sends no usage at all, which happens
when a guardrail abort never reaches a clean finish. That count shells out to
`fm count-tokens` and falls back to a `chars / 4.4` heuristic.

Caution: each count forks `fm` synchronously, which blocks the event loop for about
65 ms. Keep it in the fallback path. Do not call it on an ordinary request.

A one-line message frames to 57 `prompt_tokens`.

### Context budget

The window is 4096 tokens, and that is the whole budget. A 4045-token prompt passes and
about 4255 overflows. PCC and its larger window are gone.

An agent client's own gauge reads low, because it counts only `messages[].content` while
`fm serve` also frames three things into the prompt:

- **tool schemas** — a flat tax from turn 1, independent of conversation length
- **assistant `tool_calls`** — they live in `m.tool_calls`, never in `content`
- **per-turn template framing** — applied per turn, which a gauge collapses to one

A full Pi toolset alone measures over 11k tokens, so it overflows 4096 by itself. Keep
the toolset lean, or send no tools.

An overflow returns `invalid_request_error` / `context_length_exceeded` on the first
attempt. The proxy does not retry it, because the request is fixed and every retry
re-sends the same oversized transcript. The message leads with the canonical phrase
"context length exceeded" so a client that matches on text can compact and retry.

### Structured output (`response_format`)

`fm serve` honours OpenAI `response_format: {type:"json_schema", json_schema:{name,
schema}}`. It is undocumented, and the constrained decoding is real.

**The dialect rule.** `fm serve` requires its own keys — `title`, `x-order`, `required`,
`additionalProperties` — but only on object schemas reached through `$defs`: the `$defs`
entries themselves, and any object nested inside one, recursively, including array items.
The top-level schema and any object reached purely through inline `properties` nesting
need none. A missing key raises an error that names it, such as `keyNotFound 'x-order'`.

Two shapes to avoid:

- A `title` on a string schema makes it a named string type, which then requires a
  non-empty `enum`. Apply the dialect to objects only, or add the `enum`.
- A `$ref` that points at a non-object `$defs` entry, such as an array wrapper defined
  directly under `$defs`, fails with `undefinedReferences`. Keep array wrappers inline
  and put only the referenced object type in `$defs`. Real generators already do this.

**The proxy handles all of it.** `fixResponseFormatSchema` resolves `$ref` inline and
drops `$defs` entirely, so the dialect question never reaches `fm serve`. It falls back
to injecting the dialect only when a schema cannot be inlined. This matters because
pydantic, zod-to-json-schema, and TypeBox all emit `$defs`/`$ref` for named types, so an
ordinary client would otherwise get a `400`.

Warning: a cyclic `$defs` has no finite inline form, and forwarding one hangs `fm serve`
permanently. The proxy rejects it with `400` `cyclic_schema` before it opens an upstream
connection.
