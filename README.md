# fm-proxy

> [!CAUTION]
> ## Read this before you use `fm-proxy`
>
> macOS 27.0 **Beta 5** (`fm` 2.0.68) added a legal notice that you must accept
> before the `fm` CLI runs at all. Run `sudo fm license` to see it. It says:
>
> > BY USING THE APPLE FOUNDATION MODELS CLI, YOU ARE AGREEING TO BE BOUND BY THE
> > TERMS OF THE APPLICABLE SOFTWARE LICENSE AGREEMENT FOR macOS AT
> > https://www.apple.com/legal/sla/. **YOU ARE ALSO AGREEING TO NOT
> > PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH APPLE SOFTWARE OR
> > SERVICES EXCEPT AS EXPRESSLY PERMITTED.**
>
> **`fm-proxy` programmatically accesses Apple models.** That is its only
> function. Apple does not publish a list of permitted uses, so we cannot show
> that this tool is inside the exception. Read plainly, this tool conflicts with
> the terms you accept when you run `sudo fm license`.
>
> **Use `fm-proxy` at your own risk.** You accept the license, so the decision and
> the consequences are yours. Do not use this tool in a product, in a commercial
> deployment, or anywhere the terms apply to more than you. If you want the
> supported path, use the [Foundation Models framework][fmf] from a signed app.
>
> This notice appeared in Beta 5. Earlier betas had no equivalent clause.

[fmf]: https://developer.apple.com/documentation/foundationmodels

**An OpenAI-compatible API endpoint for the Apple Foundation Models CLI (`fm`).**

macOS 27.0 ships a beta `fm` CLI to run Apple Foundation Models
on-device (`system`) and on Apple's Private Cloud Compute (`pcc`). It includes a Chat Completions local server (`fm serve`), but it departs from the OpenAI spec in ways that break ordinary clients: it streams when you did not ask it to, it rejects schema shapes every generator emits, and it reports streaming token usage only behind an opt-in flag most clients never set.

`fm-proxy` sits in front of `fm serve` to give you an **OpenAI-compatible Chat Completions endpoint**. Point any OpenAI client at the local URL and use Apple's models with no code changes.

> ⚠️ **Beta.** This is built on macOS 27.0 **beta** so expect breaking changes with system updates.

> [!WARNING]
> **Tool calling is broken in Beta 5 (`fm` 2.0.68), upstream.** `fm serve` no
> longer converts the model's tool call into a `tool_calls` field. It returns
> `tool_calls: null` with `finish_reason: "stop"`, and leaks the raw control
> tokens into the message content (for example
> `"<ctrl46>get_time<ctrl46>"`). The model still emits the call correctly — the
> parser in `fm serve` does not read it. This happens with or without the proxy,
> on streaming and non-streaming requests, so `fm-proxy` cannot repair it.
> **Both engines are affected** — `pcc` returns an empty completion instead of
> leaked tokens, so switching model does not work around it. Tool calling works
> again if you stay on Beta 4.
>
> **This fails silently and produces wrong answers.** Asked to read a file
> containing `BETA5_CANARY_9F3A`, the model emitted a correct tool call, `fm serve`
> failed to parse it, and the model then answered that the file contained `hello`.
> The tool never ran. A client gets a confident, fabricated result rather than an
> error. Do not use tool calling on Beta 5 for anything you intend to trust.

> [!NOTE]
> **`$defs` schemas break `fm serve` on Beta 5 — the proxy works around it.** Sent
> straight to `fm serve`, a `response_format` schema using `$defs`/`$ref` either 400s
> (no dialect) or, with the dialect Beta 3/4 required, **hangs forever and leaves the
> server unable to answer anything until it is restarted**. The proxy now inlines
> `$ref`s and drops `$defs` entirely, so your schema reaches `fm serve` as plain
> inline nesting, which it handles fine. Verified on Beta 5: 3/3 in ~1.2s on
> `system` and `pcc`, with no poisoning. Use the proxy for `$defs` schemas; do not
> hand them to `fm serve` yourself.

## What it includes

- **Chat completions** — streaming and non-streaming.
- **Tool / function calling — currently unusable on Beta 5, see the warning above.** The
  proxy still accepts standard OpenAI `tools` and repairs the schemas (it backfills a
  missing `description`, which `fm serve` 400s on, and round-trips the one shape verified
  broken upstream, `array<array<object>>`). But `fm serve` no longer turns the model's
  tool call into `tool_calls`, so none of that reaches a client today. The schema repairs
  are kept, and covered by tests, so the feature returns the moment Apple fixes the
  parser — but they cannot be re-verified end-to-end until then.
