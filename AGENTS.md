## Project direction

The **`fm-proxy.js`** path is the primary, supported way to do tool calling + PCC with
Pi/Opencode (see runbook below). It sits in front of Apple's entitled `fm serve` and
speaks the OpenAI Chat Completions dialect. (An earlier in-process Swift `fms` app was
explored but removed: it could not do PCC because of the Apple-private entitlement
`com.apple.modelmanager.inference`, grantable only to Apple-signed binaries. As these
are early betas, Apple may lift the entitlement gate — worth rechecking periodically.)

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

| What | How | Beta 2 value | Beta 3 value | Beta 4 value |
|---|---|---|---|---|
| fm source version | `otool -l /usr/bin/fm \| grep -A2 LC_SOURCE_VERSION` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` |
| Framework version | `plutil -p /System/Library/Frameworks/FoundationModels.framework/Resources/Info.plist \| grep CFBundleVersion` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` |
| Runtime version | `codesign -dvvv /usr/bin/fm` → `Runtime Version=` | `27.0.0` | `27.0.0` | `27.0.0` |
| Rebuild date | `ls -la /usr/bin/fm` (mtime) | Jun 19 2026 | Jul 3 2026 | Jul 17 2026 |
| macOS build | `sw_vers` → `BuildVersion` | `26A5368g` (27.0 Beta 2) | `26A5378j` (27.0 Beta 3) | `26A5388g` (27.0 Beta 4) |

Audit recipe after any OS update:
1. **Structure** — `python3 tools/gen-fm-docs.py --outdir /tmp/fmnew` then
   `diff docs/fm-reference.md /tmp/fmnew/fm-reference.md`. (Beta 2: byte-identical to Beta 1.
   Beta 3: **changed** — "JSON schema" wording → "structured output schema" throughout, and
   `fm schema object --help`'s USAGE examples now show a `--nested <name>` flag. That flag
   does **not** actually exist (`Unknown argument: --nested`); the OPTIONS list still
   documents the real, working flag `--object <name>`. Treat this as a bug in Apple's help
   text, not a rename — keep using `--object`.)
2. **Behavior** — the help tree can stay identical while behavior changes (or vice versa,
   per Beta 3), so re-test the known walls separately:
   - nested-schema `duplicateType` — **FIXED in Beta 3**, for both `response_format`
     (verified via `fm respond --schema` and `response_format` json_schema over
     `/v1/chat/completions`, using a real `$defs`/`$ref` nested schema) and **tool
     parameters** (verified directly: nested object, array<object>, object-in-object,
     object → array → object all decode correctly through `tools`/`tool_calls`). Was
     broken Beta 1–2. Two shapes remain broken on the tool-parameter path even in
     Beta 3 — see "Nested params" below.
   - `response_format` `required`-array / `title`+`x-order` dialect — still enforced, but
     narrower than originally thought: only for object schemas reached through `$defs`,
     not "every object level" (flat and inline-nested schemas need none of it — see
     "Structured output" below). `fm-proxy.js` now injects the dialect into `$defs`
     automatically. Tool parameters, by contrast, need **no** title/x-order dialect at all.
   - non-streaming `usage.prompt_tokens` — **FIXED in Beta 3.** Verified live against
     `fm token-count`: values now match exactly (was hardcoded `0`). Streaming still
     sends no `usage` at all — unchanged, still needs the proxy's fill-in.
   - on-device `system` model actually running inference — healthy again in Beta 3 (Beta 2
     was flaky right after update — see Known limits).

Beta 4 (26A5388g, fm 2.0.62.1.402) audit results, 2026-07-21:
- **`fm token-count` renamed `fm count-tokens`** — the old name hard-errors
  (`Unknown command`). `fm-proxy.js`'s `fmTokenCount` probes `count-tokens` first and
  falls back to `token-count` (Beta 3 compat), remembering whichever works.
