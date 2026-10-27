# What `fm serve` does

This file records how Apple's `fm serve` departs from the OpenAI API, and how the proxy
answers each departure. It is the reference for a maintainer. The README has the short
version for a user.

## Current behaviour

Audited 2026-10-27 against a live `fm serve` on `system`, build `26B123` (27.2 RC),
`fm` 2.1.14. This table is the single statement of what `fm serve` does; do not
re-derive it from the release history in `docs/audit.md`.

| Behaviour | What `fm serve` does |
|---|---|
| Tool calling | Works natively. `tool_calls` is populated and `finish_reason` is `tool_calls`, on both paths. Earlier builds never populated it; see "Native tool calling on 26B123". |
| Tool-call content | Clean. 0 of 20 replies carried markers or bare `{"tool_call": ...}` JSON. |
| Forced `tool_choice` | Works natively on both paths. `required` and a named function each return a real `tool_call`. Earlier builds answered `500 An unsupported generation guide was used.` |
| Tool with no `function.description` | `400` for the whole request |
| `stream` omitted | Returns `text/event-stream`, not one JSON object |
| `n > 1` | `400 n=2 is not supported.` |
| `parallel_tool_calls` | Accepted, then ignored |
| `max_tokens` | Ignored. The proxy truncates. |
| Prompt framing | `hello world` is 57 `prompt_tokens` |
| Context window | 4096 tokens. 4008 passes, ~4150 overflows. |
| `$defs` + dialect, non-cyclic | `200` in one to three seconds |
| `$defs` entry with `title` and `required`, no `x-order` or `additionalProperties` | `200`. Objects nested in the entry need no keys. |
| `$defs` entry with no `title` | `400` naming `undefinedReferences` |
| `$defs`, **cyclic** | No longer hangs the service. A prompt that makes it recurse generates for about 2 minutes (114 s measured), then fails with `500` context exceeded. A control request passed 2 s later. On 27.2 Beta 2 the same request hung the model service for about 2 minutes. |
| Titled string schema | `400` unless it carries a non-empty `enum` |
| `array<array<object>>` tool param | Accepted natively |
| Vision | Real image understanding. A 256 px PNG costs 131 `prompt_tokens`. |
| Private Cloud Compute | Back as a second model. `GET /v1/models` lists `system,pcc`, and a `pcc` request is accepted — but only when `fm serve` itself runs from a Terminal.app context. Otherwise it 503s fast: `Model 'pcc' is unavailable: Private Cloud Compute is not available in this context. Please use the Terminal app.` From Terminal.app, `fm respond --model pcc "Say hi"` answers. Beta 1 failed there with `The system is not ready.`; see the operational note. With `fm serve` launched from Terminal.app, `pcc` works direct and through the proxy. See "Private Cloud Compute on 27.2 Beta 2". |
| Unknown model name | `400 Unknown model 'gpt-4o'. Available models: system, pcc. Start fm serve with --model-provider to reach other models.` With a `default-model-provider` set, `fm serve` sends the name to that provider instead. If the provider is down, the reply is `500 Could not connect to the server.` A provider's own 4xx arrives wrapped in a 500: `HTTP error with status code 400: ...`. The proxy types a wrapped 4xx other than 429 as `provider_rejected` and does not retry it. |
| `--model-provider` client paths | fm appends `/v1/chat/completions` to the base URL and POSTs `stream:true` SSE with `stream_options.include_usage` (captured on a local listener). Register the bare host — for LM Studio `http://127.0.0.1:1234`, not `…/v1`. Model listing probes `{base}/models` without the `/v1`, which LM Studio does not serve; the error is cosmetic, chat works regardless. The `messages` array passes through verbatim: **no system prompt of fm's own** — `-i/--instructions` becomes the literal `system` message, otherwise the request carries only the user turn (plus empty `tools` and the `-m` id as `model`). |
| Cross-site headers | `403 Cross-site requests are not allowed.` if the request carries `Origin`, `Referer`, or `Sec-Fetch-*`, or a `Content-Type` of `text/plain`, `application/x-www-form-urlencoded`, or `multipart/form-data`. `application/json` and no `Content-Type` pass. The proxy removes the headers, sends `application/json`, and types a 403 as `cross_site_refused` without a retry. |

