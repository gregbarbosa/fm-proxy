# fm-proxy

An OpenAI-compatible endpoint for Apple's on-device Foundation Models. Point an OpenAI
client at `http://127.0.0.1:1977/v1` and use Apple's model without code changes.

macOS 27 ships `fm serve`, which already speaks Chat Completions. It also departs from
the OpenAI API in ways that break ordinary clients. `fm-proxy` sits in front of it and
corrects those departures. It has no dependencies.

> [!CAUTION]
> **Read the licence before you use this.**
>
> `fm` runs only after you accept Apple's licence with `sudo fm license`. The licence
> (`FM1 version 1.1` on macOS 27.2) says:
>
> > YOU ARE ALSO AGREEING TO NOT PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH
> > APPLE SOFTWARE OR SERVICES EXCEPT AS EXPRESSLY PERMITTED.
>
> `fm-proxy` accesses Apple models programmatically. That is its only function. Apple
> does not publish the list of permitted uses, so I cannot show that this tool is inside
> the exception. Read plainly, this tool conflicts with the terms that you accept.
>
> Use `fm-proxy` at your own risk. Keep it on your own machine. Do not put it in a
> product or a commercial deployment. For a supported path, use the
> [Foundation Models framework][fmf] in a signed app.

[fmf]: https://developer.apple.com/documentation/foundationmodels

## Requirements

- macOS 27.2 or later. Last tested on macOS 27.2 RC (`26B123`).
- Apple Intelligence enabled, with an Apple Account signed in.
- Node.js 18 or later.
- The accepted `fm` licence. Run `sudo fm license` once. Until you do, every `fm`
  command exits 69.

## Start it

```bash
git clone https://github.com/gregbarbosa/fm-proxy.git
cd fm-proxy
./fm-launch.sh
```

Wait for `stack up — OpenAI base URL: http://127.0.0.1:1977/v1`. The launcher runs
`fm serve` in the foreground and the proxy as a child process. Press Ctrl-C to stop both.
Do not press Ctrl-Z: a suspended `fm serve` keeps its port.

To run the two processes yourself:

```bash
fm serve --port 1976
npx github:gregbarbosa/fm-proxy     # or: node fm-proxy.js
```

## Connect a client

- Base URL: `http://127.0.0.1:1977/v1`
- API key: any value. Most SDKs need one. The proxy ignores it.
- Models: `system`, the on-device model with a 4096-token window. On macOS 27.2 you can
  also use `pcc`, Private Cloud Compute, with a window of about 32k tokens.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:1977/v1", api_key="sk-local")