- `--load-transcript` renamed `--resume`; new repeatable `--tool` flag on
  `respond`/`count-tokens` enabling built-in `barcode` and `ocr` tools, with `--label`
  to name `--image` inputs.
- **PCC attribution tightened: Terminal.app specifically, not just any foreground TTY**
  (see the runbook note below). Foreground panes in other terminal hosts (herdr) that
  worked on Beta 3 are now refused; the error says "Please use the Terminal app."
- **3+-chained-object tool params FIXED** (was a `$defs`-leak, round-tripped since
  Beta 3) — verified 5/5 on `system` + `pcc`, incl. a 4-level chain. The round-trip now
  triggers ONLY for `array<array<object>>`.
- **`array<array<object>>` failure mode changed**: native now hard-errors
  `500 "Failed to parse generated content."` (Beta 3 silently omitted the argument).
  The old round-trip prose ("JSON string matching:") deterministically provoked the
  SAME 500 (model emits raw JSON in the string slot; Beta 4's parser rejects it) — the
  prose now demands "a quoted JSON string, not raw JSON", which is mechanically
  reliable (4/4) though content quality for this shape remains a model limitation
  (e.g. HTML-entity-mangled quotes, which `expandToolCallArguments` now decodes).
- New `classifyError` branch: `"Failed to parse generated content"` is deterministic
  (5/5) → `server_error`/`generation_parse_failed`, `retry:false` (was retrying the
  full ~35s backoff ladder).
- **Chat template overhead grew ~150 tokens**: the same one-line message that framed
  to 57 `prompt_tokens` on Beta 3 frames to ~208 on Beta 4 (system and pcc alike).
  Tokenizer itself unchanged (`count-tokens` values identical). Budget accordingly
  against the ~32k PCC ceiling.
- **PCC now reports real prompt caching** — `prompt_tokens_details.cached_tokens` is
  non-zero on repeat prompts (was always 0). Pure passthrough; nothing to fix.
- Unchanged from Beta 3 (all reverified live): `tool_choice:"required"` still crashes
  `system` (pcc fine); missing `function.description` still 400s; `response_format`
  `$defs` dialect still required (error now names the offending path); streaming usage
  still requires `stream_options.include_usage:true` (proxy still forces it);
  `parallel_tool_calls` still ignored; CORS preflight-yes/request-403 split unchanged.

## Tool calling with Pi (PCC + rich schemas) — runbook

An in-process app cannot do PCC inference (it's gated on the Apple-private entitlement
`com.apple.modelmanager.inference`, which fails with `ModelManagerError 1046` for any
binary not signed by Apple). To get tool calling + PCC's 32k context working
with Pi/Opencode, proxy through Apple's own entitled `fm serve`:

```
Pi  ──▶  fm-proxy.js (:1977)  ──▶  Apple `fm serve` (:1976)
         flattens tool schemas      entitled engine: system + pcc, runs tools
```

Apple's `fm serve` has some remaining JSON-Schema gaps for tool parameters (root
`required` must be present; no `anyOf/allOf/oneOf/$ref/$defs/patternProperties`).
`fm-proxy.js` rewrites incoming tool schemas so Pi's rich definitions are accepted.

**Every tool needs a non-null `function.description`, even a no-argument tool.**
Verified live (Beta 3 / fm 2.0.59): `fm serve` 400s the **entire** request —
`"Invalid JSON: The data couldn't be read because it is missing."` — if *any* tool
in the array has `function.description` absent or `null`, regardless of that tool's
`parameters` shape, `tool_choice`, or which tool the model actually ends up calling.
An empty string (`""`) is accepted. This was originally misdiagnosed as an
empty-`parameters.properties` bug (a no-arg tool naturally invites a minimal test
schema that also omits `description`), but a non-empty-schema tool with no
description hits the identical 400, and a no-arg tool *with* a description (even
`""`) works fine — so the real trigger is the missing description key, unrelated to
parameter shape. OpenAI's tool-calling spec makes `description` optional, so a
compliant client can legitimately send the shape that breaks `fm serve`.
`fm-proxy.js`'s `fixTools` backfills a missing/null `function.description` to `""`
before forwarding, so client-supplied no-description tools (common for simple
no-argument actions) work transparently instead of erroring.

