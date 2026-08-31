> **License, as of Beta 5.** `sudo fm license` must be accepted before any `fm`
> subcommand runs. Its terms include "agreeing to NOT programmatically access or use
> Apple models through Apple software or services except as expressly permitted".
> `fm-proxy` does exactly that, so this project conflicts with the terms it accepts.
> Keep it to local research. The README carries the full warning — do not remove it.

## Project direction

**`fm-proxy.js`** sits in front of Apple's `fm serve` and speaks the OpenAI Chat
Completions dialect, so an ordinary OpenAI client works against the on-device model
without code changes. It supports **Beta 7 only**; code for earlier betas is removed.

An earlier in-process Swift `fms` app was explored and dropped: it could not run
inference on Private Cloud Compute, which needed the Apple-private entitlement
`com.apple.modelmanager.inference`. That question is now moot — Beta 7 removes PCC from
the `fm` binary altogether.

## `fm` CLI reference

The full `fm` command tree (every subcommand, option, default, and discussion) is
generated from Apple's binary and committed for offline/agent use. Pull from these
instead of re-deriving help text:

| Resource | Path | Notes |
|---|---|---|
| Generator | `tools/gen-fm-docs.py` | Runs `fm --experimental-dump-help` (one call, no recursive `--help` scraping) and emits the markdown reference. Re-run after any `fm` update: `python3 tools/gen-fm-docs.py`. |
| Markdown reference | `docs/fm-reference.md` | Per-command option tables; best for grepping / LLM context. |

Source of truth is the installed binary (`/usr/bin/fm`): the docs reflect whatever
version is on disk, so regenerate rather than hand-editing.

### Fingerprinting the `fm` version (no `--version` flag)

`fm --version` does **not** exist (errors "Unknown option"). To detect when Apple ships a
new `fm`/FoundationModels build across macOS betas, fingerprint the binary:

| What | How | Beta 2 value | Beta 3 value | Beta 4 value | Beta 5 value | Beta 6 value | Beta 7 value | Beta 8 value |
|---|---|---|---|---|---|---|---|---|
| fm source version | `otool -l /usr/bin/fm \| grep -A2 LC_SOURCE_VERSION` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` |
| Framework version | `plutil -p /System/Library/Frameworks/FoundationModels.framework/Resources/Info.plist \| grep CFBundleVersion` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` |
| Runtime version | `codesign -dvvv /usr/bin/fm` → `Runtime Version=` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` |
| Rebuild date | `ls -la /usr/bin/fm` (mtime) | Jun 19 2026 | Jul 3 2026 | Jul 17 2026 | Aug 7 2026 | Aug 14 2026 | Aug 21 2026 | Aug 27 2026 |
| macOS build | `sw_vers` → `BuildVersion` | `26A5368g` (27.0 Beta 2) | `26A5378j` (27.0 Beta 3) | `26A5388g` (27.0 Beta 4) | `26A5406e` (27.0 Beta 5) | `26A5416b` (27.0 Beta 6) | `26A5421a` (27.0 Beta 7) | `26A5425a` (27.0 Beta 8) |

Audit recipe after any OS update:

1. **Structure** — regenerate and diff the CLI tree:
   `python3 tools/gen-fm-docs.py --outdir /tmp/fmnew` then
   `diff docs/fm-reference.md /tmp/fmnew/fm-reference.md`.
   The tree is a compile-time dump, so a diff here is authoritative: Beta 7's was all
   deletions, which is how PCC's removal was caught.
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

Record the result as a new `### Beta N` section, and fold the previous one into the
release-history table.

## Running Pi against fm-proxy

Pi **works** against the on-device model. What it cannot do is tool calling, and what
kills it in practice is project context, not the harness itself.

Use `pi-minimal` (an alias for `pi -ne -ns -np --no-themes`) and select the `` FM``
provider's `system` model. Measured live on Beta 7, in a directory with no context file:

```
[assembled] req model=system turns=1 gauge(msgs)=689 tools=499 => assembled=1188
```

1188 tokens of a 4096-token window, and the request returns HTTP 200. The lean toolset
costs only 499 tokens.

