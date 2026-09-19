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
> version you agreed to. The 27.2 beta carries the same clause, recorded as
> `FM1 version 1.1` — the first version bump since Beta 5. The clause itself did not
> change. It says:
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

## State on the 27.2 beta

Tested on macOS 27.2 Beta (`26B5086k`), which ships `fm` 2.1.7.1.901 — a version jump
from the 2.0.68 line, with a grown CLI surface: PCC returns, `fm available` is renamed
`fm models`, `fm quota-usage` is restored, and a new `--model-provider` option routes
non-built-in models to an external Chat Completions server (managed via a new `fm config`
tree). Every behaviour the proxy depends on survived the jump.

> [!IMPORTANT]
> **The 27.2 beta brings `pcc` back — gated and, for now, not ready.**
>
> `GET /v1/models` lists `system,pcc`, and `fm serve` accepts `model:"pcc"`. But PCC
> only runs from a Terminal.app context: anywhere else `fm` answers "Private Cloud
> Compute is not available in this context. Please use the Terminal app." — and `fm serve`
> inherits the context it was launched from, so a herdr- or pi-launched stack cannot
> reach `pcc` at all. From Terminal.app it still fails — see the audit note: this seed
> has a broken entitlement check (`modelmanagerd` cannot read fm's own
> `com.apple.modelmanager.inference` entitlement at runtime), so every PCC session is
> refused and `fm` prints "The system is not ready." A full reboot did not clear it,
> so it is a confirmed seed bug, not settling: file via Feedback Assistant.
> `system` stays healthy throughout.

| Feature | State |
|---|---|
| Chat completions, streaming and not | Works |
| Token usage, both paths | Works |
| Structured output, including `$defs`/`$ref` | Works |
| Images | Works |
| CORS, `GET /v1/models`, `GET /health` | Works |
| Typed errors | Works |
| **Private Cloud Compute (`pcc`)** | **Back upstream, Terminal.app contexts only, `systemNotReady` while provisioning. The proxy forwards `model:"pcc"` untouched.** |
| **Tool / function calling** | **Forced `tool_choice` works. `auto` is broken upstream.** |

> [!WARNING]
> **`tool_choice: "auto"` is still broken, and it still fails silently.**
>
> `fm serve` does not convert the model's tool call into a `tool_calls` field. The
> field stays absent and `finish_reason` is `stop`. A forced `tool_choice` does work;
> see below.
>
> The model picks the correct tool and the correct arguments, and writes them into
> `content`, for example `{"tool_call": [{"name": "get_weather", "arguments":
> {"city": "Tokyo"}}]}`. Only the upstream parser step is missing.
>
> The content is not clean. Most replies to a request that carries `tools` also contain
> raw chat-template markers such as `<start_of_turn>` and `<ctrl46>`. The counts on the
> 27.0 RC are 7 of 10 direct replies and 8 to 9 of 10 through the proxy. On the 27.2
> beta the leak persists: 2 of 10 direct replies, including a new
> `[ToolCall{FunctionName:get_weather,Arguments:{city:<ctrl46>Paris<ctrl46>}}]`
> rendering. The leak is not
> new on the RC. A clean-room record dated 2026-08-18 shows the same markers on Beta 7.
> Earlier tests missed it.
>
> The leak needs `tools` in the request. Ordinary chat is not affected.
>
> Set `FM_STRIP_TEMPLATE_MARKERS=1` to remove them from `content` on both the streaming
> and non-streaming paths. It is **off by default**, because the proxy otherwise
> corrects only envelopes and schemas and does not filter content, and because the
> markers are how you detect the upstream bug. With the flag on, 10 of 10 replies came
> back clean and the tool call inside them was untouched.
>
> **A forced `tool_choice` does work.** Set `tool_choice: "required"`, or name a
> function, and the proxy translates the call into a `response_format` schema. `fm serve`
> rejects a forced `tool_choice` outright but honours `response_format`, so constrained
> decoding picks the tool and the proxy hands you real `tool_calls`. Measured on the
> 27.0 RC: 16 of 16 forced calls succeeded, routing to the right tool out of two, at
> roughly 115 prompt tokens against 256 for the native path. Streaming works too, and
> the 27.2 beta re-verified it: the deviation probe reports 11 of 11, with the forced
> named-function check returning a real `tool_call` with valid JSON arguments.
>
> Only `tool_choice: "auto"` is still broken, and it is left alone on purpose. Auto has
> to be able to answer without calling a tool, and giving the model that escape is
> exactly what stops it selecting one: 0 of 25 in testing. If you can say which tool you
> want, or that you want one at all, use a forced `tool_choice` and it works today.

> [!NOTE]
> **A self-referencing `$defs` schema stops `fm serve`. The proxy blocks it for you.**
>
> A `$defs` definition that refers to itself hangs `fm serve`. The request never
> returns, and every later request hangs too. Recursion has no finite inline form, so
> the proxy cannot rewrite the schema. It rejects the request instead, with `400`
> `cyclic_schema` naming the definition, before it opens an upstream connection. Send a
> recursive schema to `fm serve` directly and you still lose it.
>
> A restart of `fm serve` clears it, on the 27.0 RC and 27.2 beta as on every earlier
> build. Expect the first request after the restart to take about 25 seconds while the
> model reloads.