The licence is `FM1 version 1.1`, agreed 2026-09-18 on this build — the first bump
since the Beta 5 gate. The operative clause survives unchanged: agreeing means
"NOT PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH APPLE SOFTWARE OR SERVICES
EXCEPT AS EXPRESSLY PERMITTED", which is exactly what `fm-proxy` does. Keep it to
local research. Read it with `fm license --show` and check it with `fm license
--status`; both print without prompting, once a privileged user has accepted it.
Acceptance survives an OS update, but a version bump makes the user re-accept — expect
one `sudo fm license` after each such update. Beta 2 kept `FM1 version 1.1` and the same
clause, so the Beta 1 acceptance still holds. 26B123 also kept `FM1 version 1.1` and the
same text, so the acceptance of 2026-09-18 still holds.

### Private Cloud Compute on 27.2 Beta 2

Measured 2026-09-22 with `fm serve` launched from Terminal.app. The proxy needs no
`pcc`-specific code.

| Behaviour | `pcc` |
|---|---|
| `/health` | Lists `pcc` as available, with a `quota` object: `limit_reached`, `approaching_limit` |
| Prompt framing | `hello world` is 53 `prompt_tokens`. `system` is 57. |
| Context window | About 32k. 31,555 passes, ~33,055 overflows with `context_length_exceeded`. |
| Large prompts | Can fail with `LanguageModelError error -1` and succeed on a later try. It happened at 24k and 30k while 31.5k passed. Read it as a rate limit, as on 27.0. |
| Streaming | Works through the proxy, with one usage frame |
| Tool calling, auto | Never populates `tool_calls`. Markers leaked in 7 of 10 replies. On 26B123 it returns a real `tool_call` (1 of 1). |
| Forced `tool_choice`, raw | `200`, but the model ignores it and answers in prose. On 26B123 it returns a real `tool_call` (1 of 1). |
| Forced `tool_choice`, via proxy | A real `tool_call` with valid arguments |
| `n > 1` | `400`, as on `system` |
| `reasoning_effort` | Used. `low`, `medium`, and `high` are accepted; any other value 400s. The reasoning is hidden: `content` does not change and `reasoning_tokens` reads 0, but `completion_tokens` counts it. One prompt, twice each: none 11 tokens in 0.7 s, `low` 121 in 1.4 s, `high` 225 in 2.1 s. The proxy forwards it. On `system`, `fm serve` 400s the field, so the proxy removes it there. |

Caution: every `pcc` request uses the account's Private Cloud Compute quota. Keep probes
few, and check the `quota` object in `/health` before a long run.

### Native tool calling on 26B123

Measured 2026-10-27 on `26B123`, direct to `fm serve` unless stated.

| Check | Result |
|---|---|
| Auto, two prompts, one tool | 20 of 20 populated `tool_calls`. 0 markers, 0 bare JSON. |
| Auto, a prompt that needs no tool | Prose in 4 of 5. One reply called the tool. |
| Auto, two tools, a prompt that needs both | Two calls, each routed to the right tool |
| `parallel_tool_calls: false` | Still ignored: the same prompt returned two calls |
| Round trip with a `tool` result message | `200`, a prose answer that uses the result |
| Auto, streaming | One `tool_calls` delta, then `finish_reason: tool_calls` |
| Forced `required`, non-streaming and streaming | A real `tool_call`. 254 prompt tokens. |
| Forced named function, two tools offered | Called the named function |
| Through the proxy, auto, 10 JSON and 10 SSE | 20 of 20 real calls with valid JSON arguments. 0 leaks. |
| Through the proxy, forced | Still translated by `buildToolDispatch`. A real call, 111 prompt tokens. |

The proxy forwards auto unchanged, so auto tool calling works through it on this build
with no code change. The forced translation still works too, but `fm serve` no longer
needs it on this build. The sections below record the earlier builds.

### Tool-call replies leak chat-template markers

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

Re-verified live on the 27.2 beta, 2026-09-18: the leak persists. 2 of 10 direct replies
leaked from one prompt and one tool — a small sample, but the audit rule stands: send at
least 10 requests before you call a build clean. The rendering varies with the sample:
this run surfaced `[ToolCall{FunctionName:get_weather,Arguments:{city:<ctrl46>Paris<ctrl46>}}]`
alongside the familiar `<start_of_turn>` shapes. Underneath the markers the call is still
correct. `tool_calls` was populated 0 of 10 times, all `finish_reason: stop`. With
`FM_STRIP_TEMPLATE_MARKERS=1`, 0 of 10 leaked through the proxy.