**The window is spent on project context, not on Pi.** Running the identical command in
a directory holding this repo's `AGENTS.md` assembles to **9582** tokens and fails:

| Directory | messages | tools | assembled | Result |
|---|---|---|---|---|
| empty | 689 | 499 | 1188 | HTTP 200 |
| plus `AGENTS.md` | 9083 | 499 | 9582 | context exceeded |

One 40 KB context file is ~8.4k tokens — twice the whole window. So on the on-device
model, treat the 4096 tokens as a budget for *your documents*, and keep Pi out of
directories with large `AGENTS.md`/`CLAUDE.md` files. Earlier betas could fall back to
`pcc` and its 32k window; Beta 7 cannot, because `pcc` is gone.

Two limits remain regardless of context size:

- **Tool calling is broken upstream.** `fm serve` does not turn the model's tool call
  into a `tool_calls` field, so Pi can chat but cannot use tools.
- **PCC is removed**, so there is no larger window to escape to.

Pi's own gauge counts only `messages[].content` and reported `0.2%/4.1k` for a request
that really assembled to 9508. Do not trust it — read the proxy's `[assembled]` line.

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

### Beta 8 (fm 2.0.68.1.402, build 26A5425a) — no change

Audited 2026-08-31 against a live `fm serve` on `system`. Apple rebuilt the binary on
Aug 27 2026, but shipped no change that this project can detect. Treat the Beta 7
section below as the current description of upstream behaviour.

The source version, the framework version, and the runtime version all hold at
`2.0.68.1.402` / `27.0.0`. `python3 tools/gen-fm-docs.py` produces a CLI tree that is
byte-identical to the committed one, so the diff is empty. Only the mtime moved. This
repeats the Beta 6 pattern: a rebuild with no new surface.

The behaviour layer was re-run in full, because an identical tree does not prove
identical behaviour. Every wall reproduces:

| Check | Beta 7 | Beta 8 |
|---|---|---|
| Tool calling | `tool_calls` null, content is clean JSON | Same |
| Forced `tool_choice` | `500` unsupported generation guide | Same |
| Tool with no `function.description` | `400` | Same |
| `stream` omitted | `text/event-stream` | Same |
| `n > 1` | `400` | Same |
| `hello world` framing | 57 `prompt_tokens` | Same |
| Context window | 4055 tokens pass, 9089 overflow | Same |
| `$defs` non-cyclic + dialect | `200` | Same |
| Titled string needs a non-empty `enum` | `400` without, `200` with | Same |
| Bare `$defs`, no dialect | `400` on `x-order` | Same |
| `array<array<object>>` tool param | `200` | Same |
| `$defs` **cyclic** + dialect | Hangs, poisons the server | Same |
| Vision | Describes a 256 px PNG correctly | Same, 130 `prompt_tokens` |
| PCC | Absent from the binary | Same |

The cyclic `$defs` hang is still the one live hazard upstream. A dialect-decorated
`{Node: {child: $ref Node}}` sent straight to `fm serve` never answers, and `fm serve`
answers nothing afterwards until you restart it. The proxy's guard from `57f26d3` still
catches it first: through port 1977 the same request returns `400` / `cyclic_schema` in
about 140 ms, and the proxy stays healthy.

Licence acceptance survived the OS update again. `sudo fm license` was not needed.

#### Test results

All 102 unit tests pass. The wire baseline records the same 14 cases and 3 endpoints.
`tools/harness-check.sh` reports 6 passed, 1 failed.

The failure is **not** an upstream change. It is a regression in this proxy, and the
audit found it. `pi` prints nothing for a `-p` prompt through port 1977, but prints
normally through a bare pass-through to `fm serve`, and prints normally against another
provider. See "A streaming cap emits two finish_reason values" below.

#### A streaming cap emits two finish_reason values

The streaming cap logic appends a `finish_reason` instead of rewriting one. Upstream
sends `finish_reason: "stop"` on its own chunk before the usage frame arrives. The proxy
then adds a second `finish_reason: "length"` on the trailing usage chunk whenever
`completion_tokens >= max_completion_tokens`. One stream therefore carries two
`finish_reason` values. The non-streaming path does not have this defect: it rewrites the
value in place.

