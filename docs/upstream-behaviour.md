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
| Tool calling | Works natively. `tool_calls` is populated and `finish_reason` is `tool_calls`, on both paths. See "Tool calling". |
| Tool-call content | Clean under `auto`: 0 of 30 replies carried template markers or bare `{"tool_call": ...}` JSON. |
| `tool_choice: "none"` | Ignored. The reply still holds a call, as text with `<ctrl46>` markers (8 of 8). With no `tools` it answers in prose, tool history and all. The proxy removes the tools. |
| Forced `tool_choice` | Works natively on both paths, but routes worse than the proxy's translation among many tools. See "Tool calling". |
| Tool parameter `description` | Read by the model. A "YYYY-MM-DD" hint gave an ISO date 6 of 6 times; without it, 0 of 6. |
| Tool with no `function.description` | `400` for the whole request |
| `stream` omitted | Returns `text/event-stream`, not one JSON object |
| `n > 1` | `400 n=2 is not supported.` |
| `parallel_tool_calls` | Accepted, then ignored |
| `max_tokens` | Ignored. The proxy truncates. |
| Prompt framing | `hello world` is 57 `prompt_tokens` |
| Context window | 4096 tokens. 4008 passes, ~4150 overflows. |
| `$defs` entry with `title` and `required` | `200` in one to three seconds. Objects nested in the entry need no keys. |
| `$defs` entry with no `title` | `400` naming `undefinedReferences` |
| `$defs`, **cyclic** | A prompt that makes it recurse generates for about 2 minutes (114 s measured), then fails with `500` context exceeded. A control request passed 2 s later. |
| `#/definitions/` ref | `400` `undefinedReferences`. Only `$defs` resolves. |
| Optional nullable field, `anyOf:[{type:string},{type:null}]` | When the prompt does not mention the field, the model often generates without end and fails with `500` context exceeded after about 88 s. Seen 4/6, streaming and not. The same field as `{type:string}` failed 1/6. |
| Titled string schema | `400` unless it carries a non-empty `enum`. pydantic titles every field. |
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
| Tool calling, auto | A real `tool_call` on 26B123 (1 of 1) |
| Forced `tool_choice`, raw | A real `tool_call` on 26B123 (1 of 1) |
| Forced `tool_choice`, via proxy | A real `tool_call` with valid arguments |
| `n > 1` | `400`, as on `system` |
| `reasoning_effort` | Used. `low`, `medium`, and `high` are accepted; any other value 400s. The reasoning is hidden: `content` does not change and `reasoning_tokens` reads 0, but `completion_tokens` counts it. One prompt, twice each: none 11 tokens in 0.7 s, `low` 121 in 1.4 s, `high` 225 in 2.1 s. The proxy forwards it. On `system`, `fm serve` 400s the field, so the proxy removes it there. |

Caution: every `pcc` request uses the account's Private Cloud Compute quota. Keep probes
few, and check the `quota` object in `/health` before a long run.

### Tool calling

Measured 2026-10-27 on `26B123`, direct to `fm serve` unless stated.

| Check | Result |
|---|---|
| Auto, two prompts, one tool | 20 of 20 populated `tool_calls`. 0 markers, 0 bare JSON. |
| Auto, a prompt that needs no tool | Prose in 4 of 5. One reply called the tool. |
| Auto, two tools, a prompt that needs both | Two calls, each routed to the right tool |
| Auto, five tools, a prompt that needs `send_email` | `send_email` 1 of 10. `search_files` 7 of 10. |
| `parallel_tool_calls: false` | Ignored: the same prompt returned two calls |
| Round trip with a `tool` result message | `200`, a prose answer that uses the result |
| Auto, streaming | One `tool_calls` delta, then `finish_reason: tool_calls` |
| Through the proxy, auto, 10 JSON and 10 SSE | 20 of 20 real calls with valid JSON arguments. 0 leaks. |

**Forced calls go through a schema.** `fm serve` does forced calls natively, but the
proxy translates them into structured output instead, because the translation routes
better and costs fewer tokens. 10 requests per row:

| Forced case | Native: right tool, prompt tokens | Translation: right tool, prompt tokens |
|---|---|---|
| One tool | 10/10, 254 | 10/10, 111 |
| Two tools | 10/10, 305 | 10/10, 119 |
| Named function | 10/10, 254 | 10/10, 111 |
| Five tools | 2/10 to 5/10, 507 | 9/10, 142 |
| A prompt that needs two calls | two calls, 10/10 | one call, 10/10 |

