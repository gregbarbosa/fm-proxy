# fm-proxy

**An OpenAI-compatible API endpoint for the Apple Foundation Models CLI (`fm`).**

macOS 27.0 ships a beta `fm` CLI to run Apple Foundation Models
on-device (`system`) and on Apple's Private Cloud Compute (`pcc`). It includes a Chat Completions local server (`fm serve`), but tool-calling schema support is limited and token-usage reporting is broken.

`fm-proxy` sits in front of `fm serve` to give you an **OpenAI-compatible Chat Completions endpoint**. Point any OpenAI client at the local URL and use Apple's models with no code changes.

> ⚠️ **Beta.** This is built on macOS 27.0 **beta** so expect breaking changes with system updates.

## What it includes

- **Chat completions** — streaming and non-streaming.
- **Fixed tool / function calling** — Flattens to the subset `fm serve` accepts (nested parameters are losslessly round-tripped as JSON). Accepts standard OpenAI `tools`, including rich nested schemas.
- **Fixed token counts** — `fm serve` reports `prompt_tokens` as `0`; the proxy fills in real token counts so context window gauges work.
- **Added vision support** — standard `image_url` content parts with base64 data URLs.
- **Enabled CORS** — Browser-based clients can connect directly.
- **OpenAI-shaped errors** — failures come back typed (`rate_limit_exceeded`, `service_unavailable`) so clients can branch on the cause. A mid-stream safety filter abort ends the completion as `finish_reason:"content_filter"` with any partial output preserved (no exception thrown).

Includes the native `GET /v1/models` and `GET /health` endpoints as straight passthroughs to `fm serve`.

## Requirements

- **macOS 27.0** (ships with `fm` CLI baked in).
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

> **fm serve must run in the foreground.** macOS only grants PCC (Private Cloud
> Compute) attribution to a **foreground, TTY-attached** `fm serve`. Backgrounding it, under node, or with a shell `&`, makes every `pcc` request fail with `"not available in this context"` (HTTP 503), while `system` keeps working.
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

Run `fm serve` in its own terminal, in the foreground. Backgrounding it (or running it under another process) loses attribution and `pcc` will return 503 errors. `fm-proxy` handles this for you automatically. Running it in this manual form is the same thing, just split across two terminals.

## Usage

```bash
./fm-launch.sh [options]
  -v, --verbose          show the proxy's per-request [assembled] telemetry (errors/warnings are always shown, even without this)
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

**Known limits**: nested structured output is approximated rather than strictly enforced; `n > 1` isn't supported; sampling parameters are passed through as-is.

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