The cap also does not truncate. The full completion text still reaches the client.

Reproduce it with any cap at or below the real completion length:

| Request | `finish_reason` values in the stream |
|---|---|
| `max_tokens` omitted | `["stop"]` |
| `max_tokens: 50` on a 3-token reply | `["stop"]` |
| `max_tokens: 3` on a 3-token reply | `["stop", "length"]` |
| `max_tokens: 1` on a 3-token reply | `["stop", "length"]` |

This breaks `pi`. `pi` sends `max_completion_tokens: 1`, captured from a recording
pass-through. `fm serve` ignores that field, so a direct connection returns `["stop"]`
and `pi` prints the answer. Through the proxy `pi` reads the last `finish_reason`,
treats the turn as truncated, and renders nothing. `pi --mode json` shows the text did
arrive, with `"stopReason": "length"`.

Why `pi` chooses `1` is not established. Changing `compaction.reserveTokens` and the
model's `maxTokens` in `~/.pi/agent/` did not move it, which points at a cached model
catalogue rather than the live settings.

### Beta 7 (fm 2.0.68.1.402, build 26A5421a) — PCC removed

Audited 2026-08-26 against a live `fm serve` on `system`. This is the first `fm` change
since Beta 4: the source version moves `2.0.68.1.401` → `2.0.68.1.402`.

**Private Cloud Compute is gone.** The CLI reference diff shows only deletions:

- `--model pcc` is removed from `respond`, `chat`, and `available`. The parser answers
  `The value 'pcc' is invalid for '-m <model>'. Please provide one of 'system'.`
- The `fm quota-usage` subcommand is deleted. It existed only to report PCC quota.
- `fm serve` help now reads `"system" is the default and the only supported value`.
- `fm available` prints `System model available` and nothing else.
- `GET /health` and `GET /v1/models` list only `system`.
- `POST /v1/chat/completions` with `model:"pcc"` returns `400 Unknown model 'pcc'.
  Available models: system`.

The `pcc` model enum is absent from the binary's ArgumentParser tree, so this is a
compile-time removal, not account state, entitlement, or licence state. Every PCC note
in this file — the context ceiling, the rate-limit error, the codegen abort, the
Terminal.app attribution rule, the `503` service-unavailable branch — is now dead
surface on Beta 7. The notes stay for the history; do not act on them.

The licence acceptance survives the OS update. `sudo fm license` is not needed again.

#### What else changed

| Check | Beta 5 / 6 | Beta 7 |
|---|---|---|
| `$defs` + dialect, non-cyclic | Hangs, poisons the server | **Fixed.** 200 in ~1–3 s |
| `$defs` + dialect, **cyclic** | Hangs, poisons the server | Still hangs, still poisons |
| Tool-call output | `tool_calls` null, control tokens leak into content | `tool_calls` still null, but content is **clean JSON**, no leaked tokens |
| `array<array<object>>` tool param | Hard 400 | **Accepted.** Raw `fm serve` returns 200 |

The `$defs` fix has a rule attached. A `title` on a string property now makes it a
*named string type*, which then requires a non-empty `enum`:

```
DecodingError.dataCorrupted ... Path: $defs.properties.name.enum.
Named string types must have a non-empty enum
```

So apply the dialect to objects only, or give the titled string an `enum`. Both forms
return 200. A bare `$defs` with no dialect still fails fast on `x-order`, unchanged.

#### What did not change

Prompt framing is still 57 tokens for `hello world`, so `CONVERSATION_FRAMING = 54`
still holds against a bare `fm count-tokens` count of 3. An omitted `stream` still
returns `text/event-stream`. A forced `tool_choice` still returns `500 An unsupported
generation guide was used` — and `pcc`, which used to be the workaround, is no longer
available. A tool without `function.description` still returns 400. `fm serve` still
ignores `max_tokens`; the proxy's own truncation is still required.