`buildToolDispatch` turns each offered function into a property of one object schema,
built from the tool parameters after `fixToolSchema`. `tool_choice: "required"` offers
every tool and requires none of them, so any single key satisfies the schema. A named
function offers only that one and requires it. The request then carries no `tools` and
no `tool_choice`, only the schema and a short system instruction.
`dispatchToToolCalls` turns the reply back into OpenAI `tool_calls`.

**Auto is not translated.** Auto must be able to answer without calling a tool, so the
schema needs a prose escape. Given that escape, the model took it 0 of 25 times, even
when the prompt named the function.

A streaming client is served from a buffered reply. A dispatched reply is one JSON object
and cannot name a tool until it has arrived whole, so the proxy asks `fm serve` for a
non-streaming reply and synthesises the SSE frames. Arguments go out in 64-character
pieces, so a client that concatenates `function.arguments` across deltas gets valid JSON.

Caution: a forced call returns exactly one tool call, and it replaces a caller's own
`response_format`.

### Operational notes

- **`fm models` (renamed from `fm available` in the 27.2 beta) is not a health check.**
  It reports the system model as available even while every inference request fails.
  Test health with a real request.
- **The `pcc` gate is contextual, not just versional.** `fm` refuses PCC outside
  Terminal.app ("not available in this context") — an agent's shell gets
  refused while the same command in Terminal.app proceeds. `fm serve` inherits the
  context it was launched from, so a proxy in front of an agent-launched `fm serve`
  cannot reach `pcc` either. Launch the stack from Terminal.app if you want to test it.
- **`com.apple.SensitiveContentAnalysisML error 15` is environmental.** It appears on a
  machine still settling after an OS update, and it clears itself: on the RC it cleared
  in about 20 to 30 minutes with no intervention. An experiment ruled out both the cyclic
  hang and an `fm serve` restart as causes. Wait before you investigate.
  On 26B123 it cleared in under a minute after a stack start, and in about 8 minutes
  after repeated runaway generations. A 15 s retry does not help, so the proxy returns
  it at once as `server_error` / `model_service_unavailable`.
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

> **Testing caution.** If several unrelated checks fail at once, suspect the model
> service, not the feature under test. A cyclic `$defs` ties it up for about 2 minutes,
> and a machine that is still settling after an OS update fails every request with
> `com.apple.SensitiveContentAnalysisML error 15`. Re-run a control that is known to pass
> before you trust a negative result.

## Known limits

- Tool-parameter **nested** schemas decode natively at every depth, `array<array<object>>`
  included.
- `n > 1` is rejected: `400 "n=3 is not supported. Only a single completion per request
  is implemented."` The proxy types the 400 as `invalid_request_error` and does not
  retry it.
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

**What `fm serve` needs.** A `$defs` entry needs a `title`, which names the type, and
`required`. Without `title` the `400` names `undefinedReferences`. A `#/definitions/`
ref does not resolve at all.

Two shapes to avoid:

- A `title` on a string schema makes it a named string type, which then requires a
  non-empty `enum`. pydantic puts a `title` on every field.
- A `$ref` that points at a non-object `$defs` entry, such as an array wrapper defined
  directly under `$defs`, fails with `undefinedReferences`. Keep array wrappers inline
  and put only the referenced object type in `$defs`. Real generators already do this.

**The proxy handles all of it.** `fixResponseFormatSchema` resolves every `$ref` into
`$defs` or `definitions` inline, drops both tables, and removes `title` from every node
that is not an object. A ref that does not resolve is forwarded, and `fm serve` names it
in its `400`. This matters because pydantic, zod-to-json-schema, and TypeBox all emit
refs for named types, and pydantic titles every field.

**Nullable unions.** An optional field typed `anyOf:[X, {type:"null"}]`, which pydantic
emits for `Optional[X] = None`, makes the model run away when the prompt gives no value
for it. The reply grows until the context is exceeded, about 88 s later. The proxy
collapses such a union to `X` and drops a `default: null`. Through the proxy, the same
pydantic schema failed 1 time in 11 streaming requests, against 4 in 6 before. Repeated
runaways can leave the model service failing with
`com.apple.SensitiveContentAnalysisML error 15` for about 8 minutes.

Warning: a cyclic `$defs` has no finite inline form, and forwarding one ties up the model
service for about 2 minutes. The proxy rejects it with `400` `cyclic_schema` before it
opens an upstream connection.
