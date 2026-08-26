# fm-proxy

An OpenAI-compatible endpoint for Apple's Foundation Models CLI. Point any OpenAI
client at `http://127.0.0.1:1977/v1` and use Apple's on-device model without code
changes.

macOS 27 ships `fm serve`, which already speaks Chat Completions. It also departs from
the OpenAI specification in ways that break ordinary clients. `fm-proxy` sits in front
of it and corrects those departures.

> [!CAUTION]
> **Read the licence before you use this.**
>
> macOS 27.0 Beta 5 added a legal notice. You must accept it before `fm` runs at all.
> Run `sudo fm license` to read it. It says:
>
> > YOU ARE ALSO AGREEING TO NOT PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH
> > APPLE SOFTWARE OR SERVICES EXCEPT AS EXPRESSLY PERMITTED.
>
> `fm-proxy` accesses Apple models programmatically. That is its only function. Apple
> does not publish the list of permitted uses, so I cannot show that this tool is
> inside the exception. Read plainly, this tool conflicts with the terms that you
> accept.
>
> Use `fm-proxy` at your own risk. Keep it on your own machine. Do not put it in a
> product or a commercial deployment. For a supported path, use the
> [Foundation Models framework][fmf] in a signed app.

[fmf]: https://developer.apple.com/documentation/foundationmodels

## State on Beta 7

Tested on macOS 27.0 Beta 7 (`26A5421a`), which ships `fm` 2.0.68.1.402.

> [!IMPORTANT]
> **Beta 7 removes the `pcc` model. Private Cloud Compute is gone from `fm`.**
>
> `fm` accepts only `system` now. `fm respond -m pcc` answers `Please provide one of
> 'system'`. The `fm quota-usage` subcommand is deleted. `fm serve` answers a request
> for `pcc` with `400 Unknown model 'pcc'. Available models: system`.
>
> This is a change in the binary, not a licence or account state. Every PCC feature
> that earlier notes describe is unreachable on Beta 7.

| Feature | State |
|---|---|
| Chat completions, streaming and not | Works |
| Token usage, both paths | Works |
| Structured output, including `$defs`/`$ref` | Works |
| Images | Works |
| CORS, `GET /v1/models`, `GET /health` | Works |
| Typed errors | Works |
| **Private Cloud Compute (`pcc`)** | **Removed upstream.** |
| **Tool / function calling** | **Broken upstream. See the warning below.** |

> [!WARNING]
> **Tool calling is still broken on Beta 7, and it still fails silently.**
>
> `fm serve` does not convert the model's tool call into a `tool_calls` field. The
> field stays absent and `finish_reason` is `stop`.
>
> Beta 7 changes the shape of the failure. The model now writes clean JSON into
> `content`, for example `{"tool_call": [{"name": "get_weather", "arguments":
> {"city": "Tokyo"}}]}`, and no control tokens leak. It picks the correct tool and the
> correct arguments. Only the upstream parser step is missing.
>
> Do not use tool calling for work that you must trust. The proxy still repairs tool
> schemas, so tool calling returns without a change here once `fm serve` reads the
> call again.

> [!WARNING]
> **A self-referencing `$defs` schema stops `fm serve` until you restart it.**
>
> A `$defs` definition that refers to itself and holds no other required property
> hangs `fm serve`. The request never returns, and every later request hangs too. Only
> a restart clears it. The proxy cannot repair this shape, because the recursion has no
> finite inline form. Avoid recursive schemas in `response_format`.

`n > 1` and `parallel_tool_calls` are accepted and then ignored by `fm serve`. Sampling
parameters pass through unchanged.

`n > 1` and `parallel_tool_calls` are accepted and then ignored by `fm serve`. Sampling
parameters pass through unchanged.

## Requirements

- macOS 27.0 Beta 7, which includes `fm` 2.0.68.1.402. Earlier betas are not supported.
- An Apple Account, signed in, with Apple Intelligence enabled. The `system` model runs
  locally.