- **Fixed structured output** — `response_format: {type:"json_schema",...}` works with plain, undecorated OpenAI/pydantic-style schemas, including the `$defs`/`$ref` shape virtually every real schema generator emits. `fm serve` cannot handle `$defs` on Beta 5 at all (400 without its dialect, an indefinite hang with it), so the proxy resolves the `$ref`s inline and drops `$defs` before forwarding. The result is plain inline nesting, which `fm serve` handles natively and which needs no dialect keys. Self-referencing schemas cannot be inlined, so those fall back to the dialect.
- **Corrected non-streaming default** — Beta 5 returns `text/event-stream` for a chat
  request that omits `stream`, where the OpenAI spec (and every earlier build) returns
  one JSON object. Most OpenAI SDKs omit the field, so they got a body they could not
  parse. The proxy sends an explicit `stream:false` upstream when the client did not
  ask to stream, which restores the documented behaviour.
- **Fixed token counts** — `fm serve`'s non-streaming responses report real `prompt_tokens` and are passed through untouched. The proxy corrects the streaming path and the gauge: on Beta 5 `fm count-tokens` drops the conversation framing when no system message is present, landing a flat 54 tokens low, which the proxy adds back. Streaming responses only get real usage when the request opts in via `stream_options.include_usage:true`, which real clients rarely set, so the proxy forces that flag upstream on every streaming request and relays fm serve's own real usage back — falling back to a computed estimate only if an upstream ignores the flag entirely.
- **Throughput counter** — every completion logs a one-line `[toks]` report (`out=… dur=… ttft=… => N.N tok/s`). Not gated behind `--verbose`, so it shows in quiet mode; this is the per-request generation-speed counter.
- **Added vision support** — standard `image_url` content parts with base64 data URLs.
- **Enabled CORS** — Browser-based clients can connect directly.
- **OpenAI-shaped errors** — failures come back typed (`rate_limit_exceeded`, `service_unavailable`) so clients can branch on the cause. A mid-stream safety filter abort ends the completion as `finish_reason:"content_filter"` with any partial output preserved (no exception thrown).

Includes the native `GET /v1/models` and `GET /health` endpoints as straight passthroughs to `fm serve`.

## Requirements

- **You must accept the CLI license first.** On Beta 5 and later, run `sudo fm license`
  and answer `yes`. Until you do, every `fm` subcommand exits 69 and the proxy falls
  back to estimated token counts. The acceptance applies to every user on the machine.
  Read the caution at the top of this file before you accept.
- **macOS 27.0 Beta 5** (fm/FoundationModels **2.0.68**; ships with the `fm` CLI baked in).
  This targets Beta 5 only. Earlier betas are no longer supported, and the compatibility
  fallbacks they needed have been removed — the token counter no longer probes the
  pre-Beta-4 `token-count` name, and the error classifier no longer reads a forced
  `tool_choice` crash out of Beta 3/4's `LanguageModelError -1`. On an older build the
  proxy will still run, but token counts fall back to estimates and the forced
  `tool_choice` rejection is retried instead of failing fast. Check your build with
  `otool -l /usr/bin/fm | grep -A2 LC_SOURCE_VERSION` (see `AGENTS.md` for the full
  fingerprinting recipe).
- **Signed in with your Apple Account** and Apple Intelligence enabled.
  - The `pcc` model runs on Private Cloud Compute and needs that you to be signed in.
  - The `system` model is available locally.
- **Node.js** (v18+). The proxy uses only Node's standard library, no `npm install`.

## Quick start

Starts the proxy, then runs `fm serve` in the foreground:

```bash
./fm-launch.sh
```

When it prints `stack up — OpenAI base URL: http://127.0.0.1:1977/v1`, you're good to go.

> **fm serve must run in the foreground, inside Terminal.app specifically.** macOS only grants PCC (Private Cloud Compute) attribution to a foreground `fm serve` hosted by the real Terminal app; other terminal emulators' panes are refused with `"Please use the Terminal app"` (HTTP 503). Backgrounding it, under node, or with a shell `&` also strips attribution. Still true on Beta 5, re-verified. `system` keeps working in every context.
>
> The launcher runs `fm serve` in the foreground (blocking the terminal it was launched in) and the proxy as
> a backgrounded child. **Use Ctrl-C to stop** (it reaps the proxy); don't Ctrl-Z — a
> suspended `fm serve` won't be cleaned up and will strand the port.

## Connecting to the endpoint

Point any OpenAI client at:

- **Base URL:** `http://127.0.0.1:1977/v1`
- **API key:** (required but ignored) use any dummy key (ex: `sk-7777777`)
- **Models:**
  - `system` (on-device)
  - `pcc` (Private Cloud Compute).

### Examples

```bash
curl http://127.0.0.1:1977/v1/chat/completions \
  -H "Authorization: Bearer sk-local" \
  -H "Content-Type: application/json" \
  -d '{"model":"pcc","messages":[{"role":"user","content":"Say hello in one word."}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:1977/v1", api_key="sk-local")
print(client.chat.completions.create(
    model="pcc",
    messages=[{"role": "user", "content": "Say hello in one word."}],
).choices[0].message.content)
```

## Running it manually

If you'd rather run the two processes yourself:

```bash
/usr/bin/fm serve --port 1976   # Apple's engine  (keep it in the FOREGROUND — see below)
node fm-proxy.js                # the proxy (listens on :1977 → :1976)
```

Run `fm serve` in its own Terminal.app window, in the foreground. Backgrounding it, running it under another process, or hosting it in a non-Terminal terminal emulator loses attribution and `pcc` will return 503 errors. `fm-proxy` handles this for you automatically. Running it in this manual form is the same thing, just split across two terminals.

## Usage

```bash
./fm-launch.sh [options]
  -v, --verbose          show the proxy's per-request [assembled] telemetry (errors/warnings and the [toks] throughput counter are always shown, even without this)
  --fm-port <n>          fm serve port          (default 1976)
  --proxy-port <n>       proxy port clients use (default 1977)
  --fm-bin <path>        fm binary              (default /usr/bin/fm)
  --health-timeout <ms>  how long to wait for fm serve (default 20000)
  -h, --help
```

`FM_PORT` and `PROXY_PORT` env vars are also accepted as alternatives to `--fm-port` / `--proxy-port`.
## Tests

```bash
node --test
```

## Status & caveats

**Consider this an experimental beta, and not deeply tested**:

What `fm serve` gets wrong on Beta 5, and what the proxy can do about it:

| What | State |
|---|---|
| Tool / function calling | **Broken.** Both engines. Fails silently and fabricates answers — see the warning at the top. Not fixable here. |
| `$defs` structured output | Broken upstream; the proxy works around it by inlining `$ref`s. |
| `n > 1` | Ignored — `fm serve` returns a single completion. |
| `parallel_tool_calls` | Ignored entirely, whether `true`, `false`, or absent. The proxy passes every `tool_call` through rather than guessing which to keep (see `AGENTS.md`). |
| Sampling params | Passed through as-is; whatever `fm serve` supports applies. |

Everything else was swept against Beta 5 and works, on both the on-device and cloud
models: chat (streaming and not), usage reporting, structured output, images, CORS,
both GET endpoints, and typed errors.

Two tool-schema repairs remain in place but cannot be re-verified end-to-end while
tool calling is broken — the `array<array<object>>` round-trip and the backfill of a
missing `function.description`. Both stay covered by unit tests.

I've seen **distinct mid-stream failure modes** on `pcc`: 
  - The model emits valid output, then `fm serve` interrupts with a safety-guardrail abort (surfaces as `finish_reason:"content_filter"`)
  - Random transient rate-limiting (`fm-proxy` has built-in retries, and surfaces `rate_limit_exceeded`)
  - When PCC attribution is missing (e.g. `fm serve` got backgrounded), a `service_unavailable` 503. 
  
Exactly what triggers each is **unverified**. Apple's error messaging is generic, and these are what I've been able to deduce after testing. The proxy classifies the errors so clients can react appropriately instead of guessing or erroring out.

Because `fm serve` is **part of macOS 27.0 beta**, its request/response behavior, schema support, and error semantics may change between builds. Which can change how this proxy works. Expect to update the proxy as the betas evolve.

See [`AGENTS.md`](AGENTS.md) for the deeper technical notes (schema flattening,
token accounting, the PCC context ceiling, and the structured-output situation).

## Repository layout

| Path | What |
|---|---|
| `fm-proxy.js` | The proxy (the app). |
| `fm-launch.sh` | One-command launcher — runs `fm serve` foreground (required for PCC) + the proxy. |
| `fm-proxy.test.js` | Unit + integration tests. |
| `AGENTS.md` | Deep technical notes / runbook. |
| `docs/` | `fm` CLI reference and PCC findings. |
| `tools/` | Local dev utilities, **not tracked in git** (see `.gitignore`) — e.g. `gen-fm-docs.py`, which regenerates `docs/fm-reference.md` from the installed binary. |

## License

[MIT](LICENSE).