**Nested objects and array-of-objects decode natively as of macOS 27 Beta 3 (fm
2.0.59), and object chains of ANY depth as of Beta 4 (fm 2.0.62).** The
`GenerationSchema duplicateType` bug that used to force every nested object through
a JSON-string round-trip is fixed, and Beta 4 also fixed the 3+-chained-object
`$defs` leak (verified live 5/5, system + pcc, incl. a 4-level chain). ONE shape is
**still broken**, verified live and narrowly detected by `needsJsonRoundTrip`:
- `array<array<object>>` (an object reached through 2+ consecutive array wrappers)
  — Beta 4 hard-errors `500 "Failed to parse generated content."` (Beta 3 silently
  omitted the argument). `array<array<number>>` (primitive leaf) is fine.

Only that residual shape still uses the JSON-string round-trip: the param is
declared to fm as a `type:"string"` whose description says "… A JSON-encoded string
value (must be a quoted JSON string, not raw JSON) matching: {schema}" — the
"quoted, not raw" wording is load-bearing on Beta 4, whose parser rejects raw JSON
in a string slot (the old phrasing deterministically provoked that) — the model
returns JSON in that string, and the proxy re-parses it back into the real
object/array in the tool_call's `arguments` before forwarding to Pi (including a
one-shot HTML-entity decode for the model's occasional `&quot;`-mangled output).
Content quality for this exotic shape is best-effort — a model limitation
regardless of encoding, not a proxy bug. The embedded schema is stripped of decorative keys fm ignores (`description`
on nested fields, `title`, `examples`, `default`, `$id`, …) before serialization —
pure token savings with no loss of shape. See `EMBED_STRIP_KEYS` / `STRIP_KEYS` /
`needsJsonRoundTrip` in `fm-proxy.js`.

### Start it (from Terminal.app signed into Apple Intelligence — PCC needs the attribution)

**One command (recommended):** `fm-launch.sh` starts the proxy (backgrounded), then runs
`fm serve` in the **foreground** (it blocks the terminal). It prints `stack up …` once
fm serve is healthy:

```bash
./fm-launch.sh            # quiet: startup + proxy errors/warnings only
./fm-launch.sh --verbose  # also shows the proxy's per-request [assembled] telemetry
```

> **fm serve must run in the foreground, and as of Beta 4, inside Terminal.app
> specifically.** On Beta 3, any foreground TTY-attached `fm serve` (including panes in
> other terminal hosts like herdr) got PCC attribution. **Beta 4 tightened this**: the
> same foreground pane in a non-Terminal host is refused with `"Private Cloud Compute
> is not available in this context. Please use the Terminal app."` (HTTP 503) while a
> `fm serve` launched inside real Terminal.app works (verified live, both directions,
> same build). Backgrounding — the old node launcher (`zsh → node → fm`), or a shell
> `&` — still strips attribution too, even from Terminal.app. `system` keeps working in
> every context. See memory `launcher-breaks-pcc-attribution`.
> So: run the launcher in a Terminal.app window; it foregrounds `fm serve` and
> backgrounds the proxy (which only forwards, no PCC needed). `fm available` is a
> one-shot that keeps PCC in every context, so it's a poor predictor of `fm serve`'s
> attribution — don't use it to validate a launcher.