- Node.js 18 or later. The proxy uses only the standard library.
- The accepted CLI licence. Run `sudo fm license` and answer `yes`. Until you do, every
  `fm` command exits 69. One acceptance covers every user on the machine.

## Start it

```bash
./fm-launch.sh
```

Wait for `stack up — OpenAI base URL: http://127.0.0.1:1977/v1`.

The launcher runs `fm serve` in the foreground and the proxy as a background child.
Press Ctrl-C to stop both. Do not press Ctrl-Z: a suspended `fm serve` keeps the port.

Beta 7 removes the `pcc` model, so the Terminal.app foreground rule that Private Cloud
Compute needed no longer applies. The `system` model works in any terminal, and in a
background process.

To run the two processes yourself, in two windows:

```bash
/usr/bin/fm serve --port 1976   # Apple's engine, foreground
node fm-proxy.js                # the proxy, :1977 -> :1976
```

## Connect a client

- Base URL: `http://127.0.0.1:1977/v1`
- API key: any value. The proxy requires one and ignores it.
- Models: `system` (on-device). It is the only model Beta 7 accepts.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:1977/v1", api_key="sk-local")
print(client.chat.completions.create(
    model="system",
    messages=[{"role": "user", "content": "Say hello in one word."}],
).choices[0].message.content)
```

## Options

```
./fm-launch.sh [options]
  -v, --verbose          show per-request [assembled] telemetry
  --fm-port <n>          fm serve port          (default 1976)
  --proxy-port <n>       proxy port for clients (default 1977)
  --fm-bin <path>        fm binary              (default /usr/bin/fm)
  --health-timeout <ms>  wait for fm serve      (default 20000)
```

`FM_PORT` and `PROXY_PORT` replace the two port options. Errors and the `[toks]`
throughput counter print without `--verbose`.

Run the tests with `node --test`.

## What the proxy corrects

Each item below is a live-verified `fm serve` behaviour that breaks OpenAI clients.

| `fm serve` behaviour | Correction |
|---|---|
| A request that omits `stream` returns an event stream, not one JSON object. | Sends `stream:false` when the client did not ask to stream. |
| A `$defs`/`$ref` schema returns 400 unless every definition carries Apple's dialect. | Resolves the references inline and removes `$defs`. |
| A tool whose `function.description` is absent returns 400 for the whole request. | Fills in an empty description. |
| Streaming usage arrives only when the request sets `stream_options.include_usage`. | Sets the flag upstream and relays the real numbers. |
| A bare `fm count-tokens` omits the conversation framing, so a count reads 54 low. | Adds the framing back. |
| A forced `tool_choice` fails permanently on `system`, with a message that reads like a rate limit. | Types it as terminal, so it fails in ~150 ms instead of retrying. |
| A tool parameter that uses `$ref` loses its structure. | Resolves the references before simplifying. |
| One nested shape, `array<array<object>>`, cannot be decoded. | Passes it as a JSON string and parses the reply. |

Apple's error messages are generic, so the proxy gives each one a type. A safety stop
becomes `finish_reason:"content_filter"` and keeps the partial output. A rate limit
becomes `rate_limit_exceeded`, and the proxy retries it.

> [!NOTE]
> **Known defect: the proxy retries an upstream `400`.**
>
> `fm serve` rejects an unknown model name in 7 ms. The proxy classifies that `400` as
> retryable, tries it 4 more times, and answers after about 15 seconds with
> `server_error` / `internal_error` instead of `invalid_request_error`. A client that
> still asks for `model: "pcc"` meets this on every request.

`fm serve` is beta software. Its behaviour changes between builds, so expect to update
the proxy.

## Files

| Path | Contents |
|---|---|
| `fm-proxy.js` | The proxy. |
| `fm-launch.sh` | Launcher for `fm serve` and the proxy. |
| `fm-proxy.test.js` | Unit and integration tests. |
| `AGENTS.md` | Technical notes: token accounting, per-beta findings. |
| `docs/fm-reference.md` | Generated `fm` CLI reference. |

[MIT](LICENSE).