print(client.chat.completions.create(
    model="system",
    messages=[{"role": "user", "content": "Say hello in one word."}],
).choices[0].message.content)
```

`pcc` works only when `fm serve` starts in Terminal.app. From any other terminal, or from
an agent, `pcc` requests fail with `model_unavailable`. Each `pcc` request uses your
Private Cloud Compute quota; `GET /health` reports it.

## What works

| Feature | State |
|---|---|
| Chat completions, streaming and non-streaming | Works |
| Token usage on both paths | Works |
| Structured output (`response_format` with a JSON schema), including `$defs`, `definitions` and `$ref` | Works |
| Images, as a base64 `data:` URL in an `image_url` part | Works |
| `tool_choice: "auto"` | Works |
| Forced tool calls (`tool_choice: "required"` or a named function) | Works, through a translation |
| `tool_choice: "none"` | Works |
| CORS, `GET /v1/models`, `GET /health` | Works |

### Tool calling

`auto` goes to `fm serve` unchanged, and `fm serve` returns real `tool_calls`.

A **forced** call (`tool_choice: "required"`, or a named function) is translated into
structured output: each tool becomes one key of a schema, and the model fills in one
key. With five tools it picked the right tool 9 of 10 times at 142 prompt tokens.
`fm serve`'s own forced calls picked it 2 to 5 of 10 times at 507 tokens.

Caution: a forced call returns exactly one tool call, and it replaces your own
`response_format`. Use `auto` when a reply may need several calls.

With five or more tools, `auto` often picks the wrong one. Offer fewer tools, or force
the call.

## What the proxy corrects

| `fm serve` does this | The proxy does this |
|---|---|
| Returns an event stream when `stream` is absent | Sends `stream: false` |
| Sends streaming usage only on request | Always asks for it, and relays it |
| Ignores `max_tokens` | Maps it to `max_completion_tokens`, and reports `length` when the reply reached the cap |
| Rejects `stop` | Applies `stop` to the reply itself |
| Rejects the `developer` role | Sends it as `system` |
| Rejects `reasoning_effort` on `system` | Removes it for `system`. Forwards it to `pcc`, where it adds hidden reasoning tokens. |
| Rejects a `type` array such as `["string","null"]` | Keeps the first non-null type |
| Rejects a `$ref` it cannot resolve, and every `$ref` in tool parameters | Inlines every `$ref`, from `$defs` or `definitions`, and removes the tables |
| Rejects a titled string without an `enum`, which pydantic emits for every field | Removes `title` from every node that is not an object |
| Often generates without end on a nullable field, `anyOf:[X, {type:"null"}]` | Collapses the union to `X`, and removes the field from `required`. A reply can then omit a nullable field. |
| Works for about 2 minutes on a cyclic `$defs` schema, then fails | Rejects it at once with `400 cyclic_schema` |
| Rejects a tool with no `description` | Sends an empty description |
| Ignores `tool_choice: "none"` and writes a call as text | Removes the tools from the request |
| Routes forced calls poorly among many tools | Translates a forced call into structured output |
| Refuses requests with `Origin` or `Referer` headers | Removes them, so browser clients work |
| Refuses a body sent as `text/plain`, a form, or multipart | Sends the body as `application/json` |

## Errors

Errors come back in the OpenAI shape, `{"error": {"message", "type", "code"}}`, typed so
that a client can branch on the cause. An error before any output is an HTTP error with a
JSON body, also on a streaming request. An error after the stream started is an error
frame, then `[DONE]`. An `invalid_request_error` that `fm serve` sent as a 500 comes back
as a 400, so an OpenAI SDK does not retry it.

| `type` / `code` | Cause | Retry |
|---|---|---|
| `finish_reason: "content_filter"` | Apple's safety guardrail stopped the reply. The partial text is kept. Ordinary content can trigger it. | No. Change the request. |
| `invalid_request_error` / `context_length_exceeded` | The prompt is larger than the window. | No. Shorten the prompt. |
| `invalid_request_error` / `model_unavailable` | `pcc` outside Terminal.app. | No. |
| `invalid_request_error` / `cyclic_schema` | A `response_format` schema refers to itself. | No. |
| `invalid_request_error` / `json_object_unsupported` | `response_format: {"type": "json_object"}`. `fm serve` supports only `json_schema`. | No. Send a JSON schema. |
| `server_error` / `generation_parse_failed` | `fm serve` could not parse the arguments that the model generated. | No. |
| `invalid_request_error` / `provider_rejected` | A `--model-provider` server answered with a 4xx, such as an unknown model. | No. |
| `invalid_request_error` / `cross_site_refused` | `fm serve` refused the request as cross-site. The proxy removes the usual causes, so report this as a bug. | No. |
| `invalid_request_error` / `invalid_request` | Any other `400`, such as an unknown model or `n > 1`. | No. |
| `server_error` / `model_service_unavailable` | The on-device model service is in the `SensitiveContentAnalysisML error 15` state. It clears itself, in less than a minute to about 8 minutes. | Yes, after some minutes. The proxy does not retry it. |
| `rate_limit_exceeded` | A transient capacity error. The proxy has already retried it. | Yes, later. |
| `server_error` / `upstream_closed` | `fm serve` closed the connection before the reply ended. The proxy has already retried it if nothing was sent. | Yes. |
| `server_error` / `upstream_unreachable` | `fm serve` is not running. | After you start it. |

## Limits

- `system` has a 4096-token window. An agent harness with a large tool set or context
  file can fill it before the first message.
- `n > 1` is rejected. `parallel_tool_calls`, `logprobs`, and `top_logprobs` are
  accepted and ignored.
- An image must be a base64 `data:` URL. File paths and other part shapes are not
  supported.
- A `response_format` reply can still run away until the context is exceeded, about
  88 s later. Through the proxy, a pydantic schema with a nullable field did this in
  1 to 2 of 10 requests. Set a client timeout, and give a value for each field in the
  prompt.
- `fm serve` is beta software. Its behaviour changes between builds.

## Options

The proxy reads its configuration from the environment.

| Variable | Default | Effect |
|---|---|---|
| `PROXY_HOST` | `127.0.0.1` | The address the proxy listens on. Set `0.0.0.0` to open it to your network. |
| `PROXY_PORT` | `1977` | The port the proxy listens on. |
| `FM_PORT` | `1976` | The port `fm serve` listens on. |
| `FM_BIN` | `/usr/bin/fm` | The `fm` binary, used to count tokens when `fm serve` sends no usage. |
| `CORS_ORIGIN` | `*` | The value of `Access-Control-Allow-Origin`. |
| `FM_MAX_RETRIES` | `4` | Retries for a transient failure. `0` turns retries off. |
| `FM_RETRY_BASE_MS` | `1000` | The first retry delay. It doubles for each attempt. |
| `FM_RETRY_CAP_MS` | `15000` | The longest retry delay. |

Warning: the proxy ignores the API key. If you set `PROXY_HOST=0.0.0.0`, any host on
your network can use the model.

`fm-launch.sh` also takes `--fm-port`, `--proxy-port`, `--fm-bin`, and
`--health-timeout <ms>`. Run `./fm-launch.sh --help`.

## Development

```bash
npm test
```

| Path | Contents |
|---|---|
| `fm-proxy.js`, `src/` | The proxy. `AGENTS.md` has the code map. |
| `test/` | Unit and integration tests. They run without `fm`. |
| `tools/` | The wire baseline, the deviation probe, and the CLI reference generator. `tools/TEST_PLAN.md` explains them. |
| `docs/upstream-behaviour.md` | What `fm serve` does, in detail. |
| `docs/audit.md` | How to audit a new macOS build. |

[MIT](LICENSE)