Re-measured on 27.2 Beta 2, 2026-09-22, with 20 direct requests over two prompts and one
tool. The shape changed. Markers appeared in only 1 of 20 replies, but 10 of 20 replies
held the call as bare JSON in `content`: `{"tool_call": [{"name": "get_weather", ...`.
`tool_calls` was populated 0 of 20 times. `FM_STRIP_TEMPLATE_MARKERS` does not touch the
bare JSON, so a client still gets the call as text. A marker-only check calls this build
clean when it is not; grep for `"tool_call"` too.

The markers are single tokens in the vocabulary, so each arrives whole in one delta and
never straddles a chunk boundary. That is why a per-delta regex is enough and no
hold-back buffer is needed.

### Forced tool calling works, through a schema

Up to 27.2 Beta 2, `fm serve` never populates `tool_calls`, and it rejects a forced `tool_choice` with
`500 An unsupported generation guide was used.` It does honour `response_format`, so the
proxy translates a forced call instead of forwarding it.

`buildToolDispatch` turns each offered function into a property of one object schema.
`tool_choice: "required"` offers every tool and requires none of them, so any single key
satisfies the schema. A named function offers only that one and requires it. The request
then carries no `tools` and no `tool_choice`, only the schema and a short instruction.
`dispatchToToolCalls` turns the reply back into OpenAI `tool_calls`.

Measured on the 27.0 RC, before the code was written and again after:

| Mode | Result | Prompt tokens |
|---|---|---|
| `tool_choice: "required"`, one tool | 4 of 4 called | 114 |
| `tool_choice: "required"`, two tools | 8 of 8, routed to the right one | 119 to 122 |
| Named function | 4 of 4 called | 111 |
| Native `tools`, auto | 0 `tool_calls`, markers leak | 256 |

**Auto is deliberately not translated.** Auto must be able to answer without calling a
tool, so the schema needs a prose escape. Give the model that escape and it always takes
it: 0 of 25 in testing, even when the prompt named the function. Removing the escape is
what makes selection work, and that is only honest when the caller has already said a
tool is required.

A streaming client is served from a buffered reply. A dispatched reply is one JSON object
and cannot name a tool until it has arrived whole, so the proxy asks `fm serve` for a
non-streaming reply and synthesises the SSE frames. Arguments go out in 64-character
pieces, so a client that concatenates `function.arguments` across deltas gets valid JSON.

Re-measured on the 27.2 beta, 2026-09-18: `node tools/deviation-probe.js 1977` reports
11 of 11 handled, and check 6 — a forced named function — returned a real `tool_call`
with valid JSON arguments. The dispatch translation survived the `fm` jump to 2.1.7.1.901
intact.

Caution: a forced tool call and a caller's own `response_format` cannot both hold. The
dispatch schema wins.

### Operational notes

- **`fm models` (renamed from `fm available` in the 27.2 beta) is not a health check.**
  It reports the system model as available even while every inference request fails.
  Test health with a real request.
- **The `pcc` gate is contextual, not just versional.** `fm` refuses PCC outside
  Terminal.app ("not available in this context") — an agent's shell gets
  refused while the same command in Terminal.app proceeds. `fm serve` inherits the
  context it was launched from, so a proxy in front of an agent-launched `fm serve`
  cannot reach `pcc` either. Launch the stack from Terminal.app if you want to test it.
- **27.2 Beta 2 fixed the PCC entitlement check.** On `26B5091g`, `fm respond --model pcc`
  from Terminal.app answers. The history of the Beta 1 fault follows.
