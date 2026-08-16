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
on-device (`system`) and on Apple's Private Cloud Compute (`pcc`). It includes a Chat Completions local server (`fm serve`), but tool-calling schema support still has a couple of rough edges and streaming token-usage reporting requires an opt-in flag most clients never set.

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
- **Fixed tool / function calling** — Accepts standard OpenAI `tools`, including rich nested schemas. `fm serve` decodes nested objects, arrays-of-objects, and (as of Beta 4) object chains of any depth natively; the proxy only falls back to a JSON-string round-trip for the one shape still verified broken upstream (`array<array<object>>`), best-effort.
- **Fixed structured output** — `response_format: {type:"json_schema",...}` works with plain, undecorated OpenAI/pydantic-style schemas (including `$defs`/`$ref`, the shape virtually every real schema generator emits). `fm serve` requires its own `title`/`x-order`/`required`/`additionalProperties` dialect on every object schema reached through `$defs`; the proxy handles it automatically so ordinary client schemas just work. It resolves `$ref`s inline and removes `$defs` before forwarding, which needs no dialect at all and avoids the Beta 5 hang described above. Cyclic (self-referencing) schemas cannot be inlined, so those still get the dialect.
- **Corrected non-streaming default** — Beta 5 returns `text/event-stream` for a chat
  request that omits `stream`, where the OpenAI spec (and every earlier build) returns
  one JSON object. Most OpenAI SDKs omit the field, so they got a body they could not
  parse. The proxy sends an explicit `stream:false` upstream when the client did not
  ask to stream, which restores the documented behaviour.
- **Fixed token counts** — `fm serve`'s non-streaming responses now report real `prompt_tokens` (fixed in Beta 3) and are passed through untouched. Streaming responses only get real usage when the request opts in via `stream_options.include_usage:true`, which real clients rarely set, so the proxy forces that flag upstream on every streaming request and relays fm serve's own real usage back — falling back to a computed estimate only if an upstream ignores the flag entirely.
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
- **macOS 27.0 Beta 4 or later** (fm/FoundationModels **2.0.62+**; ships with `fm` CLI baked in). Beta 3 (2.0.59) mostly works — the proxy keeps compatibility fallbacks (e.g. it probes both `fm count-tokens` and the pre-Beta-4 `token-count` name) — but deep object-chain tool params round-trip less cleanly there and the Beta 4 round-trip prose is untested against Beta 3's model. Earlier betas (2.0.55.1.402 and below) are unsupported: nested schemas fail and non-streaming `prompt_tokens` reads `0`. Check your build with `otool -l /usr/bin/fm | grep -A2 LC_SOURCE_VERSION` (see `AGENTS.md` for the full fingerprinting recipe).
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

> **fm serve must run in the foreground — and as of Beta 4, inside Terminal.app specifically.** macOS only grants PCC (Private Cloud Compute) attribution to a foreground `fm serve` hosted by the real Terminal app; other terminal emulators' panes (which worked on Beta 3) are now refused with `"Please use the Terminal app"` (HTTP 503). Backgrounding it, under node, or with a shell `&` also strips attribution. `system` keeps working in every context.
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

Run `fm serve` in its own Terminal.app window, in the foreground. Backgrounding it, running it under another process, or hosting it in a non-Terminal terminal emulator (Beta 4+) loses attribution and `pcc` will return 503 errors. `fm-proxy` handles this for you automatically. Running it in this manual form is the same thing, just split across two terminals.

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

I've seen **distinct mid-stream failure modes** on `pcc`: 
  - The model emits valid output, then `fm serve` interrupts with a safety-guardrail abort (surfaces as `finish_reason:"content_filter"`)
  - Random transient rate-limiting (`fm-proxy` has built-in retries, and surfaces `rate_limit_exceeded`)
  - When PCC attribution is missing (e.g. `fm serve` got backgrounded), a `service_unavailable` 503. 
  
Exactly what triggers each is **unverified**. Apple's error messaging is generic, and these are what I've been able to deduce after testing. The proxy classifies the errors so clients can react appropriately instead of guessing or erroring out.

Because `fm serve` is **part of macOS 27.0 beta**, its request/response behavior, schema support, and error semantics may change between builds. Which can change how this proxy works. Expect to update the proxy as the betas evolve.

**Known limits**: one rare nested tool-param shape (`array<array<object>>`) can't be decoded natively (Beta 4 hard-errors on it) and falls back to a best-effort JSON-string round-trip — the model's content for that shape is unreliable regardless of encoding; `n > 1` isn't supported; `parallel_tool_calls: false` is accepted but silently ignored by `fm serve` (the proxy passes every `tool_call` through rather than guessing which one to keep — see `AGENTS.md`); sampling parameters are passed through as-is. `fm serve` also 400s any tool-calling request where a tool is missing `function.description` — the proxy backfills a missing/null description to `""` so this is transparent to clients.

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
| `tools/` | Dev utilities — `gen-fm-docs.py` regenerates `docs/fm-reference.md` from the installed binary. |

## License

[MIT](LICENSE).