#### Two hazards — both fixed in `57f26d3`

Both were found by this audit and repaired on `fix/beta7-hazards`. The descriptions
below record what the defect was. Verified live after the fix: a cyclic schema returns
`400` in about 1 ms and `fm serve` keeps answering, and an unknown model returns
`invalid_request_error` in about 2 ms.

1. **A recursive `$defs` schema takes the stack down.** The hang needs a definition
   that refers to itself and holds no other required property. `{Node: {child:
   $ref Node}}` hangs; adding a required scalar beside `child` returns 200. A dialect on
   the *root* schema also triggers it. The proxy keeps `$defs` for cyclic schemas by
   design, because recursion has no finite inline form, so an ordinary client request
   reaches this: verified end-to-end through port 1977, and `fm serve` then answered
   nothing until restart. The wire-baseline fixture `response_format cyclic` is exactly
   this shape.

2. **The proxy retries an upstream `400`.** `fm serve` rejects an unknown model in 7 ms.
   `classifyError` does not treat that `400` as terminal, so the proxy runs the full
   1+2+4+8 s backoff and answers after ~15 s with `server_error` / `internal_error`
   rather than `invalid_request_error`. This is the same defect class the forced
   `tool_choice` branch already fixes, and PCC's removal makes it reachable for anyone
   whose client still names `model: "pcc"`.

#### Test results

All 82 unit tests pass. The wire baseline is unchanged. `tools/harness-check.sh` reports
6 passed, 0 failed. Vision works: a 256 px PNG cost 128 prompt tokens and the model
described it correctly.

`pi` on `system` still cannot fit the 4096-token window, and the documented workaround
was "use `pcc`". With `pcc` removed there is no longer any way to run `pi` against
`fm serve`.

### Release history before Beta 7

Beta 7 and Beta 8 are the supported builds, and they behave identically. The proxy no longer carries code for earlier ones.
Kept as a short record of how the upstream behaviour arrived where it is:

| Build | `fm` | What it changed |
|---|---|---|
| Beta 2 `26A5368g` | 2.0.55.1.402 | Baseline. On-device model flaky after the update. |
| Beta 3 `26A5378j` | 2.0.59 | Non-streaming token counts fixed. Nested tool params decoded natively. CORS preflight answered, real request still 403. |
| Beta 4 `26A5388g` | 2.0.62.1.402 | `token-count` renamed `count-tokens`; `--load-transcript` renamed `--resume`. Object chains of any depth decoded. PCC began requiring Terminal.app. |
| Beta 5 `26A5406e` | 2.0.68.1.401 | Licence gate added. `stream` default flipped to SSE. Tool calling broke. `$defs` with the dialect began hanging the server. |
| Beta 6 `26A5416b` | 2.0.68.1.401 | Rebuilt binary, byte-identical CLI surface. No behaviour change. |

Two of those are still live constraints and are documented above rather than here: the
licence gate, and the SSE default for a request that omits `stream`.

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

**The 4096-token `system` window is the real constraint for agent clients.** Every
feature works on the on-device model, but only if the whole request fits in 4096
tokens. Through the raw API that is easy — a plain turn frames to 57 tokens, and the
1024px travel-poster test image to 195. Through Pi it is not: Pi's built-in tools alone
frame to ~11k (`Content contains 11176 tokens, which exceeds the maximum allowed
context size of 4096`), and even `-nt` with a one-line `--system-prompt` still
overflows **when the working directory holds a large context file**. In an empty
directory `pi-minimal` assembles to just 1188 tokens and succeeds; adding this repo's
`AGENTS.md` takes it to 9582 and it fails. The toolset is only 499 tokens either way, so
the budget goes to documents, not to the harness. See "Running Pi against fm-proxy".

Pi's own gauge reads `0.2%/4.1k` for a request that really assembles to 9508, because it
counts only `messages[].content`. Do not trust it; read the proxy's `[assembled]` line.

Passing an image to Pi uses `@path`: `pi ... @/tmp/poster.png "What does this say?"`
(its own help shows `pi @prompt.md @image.png "What color is the sky?"`). Note `@path`
is a separate argv entry — folding it into the `-p` string makes Pi read the whole
string as a filename.

