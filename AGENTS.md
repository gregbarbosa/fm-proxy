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

## Tool calling with Pi (PCC + rich schemas) — runbook

An in-process app cannot do PCC inference (it's gated on the Apple-private entitlement
`com.apple.modelmanager.inference`, which fails with `ModelManagerError 1046` for any
binary not signed by Apple). To get tool calling + PCC's 32k context working
with Pi/Opencode, proxy through Apple's own entitled `fm serve`:

```
Pi  ──▶  fm-proxy.js (:1977)  ──▶  Apple `fm serve` (:1976)
         flattens tool schemas      entitled engine: system + pcc, runs tools
```

Apple's `fm serve` has very limited JSON-Schema support for tool parameters (flat only:
no nested `type:"object"`, no array-of-objects, no `anyOf/allOf/oneOf/$ref/$defs/
patternProperties`; root `required` must be present). `fm-proxy.js` rewrites incoming tool
schemas so Pi's rich definitions are accepted.

**Nested params use a lossless JSON-string round-trip.** A param fm can't represent
(nested object, or array whose items are objects — e.g. Pi's `edit` tool with
`edits: [{oldText, newText}]`) is declared to fm as a `type:"string"` whose description
says "… JSON string matching: {schema}". The model returns JSON in that string, and the
proxy re-parses it back into the real object/array in the tool_call's `arguments` before
forwarding to Pi — so the client sees the exact nested shape its tool validates against.
Flat tools (e.g. `write`) pass through untouched.

The embedded schema and every property are stripped of decorative keys fm ignores
(`description` on nested fields, `title`, `examples`, `default`, `$id`, …) before
serialization — pure token savings (~31% on a sample nested tool, 177→122 tokens via
`fm token-count`) with no loss of shape. See `EMBED_STRIP_KEYS` / `STRIP_KEYS` in
`fm-proxy.js`.

### Start it (from a Terminal signed into Apple Intelligence — PCC needs the attribution)

**One command (recommended):** `fm-launch.sh` starts the proxy (backgrounded), then runs
`fm serve` in the **foreground** (it blocks the terminal). It prints `stack up …` once
fm serve is healthy:

```bash
./fm-launch.sh            # quiet: startup + proxy errors/warnings only
./fm-launch.sh --verbose  # also shows the proxy's per-request [assembled] telemetry
```

> **fm serve must run in the foreground.** macOS only grants PCC attribution to a
> **foreground, TTY-attached** `fm serve`. Backgrounding it — the old node launcher
> (`zsh → node → fm`), or a shell `&` — makes every `pcc` request fail with
> `ModelManagerError 1013` / `"not available in this context"` (HTTP 503) while `system`
> keeps working. A bash intermediary is fine; **foreground vs backgrounded is the
> decisive line** (probed exhaustively — see memory `launcher-breaks-pcc-attribution`).
> So the launcher foregrounds `fm serve` and backgrounds the proxy (which only forwards,
> no PCC needed). `fm available` is a one-shot that keeps PCC in every context, so it's a
> poor predictor of `fm serve`'s attribution — don't use it to validate a launcher.

Use **Ctrl-C to stop** — the trap on INT/TERM/HUP/EXIT reaps the proxy. Do **not**
Ctrl-Z: a suspended foreground `fm serve` isn't reaped and will strand the port
(`kill -9` the `fm serve` PID to recover). fm serve's own output is untagged (piping it
is untested for attribution safety); only the proxy's output is tagged.
Errors/retries/overflows are **always** shown even without `--verbose`; only the routine
per-request telemetry is hidden. Ports/binary are overridable: `--fm-port`,
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
  - `type: "server_error"` (`code: "internal_error"` / `"upstream_unreachable"`) —
    anything else, including the `502` when `fm serve` is down.

### Known limits

- Tool/`response_format` **nested** schemas are flattened or JSON-string round-tripped;
  fm serve's constrained decoder can't enforce nested shapes natively yet (see
  "Structured output" below).
- `n > 1` (multiple choices) is not honored — fm serve returns a single completion.
- Sampling params (`temperature`, `top_p`, `stop`, …) are passed through as-is; whatever
  `fm serve` supports applies.

> Implementation note: the proxy buffers each request body and sets its own
> `Content-Length`, stripping any inbound/upstream `Transfer-Encoding` so a client that
> streams its upload (chunked) can't produce illegal `CL + TE` framing. Covered by the
> integration tests in `fm-proxy.test.js`.

### Token usage repair

Apple's `fm serve` reports usage wrong: non-streaming sends `prompt_tokens: 0`, and
streaming sends no `usage` at all — so Pi's context gauge sits at ~0%. The proxy repairs
this using Apple's own `fm token-count` (exact, same tokenizer family):

- **non-streaming:** overwrite `prompt_tokens` with the exact count of the request
  messages (system → `-i` instructions, rest → prompt via stdin).
- **streaming:** suppress the upstream `[DONE]`, accumulate completion text from the
  deltas, then inject a final `usage` chunk (exact prompt + exact completion) followed by
  a single `[DONE]`.

A `9 + chars/4.4` heuristic is the fallback if `fm token-count` is unavailable.

The reported `prompt_tokens` is the **full assembled** total (messages + tool schemas
+ tool_calls + per-turn framing), so Pi's gauge reflects the real ~32k budget rather
than the messages-only slice that read ~4x low. Set `GAUGE_MODE=msgs` to revert to the
messages-only number. Also set Pi's FM provider context size to **32768** so the gauge
*percentage* scales correctly.

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
which is why a full toolset can fail while the gauge looks comfortable. **Keep tools lean**
(`pi-minimal`) to reclaim most of the 32k window. The `system` model (separate, smaller
on-device window) is useful as a *free local compactor* of old turns before they hit PCC —
not as overflow storage.

### Structured output (`response_format`) — partial, recheck later

fm serve honors OpenAI `response_format: {type:"json_schema", json_schema:{name, schema}}`
(undocumented; constrained decoding is real). Its dialect needs `title` + `x-order` on
every object level (same as `fm schema object`). **Flat schemas work; nested objects
currently fail** with `GenerationSchema duplicateType` — the same nesting wall as the tool
path. So it can't yet replace the JSON-string round-trip for nested params; it's usable for
flat params and terminal structured answers.

To recheck after an fm update: send a `response_format` request with a two-level nested
schema (e.g. an object with a property whose type is also an object). If the response comes
back decoded rather than erroring with `GenerationSchema duplicateType`, the bug is fixed —
at that point the JSON-string round-trip for nested tool params can be replaced with native
constrained decoding end-to-end.
