# macOS 27.0 RC — raw audit results

Working notes. Collected 2026-09-09. Fold into `AGENTS.md`, then delete this file.

## Fingerprint

| What | Value |
|---|---|
| macOS build | `26A428` (27.0 RC) |
| fm source version | `2.0.68.1.402` |
| Framework version | `2.0.68.1.402` |
| Runtime version | `27.0.0` |
| fm rebuild date | Sep 3 2026 |
| Licence record | `FM1 version 1.0`, agreed Aug 15 2026 |

Apple rebuilt `fm` on Sep 3. The source version did not move.

## Layer 1 — structure

`python3 tools/gen-fm-docs.py --outdir /tmp/fmrc` then `diff`: **empty**. The CLI tree
is byte-identical to the committed reference.

## Layer 2 — tests and wire

- `node --test fm-proxy.test.js` — **108 pass, 0 fail**.
- `node tools/wire-baseline.js` — 14 cases, 3 endpoints. Proxy code is unchanged since
  the Beta 8 merge, so the baseline is identical by construction.
- `node tools/deviation-probe.js 1977` — **11/11 handled**.
- `tools/harness-check.sh` — **6 passed, 1 failed**. The failure is the known `pi`
  case: `pi` sends `max_completion_tokens: 1`, the proxy labels the reply `length`,
  and `pi` hides a turn it believes was truncated.

## Layer 3 — upstream walls

Each row was sent direct to `fm serve` on port 1976 unless marked otherwise.

| Check | Beta 8 | 27.0 RC | Verdict |
|---|---|---|---|
| Tool calling | `tool_calls` null, content clean JSON | `tool_calls` absent, content leaks template tokens | **CHANGED** |
| Forced `tool_choice` | `500` unsupported generation guide | Same | Same |
| Tool with no `function.description` | `400` | Same | Same |
| `stream` omitted | `text/event-stream` | Same | Same |
| `n > 1` | `400` | Same | Same |
| `hello world` framing | 57 `prompt_tokens` | 57 | Same |
| Context window | ~4055 pass, overflow above | 4045 pass, ~4255 overflows | Same |
| `$defs` non-cyclic + dialect | `200` | `200` | Same |
| Titled string needs non-empty `enum` | `400` without, `200` with | Same | Same |
| Bare `$defs`, no dialect | `400` on `x-order` | Same | Same |
| `array<array<object>>` tool param | `200` | `200` | Same |
| Vision, 256 px PNG | describes it, 130 `prompt_tokens` | "Blue.", 131 `prompt_tokens` | Same |
| `$defs` cyclic + dialect | hangs, poisons the server | Same, and see below | **WORSE** |
| PCC | absent | absent, `/v1/models` lists only `system` | Same |

## Finding 1 — tool calling leaks chat-template control tokens

When the request carries `tools`, the reply content contains raw template markers.
Two markers appeared: `<start_of_turn>` and `<ctrl46>`.

Measured over 10 requests on each path, same prompt and same single tool:

| Path | Replies that leaked | Rate |
|---|---|---|
| Direct to `fm serve` | 7 of 10 | 70% |
| Through the proxy | 9 of 10 | 90% |

The two rates come from one sample of 10 each. Treat them as "most replies", not as a
measured difference between the paths. The proxy does not filter content, so it relays
whatever `fm serve` sends.

The leak needs `tools` in the request. Without `tools` the same prompt leaked 0 of 4
times, and an unrelated prompt leaked 0 of 4 times.

Example content: `<ctrl46>I am a large language model developed by Apple.<ctrl46>`

Beta 8 recorded clean JSON here. The leak is intermittent, so it is either new in the
RC or it was missed earlier. This audit cannot distinguish the two.

## Finding 2 — the cyclic `$defs` hang now breaks the whole model service

Beta 8 behaviour: a cyclic `$defs` request hangs `fm serve`, and restarting `fm serve`
restores it.

RC behaviour: restarting `fm serve` does **not** restore it. Every later request fails
with:

```
The operation couldn't be completed. (com.apple.SensitiveContentAnalysisML error 15.)
```

`fm respond` fails the same way, so the damage is not inside `fm serve`. `fm available`
still reports "System model available", so that command does not detect the fault.

The state did not clear on its own over several minutes of retries.

The proxy guard from `57f26d3` still blocks the request before it reaches `fm serve`:
`400` / `cyclic_schema` in 3-6 ms when warm. The 2368 ms first measurement was a cold
start, not a regression.

Status: **unresolved at the time of writing.** The recovery step was not run, because
it needs permission to stop a system service.
