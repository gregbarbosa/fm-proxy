# fm-proxy test plan

Three layers. Run them in order. Each catches what the layer above cannot.

| Layer | Command | Catches | Needs a live model? |
|---|---|---|---|
| 1. Unit and integration | `node --test fm-proxy.test.js` | Schema logic, error typing, framing constants | No |
| 2. Wire baseline | `node tools/wire-baseline.js <out.json>` | Any change to what the proxy sends upstream or returns | No |
| 3. Harness check | `tools/harness-check.sh` | Whether a real client can actually use it | Yes |

## Layer 1 — unit and integration

`node --test fm-proxy.test.js`. Expect **108 pass, 0 fail**.

A skipped test means the `fm` CLI is unavailable. Check the licence with `fm license
--status`, which prints without prompting. Run `sudo fm license` only if it reports no
agreement.

## Layer 2 — wire baseline

The strongest check for "nothing changed". Model output is not repeatable, so this runs
the proxy against a recording stub instead of the real engine, and records the exact
bytes the proxy forwards for 14 fixed requests plus 3 endpoints.

```bash
export FM_BIN=/nonexistent   # see the caution below
git stash            # or check out the old revision
node tools/wire-baseline.js /tmp/before.json
git stash pop        # or check out the new revision
node tools/wire-baseline.js /tmp/after.json
diff /tmp/before.json /tmp/after.json && echo "no behaviour change"
```

Caution: the stub replaces the upstream engine, but it does not replace `fm`. The proxy
still shells out to `fm count-tokens` for its usage fallback, so a machine whose model
service is down produces a different baseline from the same code. That looks like a
behaviour change and is not one.

Set `FM_BIN` to a path that does not exist for both runs. The count then falls back to
the fixed `chars / 4.4` heuristic and the baseline depends only on the code. Both runs
must use the same setting, or the comparison is meaningless.

It pins every correction the proxy makes. A refactor that quietly drops one shows up as
a diff:

- `stream` omitted is forwarded as `stream:false`
- a streaming request gains `stream_options.include_usage`
- a missing `function.description` becomes `""`
- a `$ref` tool parameter arrives resolved, not as `{}`
- a `$defs` response schema arrives inlined, with no `$defs`
- a **cyclic** `$defs` schema keeps `$defs` and gains the dialect
- a `developer` message role is rewritten to `system`
- a `type: ["T","null"]` array collapses to `type: "T"`, in tool params and in
  `response_format`, at every depth

## Layer 3 — harness check

Start the stack first (`./fm-launch.sh`, or `fm serve` plus `node fm-proxy.js`), then:

```bash
tools/harness-check.sh          # on-device model
```

It asserts what a client depends on, rather than what the proxy intends:

1. A request that omits `stream` returns parseable JSON, not an event stream.
2. Non-streaming responses carry `usage.prompt_tokens` above zero, or a client's
   context gauge reads empty.
3. Every streaming frame parses as JSON.
4. The stream ends with `data: [DONE]`.
5. Exactly one usage frame arrives — not zero, not two.
6. A five-turn conversation reports more prompt tokens than a one-turn conversation.
7. `pi` completes a real round trip and returns the expected word.

### Expected result that is not a failure

`pi` reports "The session's transcript exceeded the model's context size". This is the
repo, not `pi`: the check runs here, and `pi` loads `AGENTS.md` as project context — one
40 KB file is ~8.4k tokens against a 4096-token window. The same `pi` command in an
empty directory assembles to 1188 tokens and returns 200. Beta 7 removed `pcc`, so there
is no larger window to fall back to. The script prints `KNOWN` for this case. Treat any
other pi failure as real.

As of 2026-08-31 the check reports a plain `FAIL` with an empty message instead, because
`pi` prints nothing at all. `pi` sends `max_completion_tokens: 1`, so the proxy labels
the reply `length`, and `pi` hides a turn it believes was truncated.

`length` is the honest label for a 1-token cap, so this check stays red until `pi` stops
asking for one token. Five tests pin the single-`finish_reason` behaviour.

## Before you trust a failure

The first request after `fm serve` starts can return no usage. That is warm-up. Re-run
once before you investigate.

If several unrelated checks fail at once, suspect a poisoned server rather than the
code: a cyclic `$defs` request hangs `fm serve` and it answers nothing afterwards. The proxy
now rejects those before they are forwarded, but a direct request still does it.
Restart `fm serve` and re-run.

Expect the first request after that restart to take about 25 seconds while the model
reloads. Do not read the delay as a second failure.

`com.apple.SensitiveContentAnalysisML error 15` is a different fault, and it is
environmental. Every request fails fast, including `fm respond`, so the fault sits below
`fm serve` and no restart of `fm serve` reaches it. It appears on a machine that is still
settling after an OS update, and it clears itself: on the 27.0 RC it cleared in about 20
to 30 minutes with no intervention. Wait before you investigate. An experiment on the RC
ruled out both the cyclic hang and a stop of `fm serve` as causes.

Note that `fm available` reports "System model available" throughout that fault. It is not
a health check. Test health with a real inference request.