Use **Ctrl-C to stop** — the trap on INT/TERM/HUP/EXIT reaps the proxy. Do **not**
Ctrl-Z: a suspended foreground `fm serve` isn't reaped and will strand the port
(`kill -9` the `fm serve` PID to recover). fm serve's own output is untagged (piping it
is untested for attribution safety); only the proxy's output is tagged.
Errors/retries/overflows are **always** shown even without `--verbose`, as is the
per-completion **`[toks]` throughput counter** (`out=… dur=… ttft=… => N.N tok/s` —
completion tok/s with time-to-first-token for streaming); only the routine
`[assembled]` per-request telemetry is hidden. Ports/binary are overridable: `--fm-port`,
`--proxy-port`, `--fm-bin`, `--health-timeout` (or the `FM_PORT`/`PROXY_PORT` env vars).

**Manual (two tabs)**, if you want the processes separated:

```bash
# tab 1 — Apple's entitled engine (does the inference, incl. PCC):
/usr/bin/fm serve --port 1976

# tab 2 — the schema-flattening proxy (where Pi points):
node fm-proxy.js          # listens on :1977, forwards to :1976
```

Point Pi's " FM" provider `baseUrl` at `http://127.0.0.1:1977/v1`. Both `system` and
`pcc` work; `pcc` gives the 32k context. Verified: multi-tool calls with real side
effects (`pi-minimal --model pcc -p "create a file ..."` writes + reads it back).

## OpenAI-compatible usage (plug-and-play base URL)

The proxy is a drop-in OpenAI endpoint — point any OpenAI client at it and go:

- **Base URL:** `http://127.0.0.1:1977/v1`
- **API key:** any non-empty dummy string (e.g. `sk-local`). It's loopback-only; the
  key is ignored, not validated, but most SDKs refuse to start without *some* key set.
- **Endpoints:** `POST /v1/chat/completions` (translated), `GET /v1/models` and
  `GET /health` (passed straight through to `fm serve`). Models are `system` and `pcc`.
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
  preflight), so browser-based clients connect directly.
- **Errors:** returned as OpenAI-shaped objects — `{"error":{"message","type","code"}}`.
  The proxy **classifies** fm serve's distinct failure modes so clients can branch on
  `type`/`finish_reason` instead of string-matching Apple's prose:
  - **Safety-guardrail abort** → **`finish_reason:"content_filter"`** (NOT an error). The
    model emits valid output, then fm serve interrupts (`"The model's safety guardrails
    were triggered."`). OpenAI-idiomatic: the proxy keeps any partial text already
    streamed and ends the completion with `finish_reason:"content_filter"` — so SDK
    clients receive the partial + a documented finish_reason instead of an exception.
    Deterministic + terminal (retrying the identical request re-fails identically), so
    don't retry; change the request (rephrase, simplify, or switch to `model=system`).
    Benign code triggers it — it is **not** a judgment that your content is unsafe.
    PCC-only; `system` is unaffected.
  - `type: "service_unavailable"` (`code: "model_unavailable"`) — `"PCC inference is not
    available in this context"` (ModelManagerError 1013, HTTP 503): PCC attribution is
    missing. Terminal — usually means `fm serve` isn't a direct child of your
    Apple-Intelligence Terminal (see the launcher note above). `system` still works.
  - `type: "rate_limit_exceeded"` (`code: -1`) — PCC capacity/rate-limit
    (`LanguageModelError -1`), transient. The proxy retries these with backoff before
    surfacing; if you still see one, back off and retry.
  - `type: "invalid_request_error"` (`code: "tool_choice_unsupported"`) — `model:"system"`
    with a forced `tool_choice` (`"required"`, or a specific `{type:"function",...}`
    pin) crashes fm serve's `system` engine with the *identical* `LanguageModelError -1`
    signature used for PCC rate-limiting. Deterministic and permanent (retrying re-fails
    identically), so the proxy checks the original request and does **not** retry it —
    without this check it would retry-loop a permanent bug for ~19.5s before surfacing it
    mislabeled as `rate_limit_exceeded`. `pcc` handles forced `tool_choice` fine; switch
    models or use `tool_choice:"auto"`/omit it to work around this on `system`.
  - `type: "server_error"` (`code: "internal_error"` / `"upstream_unreachable"`) —
    anything else, including the `502` when `fm serve` is down.

