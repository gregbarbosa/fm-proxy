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
> Run `sudo fm license` to read it and accept it. After that, `fm license --show`
> prints the text again without prompting, and `fm license --status` reports the
> version you agreed to. The 27.0 RC still carries the same text, recorded as
> `FM1 version 1.0`. It says:
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

## State on the 27.0 RC

Tested on macOS 27.0 RC (`26A428`), which ships `fm` 2.0.68.1.402. Beta 7 and Beta 8
ship the same `fm` build and behave the same way, apart from the tool-call content
described below.

> [!IMPORTANT]
> **Beta 7 removed the `pcc` model, and the RC does not bring it back. Private Cloud
> Compute is gone from `fm`.**
>
> `fm` accepts only `system` now. `fm respond -m pcc` answers `Please provide one of
> 'system'`. The `fm quota-usage` subcommand is deleted. `fm serve` answers a request
> for `pcc` with `400 Unknown model 'pcc'. Available models: system`.
>
> This is a change in the binary, not a licence or account state. Every PCC feature
> that earlier notes describe is unreachable.

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
> **Tool calling is still broken, and it still fails silently.**
>
> `fm serve` does not convert the model's tool call into a `tool_calls` field. The
> field stays absent and `finish_reason` is `stop`.
>
> The model picks the correct tool and the correct arguments, and writes them into
> `content`, for example `{"tool_call": [{"name": "get_weather", "arguments":
> {"city": "Tokyo"}}]}`. Only the upstream parser step is missing.
>
> On the RC the content is no longer clean. Most replies to a request that carries
> `tools` also contain raw chat-template markers such as `<start_of_turn>` and
> `<ctrl46>`. Seven of 10 direct replies and 9 of 10 replies through the proxy carried
> one. The proxy does not remove them, because it corrects envelopes and schemas and
> does not filter content. Strip them in your client if you parse `content`.
>
> The leak needs `tools` in the request. Ordinary chat is not affected.
>
> Do not use tool calling for work that you must trust. The proxy still repairs tool
> schemas, so tool calling returns without a change here once `fm serve` reads the
> call again.

> [!NOTE]
> **A self-referencing `$defs` schema stops `fm serve`. The proxy blocks it for you.**
>
> A `$defs` definition that refers to itself hangs `fm serve`. The request never
> returns, and every later request hangs too. Recursion has no finite inline form, so
> the proxy cannot rewrite the schema. It rejects the request instead, with `400`
> `cyclic_schema` naming the definition, before it opens an upstream connection. Send a
> recursive schema to `fm serve` directly and you still lose it.
>
> A restart of `fm serve` clears it, on the 27.0 RC as on every earlier build. Expect the
> first request after the restart to take about 25 seconds while the model reloads.

`fm serve` rejects `n > 1` with `400 n=3 is not supported. Only a single completion per
request is implemented.` The proxy types that as `invalid_request_error` and does not
retry it. `parallel_tool_calls` is accepted and then ignored. Sampling parameters pass
through unchanged.

## Requirements

- macOS 27.0 Beta 7 or later, which includes `fm` 2.0.68.1.402. Tested on the 27.0 RC
  (`26A428`). Earlier betas are not supported.
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

Beta 7 removed the `pcc` model, so the Terminal.app foreground rule that Private Cloud
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
- Models: `system` (on-device). It is the only model `fm` accepts.

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
  --fm-port <n>          fm serve port          (default 1976)
  --proxy-port <n>       proxy port for clients (default 1977)
  --fm-bin <path>        fm binary              (default /usr/bin/fm)
  --health-timeout <ms>  wait for fm serve      (default 20000)
```

`FM_PORT` and `PROXY_PORT` replace the two port options.

Run the tests with `node --test`.

## What the proxy corrects

Each item below is a live-verified `fm serve` behaviour that breaks OpenAI clients.

| `fm serve` behaviour | Correction |
|---|---|
| A request that omits `stream` returns an event stream, not one JSON object. | Sends `stream:false` when the client did not ask to stream. |
| A `$defs`/`$ref` schema returns 400 unless every definition carries Apple's dialect. | Resolves the references inline and removes `$defs`. |
| A tool whose `function.description` is absent returns 400 for the whole request. | Fills in an empty description. |
| Streaming usage arrives only when the request sets `stream_options.include_usage`. | Sets the flag upstream and relays the real numbers. |
| A forced `tool_choice` fails permanently on `system`, with a message that reads like a rate limit. | Types it as terminal, so it fails in ~150 ms instead of retrying. |
| A tool parameter that uses `$ref` loses its structure. | Resolves the references before simplifying. |
| A self-referencing `$defs` schema hangs the server permanently. | Rejects it with `400` `cyclic_schema` before opening an upstream connection. |
| A request that carries `Origin` or `Referer` is refused as cross-site. | Strips that header family on the upstream hop, so browser clients work. |

Apple's error messages are generic, so the proxy gives each one a type. A safety stop
becomes `finish_reason:"content_filter"` and keeps the partial output. A rate limit
becomes `rate_limit_exceeded`, and the proxy retries it.

An upstream `400` is terminal. The proxy types it `invalid_request_error` and does not
retry it, so an unknown model name — `pcc`, for example — fails in about 2 ms.

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