`fm serve` rejects `n > 1` with `400 n=3 is not supported. Only a single completion per
request is implemented.` The proxy types that as `invalid_request_error` and does not
retry it. `parallel_tool_calls` is accepted and then ignored. `stop` is applied by the
proxy, because `fm serve` rejects it. Other sampling parameters pass through unchanged.

## Requirements

- macOS 27.0 Beta 7 or later. Tested on the 27.0 RC (`26A428`) and the 27.2 beta
  (`26B5086k`). Earlier betas are not supported.
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

Beta 7 removed the `pcc` model, so the old Terminal.app foreground rule stopped mattering
for `system` — it works in any terminal, and in a background process. The 27.2 beta
brings `pcc` back, and the rule matters again for that one model: `fm serve` must be
launched from Terminal.app for `pcc` requests to get past the context gate.

To run the two processes yourself, in two windows:

```bash
/usr/bin/fm serve --port 1976   # Apple's engine, foreground
node fm-proxy.js                # the proxy, :1977 -> :1976
```

## Connect a client

- Base URL: `http://127.0.0.1:1977/v1`
- API key: any value. The proxy requires one and ignores it.
- Models: `system` (on-device). The 27.2 beta also lists `pcc`, gated to Terminal.app
  contexts and `systemNotReady` while provisioning; the proxy forwards `model` through
  untouched.

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

The proxy reads its whole configuration from the environment, so these work whether you
start it with `fm-launch.sh` or run `node fm-proxy.js` yourself:

| Variable | Default | Effect |
|---|---|---|
| `PROXY_PORT` | `1977` | Port the proxy listens on. |
| `FM_PORT` | `1976` | Port `fm serve` listens on. |
| `FM_BIN` | `/usr/bin/fm` | Path to the `fm` binary, used for the token-count fallback. |
| `FM_STRIP_TEMPLATE_MARKERS` | off | Set to `1` to remove leaked chat-template markers from `content`. See below. |
| `CORS_ORIGIN` | `*` | Replaces the value in `Access-Control-Allow-Origin`. |
| `FM_MAX_RETRIES` | `4` | Retries for a transient upstream failure. `0` disables retrying. |
| `FM_RETRY_BASE_MS` | `1000` | First retry delay; it doubles each attempt. |
| `FM_RETRY_CAP_MS` | `15000` | Ceiling on that delay. |

### Stripping leaked template markers

`fm serve` puts its own chat-template delimiters into `content` on most replies to a
request that carries `tools` — `<start_of_turn>`, `<ctrl46>`, and similar. If your client
reads `content`, it reads those too.

```bash
FM_STRIP_TEMPLATE_MARKERS=1 ./fm-launch.sh
```

Measured on the 27.0 RC: 8 of 10 replies leaked with the flag off, and 0 of 10 with it
on, while the rate at which replies carried a real tool call did not change. Re-verified
on the 27.2 beta: 0 of 10 leaked with the flag on.

It is off by default for two reasons. The proxy otherwise corrects only envelopes and
schemas and never edits the model's words, and the markers are the signal that shows the
upstream bug is still there. Turn it on if you are consuming `content`; leave it off if
you are testing what `fm serve` actually does.

Run the tests with `node --test`.

## What the proxy corrects

Each item below is a live-verified `fm serve` behaviour that breaks OpenAI clients.

| `fm serve` behaviour | Correction |
|---|---|
| A request that omits `stream` returns an event stream, not one JSON object. | Sends `stream:false` when the client did not ask to stream. |
| A `$defs`/`$ref` schema returns 400 unless every definition carries Apple's dialect. | Resolves the references inline and removes `$defs`. |
| A tool whose `function.description` is absent returns 400 for the whole request. | Fills in an empty description. |
| Streaming usage arrives only when the request sets `stream_options.include_usage`. | Sets the flag upstream and relays the real numbers. |
| A forced `tool_choice` returns `500 unsupported generation guide`. | Translates it into a `response_format` schema, so constrained decoding makes the call. |
| A tool parameter that uses `$ref` loses its structure. | Resolves the references before simplifying. |
| A self-referencing `$defs` schema hangs the server permanently. | Rejects it with `400` `cyclic_schema` before opening an upstream connection. |
| A request that carries `Origin` or `Referer` is refused as cross-site. | Strips that header family on the upstream hop, so browser clients work. |
| Replies to a tool request leak chat-template markers into `content`. | Removes them — **opt-in**, `FM_STRIP_TEMPLATE_MARKERS=1`. |

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
| `AGENTS.md` | What `fm serve` does, what the proxy corrects, and the audit recipe. |
| `docs/fm-reference.md` | Generated `fm` CLI reference, committed per build. |
| `tools/TEST_PLAN.md` | The three test layers and how to read a failure. |
| `tools/wire-baseline.js` | Records exactly what the proxy forwards, to prove a refactor changed nothing. |
| `tools/deviation-probe.js` | Checks a running proxy against every `fm serve` deviation. |
| `tools/gen-fm-docs.py` | Regenerates `docs/fm-reference.md` from the installed binary. |

[MIT](LICENSE).