### Known limits

- Tool-parameter **nested** schemas decode natively as of Beta 3 (any object-chain
  depth as of Beta 4), except `array<array<object>>` — still broken upstream
  (Beta 4: hard `500 "Failed to parse generated content."`) and still round-tripped,
  best-effort (see "Nested params" above). `response_format` nested schemas get
  `$defs` dialect injection only — see "Structured output" below.
- `n > 1` (multiple choices) is not honored — fm serve returns a single completion.
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
- Sampling params (`temperature`, `top_p`, `stop`, …) are passed through as-is; whatever
  `fm serve` supports applies.

> Implementation note: the proxy buffers each request body and sets its own
> `Content-Length`, stripping any inbound/upstream `Transfer-Encoding` so a client that
> streams its upload (chunked) can't produce illegal `CL + TE` framing. Covered by the
> integration tests in `fm-proxy.test.js`.

### Token usage repair

Apple's `fm serve` used to report usage wrong on both paths — non-streaming sent
`prompt_tokens: 0`, streaming sent no `usage` at all. **As of Beta 3 (fm 2.0.59),
non-streaming is fixed**: verified live against `fm token-count`, the reported
`prompt_tokens` now matches exactly, and it already reflects the **full assembled**
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
both accurate. The old completion-text-based estimate (via `fm count-tokens` — renamed
from `token-count` in Beta 4; the proxy probes both names — with a `9 + chars/4.4`
heuristic fallback) survives only as a fallback for upstreams that don't cooperate —
e.g. a pre-Beta-3 `fm serve`, or a safety-guardrail abort that never reaches a clean
finish and so never gets a real usage chunk from fm serve either.

Note (Beta 4): the chat template's fixed framing grew ~150 tokens — a one-line message
that assembled to 57 `prompt_tokens` on Beta 3 now assembles to ~208. Passthrough for
the proxy (fm serve's own numbers), but it shrinks the usable slice of PCC's ~32k
window, and the `[assembled]` gauge (which counts raw text, not serve's template)
under-counts by correspondingly more.

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

### Context budget — why Pi's gauge lies, and PCC's real ceiling

PCC's context window is **~32,768 tokens** (empirically bracketed 32,735 ok / 33,116
"transcript exceeded the model's context size"). The gauge Pi shows
(`countPromptTokens`) counts **only `messages[].content`** — it deliberately omits three
things fm serve *does* frame into the prompt, so the gauge reads far lower than reality:

- **tool schemas** — a flat tax present from turn 1 (a full Pi toolset measured ~11k+;
  `pi-minimal` drops it to ~500). Constant per request, independent of conversation length.
- **assistant `tool_calls`** — live in `m.tool_calls`, never in `content`; cumulative,
  grows as tool calls accumulate in the replayed transcript.
- **per-turn template framing** — applied per turn by fm serve; the gauge collapses it to one.

`fm-proxy.js` logs the real assembled size to **stderr** every request:

```
[assembled] req model=pcc turns=N gauge(msgs)=… tools=… toolCalls=… perTurn=… => assembled=…
```

and flags the failing request (`*** CONTEXT EXCEEDED ***`, `*** UPSTREAM STREAM ABORTED ***`).
Note: `tools=` *under*-counts fm serve's true per-tool framing (it counts raw JSON; fm adds
scaffolding), so with a fat toolset the real prompt is even bigger than `assembled` shows —
which is why a full toolset can fail while the gauge looks comfortable. This under-count
only affects the **streaming** gauge now — non-streaming gets fm serve's own real
`prompt_tokens` (see "Token usage repair" above), which already reflects the true
framing cost. **Keep tools lean** (`pi-minimal`) to reclaim most of the 32k window. The
`system` model (separate, smaller on-device window) is useful as a *free local
compactor* of old turns before they hit PCC — not as overflow storage.

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