- **PCC `systemNotReady` on 27.2 Beta 1 was a broken entitlement check, not settling.**
  First read as the usual post-update settling, falsified by a log capture two hours
  later (`log stream --level debug --predicate 'subsystem == "com.apple.fm"'`, attempt
  from Terminal.app). The attempt clears the context gate and iCloud check (`User is
  signed into iCloud`), modelmanagerd resolves fm's use case
  (`Apple.Group1.AutomationTools.Zap.FMCLI`) off its distribution signature and finds
  the server asset bundle (`com.apple.fm.language.instruct_server_v2.fm_api`) — then
  fails: `CS_VALIDATION_CATEGORY_INVALID` for fm's pid, `SecTaskCopyValueForEntitlement
  failed ... with error`, concluded as `Client missing entitlement
  com.apple.modelmanager.inference`, session refused. The binary **is** entitled —
  `codesign -d --entitlements :- /usr/bin/fm` shows `com.apple.modelmanager.inference`
  `true` — so the daemon's runtime read of a valid Apple signature is what broke. The
  local model is unaffected: its bundle policy does not run this check. Deterministic,
  so waiting does nothing. **A full reboot on 2026-09-19 did not clear it** — that was
  the last plausible settling explanation, so it was a confirmed seed bug.
- **`com.apple.SensitiveContentAnalysisML error 15` is environmental.** It appears on a
  machine still settling after an OS update, and it clears itself: on the RC it cleared
  in about 20 to 30 minutes with no intervention. An experiment ruled out both the cyclic
  hang and an `fm serve` restart as causes. Wait before you investigate.
- **After a restart, the first request takes about 25 seconds** while the model reloads.

## Vision: how the on-device model encodes images

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
budget" below and `docs/clients.md`.

**Proxy feature sweep on Beta 5 (through the proxy, 12 checks):** non-streaming chat,
streaming chat, streaming usage relay, `stream`-omitted → JSON, structured output with
`$defs`, missing-description backfill, vision (`image_url`), CORS preflight,
`GET /v1/models`, `GET /health`, and fast non-retryable forced-`tool_choice` rejection
(154 ms) all pass. Only tool calling fails, and that is upstream.

> **Testing caution.** Once `fm serve` is poisoned (see `$defs` above), every later
> request fails with `com.apple.SensitiveContentAnalysisML error 15`,
> `LanguageModelError error -1`, or a hang — regardless of what you are testing.
> Those errors are a property of the server's state, not a verdict about the feature
> under test. Re-run a control that is known to pass before you trust any negative
> result. On the 27.0 builds a restart of `fm serve` clears the state. On 27.2 Beta 2 it
> does not, so wait until the control passes. An early Beta 5 run wrongly concluded that object `title`
> caused a hang; it passes on a clean server.
>
> The error 15 part of that caution did not reproduce on the 27.0 RC. A deliberate hang
> plus a restart returned a healthy server twice, and error 15 never followed. Either the
> link was specific to Beta 5, or the Beta 5 run hit the same environmental fault that the
> RC audit later traced to a settling machine. Treat error 15 as environmental first.

## Known limits

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
- The clean-room REPORT.md, item R6, is wrong. It claims `parallel_tool_calls` returns
  400. fm serve returns 200 and silently ignores the field. Live probes on the 27.0 RC
  confirmed this.
- `stop` is withheld from `fm serve`, which 400s on it, and applied by the proxy. Other
  sampling params (`temperature`, `top_p`, …) are passed through as-is; whatever
  `fm serve` supports applies.
- fm serve accepts `logprobs` and `top_logprobs` and ignores them. No logprob data
  exists to synthesize, so the proxy returns none.
- A union of two real types has no single form in the fm schema subset. The behaviour
  depends on how the client spells it. A `type` array, such as `["string","number"]`,
  collapses to its first member on both paths. An `anyOf` union collapses on the tool
  path, but the `response_format` path forwards it and fm serve returns a 400. Every
  collapse is lossy.
- The proxy does not decompress a gzip request body. No chat client sends one.

> Implementation note: the proxy buffers each request body and sets its own
> `Content-Length`, stripping any inbound/upstream `Transfer-Encoding` so a client that
> streams its upload (chunked) can't produce illegal `CL + TE` framing. Covered by
> `test/server.test.js`.

## Token usage

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

## Context budget

The window is 4096 tokens, and that is the whole budget. A 4045-token prompt passes and
about 4255 overflows on `system`. On 27.2, `pcc` has a window of about 32k, but only from
a Terminal.app context.

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

## Structured output (`response_format`)

`fm serve` honours OpenAI `response_format: {type:"json_schema", json_schema:{name,
schema}}`. It is undocumented, and the constrained decoding is real.

**The dialect rule.** `fm serve` requires its own keys — `title`, `x-order`, `required`,
`additionalProperties` — but only on object schemas reached through `$defs`: the `$defs`
entries themselves, and any object nested inside one, recursively, including array items.
The top-level schema and any object reached purely through inline `properties` nesting
need none. A missing key raises an error that names it, such as `keyNotFound 'x-order'`.

27.2 Beta 2 relaxed the rule. A `$defs` entry needs only `title`, which names the type,
and `required`. Without `title` the `400` names `undefinedReferences`. The 27.0 builds
still need all four keys.

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

Warning: a cyclic `$defs` has no finite inline form, and forwarding one can hang the
model service on 27.2 Beta 2 and earlier. On 26B123 it ties up the service for about 2
minutes instead. The proxy rejects it with `400` `cyclic_schema` before it opens an upstream
connection.
