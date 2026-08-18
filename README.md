# fm-proxy

An OpenAI-compatible endpoint for Apple's Foundation Models CLI. Point any OpenAI
client at `http://127.0.0.1:1977/v1` and use Apple's on-device and Private Cloud
Compute models without code changes.

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

## State on Beta 5 and Beta 6

Tested on macOS 27.0 Beta 5 (`26A5406e`) and Beta 6 (`26A5416b`). Both ship `fm` 2.0.68.

**Beta 6 changes nothing.** It ships the same `fm`, and the CLI surface is byte-identical.
I re-ran every check against it and every result matched Beta 5, so this release needs no
update. I test each feature against a live `fm serve`.

| Feature | State |
|---|---|
| Chat completions, streaming and not | Works |
| Token usage, both paths | Works |
| Structured output, including `$defs`/`$ref` | Works |
| Images | Works |
| CORS, `GET /v1/models`, `GET /health` | Works |
| Typed errors | Works |
| **Tool / function calling** | **Broken upstream. See the warning below.** |

> [!WARNING]
> **Tool calling is broken on Beta 5 and Beta 6, and it fails silently.**
>
> `fm serve` no longer converts the model's tool call into a `tool_calls` field. Both
> the on-device and the cloud model are affected, so a different model is not a way
> around it.
>
> The model then answers as if it had called the tool. I asked it to read a file that
> contained `BETA5_CANARY_9F3A`. The tool never ran, and the model reported the
> contents as `hello`. A client receives a confident wrong answer, not an error.
>
> Do not use tool calling for work that you must trust. Wait for Apple to fix the
> parser. The proxy still repairs tool schemas, so tool calling returns without a
> change here once `fm serve` reads the call again.

`n > 1` and `parallel_tool_calls` are accepted and then ignored by `fm serve`. Sampling
parameters pass through unchanged.

## Requirements

- macOS 27.0 Beta 5 or Beta 6. Both include `fm` 2.0.68. Earlier betas are not supported.
- An Apple Account, signed in, with Apple Intelligence enabled. The `pcc` model needs
  it. The `system` model runs locally.
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

> [!IMPORTANT]
> **The `pcc` model needs `fm serve` in the foreground of Terminal.app.**
>
> macOS grants Private Cloud Compute attribution only to a foreground `fm serve` that
> Terminal.app hosts. Another terminal application receives HTTP 503 and
> `"Please use the Terminal app"`. A background process loses attribution too. The
> `system` model works everywhere.

To run the two processes yourself, in two Terminal.app windows:

```bash
/usr/bin/fm serve --port 1976   # Apple's engine, foreground
node fm-proxy.js                # the proxy, :1977 -> :1976
```

## Connect a client

- Base URL: `http://127.0.0.1:1977/v1`
- API key: any value. The proxy requires one and ignores it.
- Models: `system` (on-device), `pcc` (Private Cloud Compute)

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:1977/v1", api_key="sk-local")
print(client.chat.completions.create(
    model="pcc",
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
| A `$defs`/`$ref` schema returns 400. With the dialect it demanded before Beta 5, it hangs and stops answering until restart. | Resolves the references inline and removes `$defs`. |
| A tool whose `function.description` is absent returns 400 for the whole request. | Fills in an empty description. |
| Streaming usage arrives only when the request sets `stream_options.include_usage`. | Sets the flag upstream and relays the real numbers. |
| A bare `fm count-tokens` omits the conversation framing, so a count reads 54 low. | Adds the framing back. |
| A forced `tool_choice` fails permanently on `system`, with a message that reads like a rate limit. | Types it as terminal, so it fails in ~150 ms instead of retrying. |
| A tool parameter that uses `$ref` loses its structure. | Resolves the references before simplifying. |
| One nested shape, `array<array<object>>`, cannot be decoded. | Passes it as a JSON string and parses the reply. |

Apple's error messages are generic, so the proxy gives each one a type. A safety stop
becomes `finish_reason:"content_filter"` and keeps the partial output. A rate limit
becomes `rate_limit_exceeded`, and the proxy retries it. Missing PCC attribution becomes
`service_unavailable`.

`fm serve` is beta software. Its behaviour changes between builds, so expect to update
the proxy.

## Files

| Path | Contents |
|---|---|
| `fm-proxy.js` | The proxy. |
| `fm-launch.sh` | Launcher for `fm serve` and the proxy. |
| `fm-proxy.test.js` | Unit and integration tests. |
| `AGENTS.md` | Technical notes: token accounting, the PCC context ceiling, per-beta findings. |
| `docs/fm-reference.md` | Generated `fm` CLI reference. |

[MIT](LICENSE).