**Feature sweep on the on-device `system` model (12 checks, through the proxy):**
identical to the sweep below — 11 pass, only tool calling fails. Vision answered the
poster correctly ("Anchorage, Alaska") at 195 prompt tokens.

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
- Sampling params (`temperature`, `top_p`, `stop`, …) are passed through as-is; whatever
  `fm serve` supports applies.

> Implementation note: the proxy buffers each request body and sets its own
> `Content-Length`, stripping any inbound/upstream `Transfer-Encoding` so a client that
> streams its upload (chunked) can't produce illegal `CL + TE` framing. Covered by the
> integration tests in `fm-proxy.test.js`.

### Token usage repair

Apple's `fm serve` used to report usage wrong on both paths — non-streaming sent
`prompt_tokens: 0`, streaming sent no `usage` at all. **Non-streaming is fixed**:
verified live against `fm count-tokens`, the reported
`prompt_tokens` matches exactly, and it reflects the **full assembled**
prompt (messages + tool schemas + tool_calls + per-turn framing) — fm serve's own
number, not an estimate. The proxy passes non-streaming usage through untouched.

**Streaming now gets fm serve's own real usage too — fixed by forcing the opt-in.**
`fm serve` only sends a real final usage chunk on a streaming completion when the
request carries the standard OpenAI `stream_options:{include_usage:true}` opt-in, and
real clients (Pi included) essentially never set it. The proxy now forces that flag
on every streaming request it forwards upstream, regardless of what the client sent,
captures fm serve's real final usage-only chunk (`choices:[]` + `usage`), and relays
it to the client — verified live for both plain-text (`finish_reason:"stop"`) and
tool-call (`finish_reason:"tool_calls"`) completions, `prompt_tokens`/`completion_tokens`
both accurate. The old completion-text-based estimate (via `fm count-tokens`, with a
`9 + chars/4.4` heuristic fallback) survives only as a fallback for upstreams that
don't cooperate — e.g. a safety-guardrail abort that never reaches a clean
finish and so never gets a real usage chunk from fm serve either.

Note: on Beta 7 a one-line message frames to **57** `prompt_tokens`, matching Beta 3 and
Beta 5. (Beta 4 briefly inflated this to ~208; that regression is gone.) The framing is
passthrough for the proxy — fm serve reports its own numbers — but it eats into the
4096-token window, and the `[assembled]` gauge counts raw text rather than fm serve's
template, so it under-counts.

The proxy still suppresses the upstream `[DONE]` and re-emits its own final chunk
either way, so clients reading the last chunk always get *some* usage. The **client's
own** `stream_options.include_usage` ask is honored separately, on the way back out:
explicit `include_usage:false` suppresses the usage field in the relayed stream
(matching vanilla OpenAI shape for an explicit opt-out) — decided this way because a
client that explicitly asks not to receive usage shouldn't see it just because the
proxy needs it upstream for its own accounting. Absent or `true` keeps the proxy's
established always-on usage chunk, the behavior that already existed before this fix
(a synthesized number), just backed by real figures now. The finish_reason itself is
still always emitted even when usage is declined: for a content_filter abort it's
*only* ever carried by this final chunk (the abort's own error frame is swallowed
elsewhere in the pipeline), so opting out of usage can't also silently drop it.

For the fallback-estimate path only, the injected `prompt_tokens` is the proxy's own
**assembled** estimate (messages + tool schemas + tool_calls + per-turn framing) — an
approximation, not fm serve's own count. Set `GAUGE_MODE=msgs` to revert to the
messages-only number for that estimate. Also set Pi's FM provider context size to
**32768** so the gauge *percentage* scales correctly.

### Context budget — why an agent client's gauge lies

The on-device window is **4096 tokens** (verified: a 4056-token prompt succeeds, ~8056
fails with "The session's transcript exceeded the model's context size"). That is the
whole budget; Beta 7 removed `pcc` and its ~32k window.

