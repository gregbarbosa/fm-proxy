# fm-proxy

**Turn macOS 27.0's built-in `fm` CLI into an OpenAI-compatible API endpoint.**

macOS 27.0 ships a beta `fm` command that can run Apple's Foundation Models —
on-device (`system`) and on Apple's Private Cloud Compute (`pcc`). It exposes a
local server (`fm serve`), but its tool-calling schema support is limited and its
token-usage reporting is incomplete. `fm-proxy` sits in front of it and speaks the
**OpenAI Chat Completions** dialect, so you can point any OpenAI client at a local
URL and use Apple's models with no code changes.

```
Your app  ──▶  fm-proxy (:1977)  ──▶  Apple `fm serve` (:1976)
   OpenAI API     translates             on-device + PCC models
```

> ⚠️ **Beta.** This is built on macOS 27.0 **beta** software. `fm serve` is baked
> into the OS, so an OS update can change how it behaves — and therefore how this
> proxy functions — at any time. See [Status & caveats](#status--caveats).

## Requirements

- **macOS 27.0** (the `fm` CLI ships with it, at `/usr/bin/fm`).
- **Signed in with your Apple Account (iCloud)** and Apple Intelligence enabled —
  the `pcc` model runs on Private Cloud Compute and needs that attribution, which only
  sticks to a **foreground** `fm serve` in a signed-in Terminal (the launcher handles
  this; see [Quick start](#quick-start)). `system` needs no attribution.
- **Node.js** (v18+). The proxy uses only Node's standard library — no `npm install`.

## Quick start

```bash
# One command: starts the proxy, then runs fm serve in the foreground (blocks).
./fm-launch.sh
```

> **fm serve must run in the foreground.** macOS only grants PCC (Private Cloud
> Compute) attribution to a **foreground, TTY-attached** `fm serve`. Backgrounding it —
> under node, or with a shell `&` — makes every `pcc` request fail with
> `"not available in this context"` (HTTP 503), while `system` keeps working. So the
> launcher runs `fm serve` in the foreground (it blocks this terminal) and the proxy as
> a backgrounded child. **Use Ctrl-C to stop** (it reaps the proxy); don't Ctrl-Z — a
> suspended `fm serve` won't be cleaned up and will strand the port.

When it prints `stack up — OpenAI base URL: http://127.0.0.1:1977/v1`, you're ready.

Point any OpenAI client at:

- **Base URL:** `http://127.0.0.1:1977/v1`
- **API key:** any non-empty string (e.g. `sk-local`) — it's loopback-only and the
  key is ignored, but most SDKs require *something*.
- **Models:** `system` (on-device) or `pcc` (Private Cloud Compute, larger context).

### Example

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

## What it does

- **Chat completions** — streaming and non-streaming.
- **Tools / function calling** — accepts standard OpenAI `tools`, including rich
  nested schemas, which it flattens to the subset `fm serve` accepts (nested
  parameters are losslessly round-tripped as JSON).
- **Vision** — standard `image_url` content parts with base64 data URLs.
- **Usage repair** — `fm serve` reports `prompt_tokens` as `0`; the proxy fills in
  real token counts so client context gauges work.
- **CORS** — enabled, so browser-based clients can connect directly.
- **OpenAI-shaped errors** — failures come back typed (`rate_limit_exceeded`,
  `service_unavailable`) so clients can branch on the cause. A mid-stream safety abort
  ends the completion as `finish_reason:"content_filter"` with any partial output
  preserved (no exception thrown).

`GET /v1/models` and `GET /health` pass straight through to `fm serve`.

## Running it manually

If you'd rather run the two processes yourself:

```bash
/usr/bin/fm serve --port 1976   # Apple's engine  (keep it in the FOREGROUND — see below)
node fm-proxy.js                # the proxy (listens on :1977 → :1976)
```

Run `fm serve` in its own terminal, in the foreground — backgrounding it (or running it
under another process) loses PCC attribution and `pcc` will 503. The launcher above does
this for you; this manual form is the same thing split across two terminals.

`fm-launch.sh` flags: `--verbose` (show per-request telemetry; errors are always
shown regardless), `--fm-port`, `--proxy-port`, `--fm-bin`, `--health-timeout`.

## Tests

```bash
node --test
```

## Status & caveats

**This is beta and not deeply tested.** Treat it as experimental:

- We've observed **distinct mid-stream failure modes** on `pcc`: a safety-guardrail
  abort (the model emits valid output, then fm serve interrupts — surfaced as
  `finish_reason:"content_filter"`), transient rate-limiting (retried, then surfaced as
  `rate_limit_exceeded`), and a `service_unavailable` 503 when PCC attribution is missing
  (e.g. `fm serve` got backgrounded). Exactly what triggers each is **unconfirmed** —
  Apple's error messaging is generic — but the proxy classifies them so clients can
  react appropriately instead of guessing.
- Because `fm serve` is **part of macOS 27.0** and that OS is itself in beta, its
  request/response behavior, schema support, and error semantics may change between
  builds — which can change how this proxy works. Expect to update the proxy as the
  OS betas evolve.
- Known limits: nested structured output is approximated rather than strictly
  enforced; `n > 1` isn't supported; sampling parameters are passed through as-is.

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

## License

[MIT](LICENSE).