A client gauge that counts only `messages[].content` reads far lower than reality,
because fm serve also frames three things into the prompt:

- **tool schemas** — a flat tax present from turn 1 (a full Pi toolset measured ~11k+,
  which alone overflows 4096). Constant per request, independent of conversation length.
- **assistant `tool_calls`** — live in `m.tool_calls`, never in `content`; cumulative.
- **per-turn template framing** — applied per turn; a gauge collapses it to one.

`fm-proxy.js` logs the real assembled size to **stderr** every request:

```
[assembled] req model=system turns=N gauge(msgs)=… tools=… toolCalls=… perTurn=… => assembled=…
```

and flags the failing request (`*** CONTEXT EXCEEDED ***`, `*** UPSTREAM STREAM ABORTED ***`).
An overflow is terminal and is surfaced on the first attempt — it is not retried.
Note: `tools=` *under*-counts fm serve's true per-tool framing (it counts raw JSON; fm
adds scaffolding), so with a fat toolset the real prompt is bigger than `assembled`
shows. This under-count only affects the **streaming** gauge — non-streaming gets fm
serve's own real `prompt_tokens` (see "Token usage repair" above). **Keep tools lean**,
or use no tools at all: 4096 tokens does not absorb a general-purpose toolset.
### Structured output (`response_format`)

fm serve honors OpenAI `response_format: {type:"json_schema", json_schema:{name, schema}}`
(undocumented; constrained decoding is real).

**The dialect requirement is narrower than first found, and the proxy now fixes it.**
The original (2026-06-14) finding said fm's `title`/`x-order`/`required`/
`additionalProperties` dialect was needed "on every object level" — but that was only
ever tested against a `$defs`/`$ref`-shaped schema. Re-verified live (2026-07-06, fm
2.0.59): the dialect is required **only on object schemas reached through `$defs`** (the
`$defs` entries themselves, and any object nested inside one — inline sub-properties,
array items — recursively). The **top-level schema** and any object reached **purely
through inline `properties` nesting** (never touching `$defs`) — flat schemas,
multi-level inline nesting, arrays of inline objects — decode with **zero** dialect keys.
Missing a required dialect key on a `$defs` object raises a specific error naming it
(`keyNotFound 'x-order'`, "Object schemas require a 'title' key", a missing `required`, a
missing `additionalProperties`); a `$ref` pointing at a non-object `$defs` entry (e.g. an
array wrapper defined directly under `$defs`) also fails (`undefinedReferences`) — keep
array wrappers inline and put only the referenced object type in `$defs`, which is what
real generators already do.

This still matters in practice: real schema generators (pydantic's
`.model_json_schema()`, zod-to-json-schema, TypeBox, …) virtually always emit
`$defs`/`$ref` for any named or reused type, so an ordinary client sending a plain,
undecorated schema with `$defs` would 400 against raw `fm serve`. **`fm-proxy.js` now
fixes this** (`fixResponseFormatSchema`, wired into `fixTools`): it walks
`response_format.json_schema.schema.$defs` and injects `title` (from the `$defs` key, or
the capitalized property name for anything nested deeper), `x-order` (the object's own
property order), `required` (preserved from the caller, filtered to real properties, else
`[]`), and `additionalProperties:false` (unless already boolean) — recursively, including
into array items. The top-level schema and any `$defs`-free inline nesting are left
exactly as sent, since decorating them is unnecessary token bloat, not a requirement.
Both flat and `$defs`/`$ref`-nested requests, streaming and non-streaming, verified live
end-to-end through the real running proxy.

**Nested objects work as of Beta 3** (fixed alongside the tool-parameter path — see
"Nested params" above): a two-level nested schema (`$defs`/`$ref`) decodes correctly via
both `fm respond --schema` and `response_format` over `/v1/chat/completions`, once the
`$defs` dialect above is present. Not retested: whether `response_format`'s nested
support has the same residual gap as the tool path (`array<array<object>>`; the 3+
chained-object gap was fixed in Beta 4) — if you hit it there, it likely applies here
too since both paths share the same underlying `GenerationSchema` engine.
