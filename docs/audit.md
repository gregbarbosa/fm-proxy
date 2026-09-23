# Auditing a new macOS build

Apple changes `fm` between builds without notice. Run this audit after every OS update.

## `fm` CLI reference

Generate the full `fm` command tree before you work on the CLI surface:

```bash
python3 tools/gen-fm-docs.py
```

That writes `docs/fm-reference.md`, a per-command option table that greps well and reads
well as agent context. It runs `fm --experimental-dump-help` once, rather than scraping
`--help` recursively.

**The file is committed on purpose.** It is generated, so committing it is unusual, but
it is the only record of Apple's CLI surface per build. The committed copy is the "before"
side of the structure diff in the audit recipe below, and its history is how a change like
Beta 7's PCC removal stays visible. Read it for the build it was generated from, which
the release-history table names.

Regenerate it after any `fm` update and commit the result. Never hand-edit it: the source
of truth is the installed binary.

Some tools are local-only and are not in the repo: `tools/harness-check.sh` drives `pi`,
and `tools/ask-image.sh` is a manual probe. Deeper internals and the external resource
list (model catalog, vocab, asset protection, PCC bug trail, provider integrations) live
in `docs/fm-internals-and-resources.md`.

**Help-text vs dump.** The reference is generated from `--experimental-dump-help`, which
is a superset of human `--help`: 14 long options are hidden from the help text but real
and working (verified live per command). Notably `fm chat` hides `--model-provider`,
`--model-provider-header`, `--guardrails`, and `--use-case` — chat sessions do reach
custom providers. `respond` also hides the `--stream`/`--no-stream` toggle and
`--show-assets`; `count-tokens` hides `--label`, `--schema`, `--verbose`; `models` hides
`--guardrails`, `--model`, `--use-case`; `config add model-provider` hides its header
flag. Conversely, `fm schema object`'s type-builder flags (`--string`, `--nested`,
`--anyOf`, …) live in the command's discussion text, not the parsed arguments — the
reference carries them in the discussion block. Root help's MODELS section lists
`system`, `pcc`, and `<model>` — those are model names, not commands.

### Fingerprinting the `fm` version (no `--version` flag)

`fm --version` does **not** exist (errors "Unknown option"). To detect when Apple ships a
new `fm`/FoundationModels build across macOS betas, fingerprint the binary:

| What | How | Beta 2 value | Beta 3 value | Beta 4 value | Beta 5 value | Beta 6 value | Beta 7 value | Beta 8 value | 27.0 RC | 27.2 Beta | 27.2 Beta 2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fm source version | `otool -l /usr/bin/fm \| grep -A2 LC_SOURCE_VERSION` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` | `2.0.68.1.402` | `2.1.7.1.901` | `2.1.8.1.900` |
| Framework version | `plutil -p /System/Library/Frameworks/FoundationModels.framework/Resources/Info.plist \| grep CFBundleVersion` | `2.0.55.1.402` | `2.0.59` | `2.0.62.1.402` | `2.0.68.1.401` | `2.0.68.1.401` | `2.0.68.1.402` | `2.0.68.1.402` | `2.0.68.1.402` | `2.1.7.1.901` | `2.1.8.1.900` |
| Runtime version | `codesign -dvvv /usr/bin/fm` → `Runtime Version=` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.0.0` | `27.2.0` | `27.2.0` |
| Rebuild date | `ls -la /usr/bin/fm` (mtime) | Jun 19 2026 | Jul 3 2026 | Jul 17 2026 | Aug 7 2026 | Aug 14 2026 | Aug 21 2026 | Aug 27 2026 | Sep 3 2026 | Sep 13 2026 | Sep 19 2026 |
| macOS build | `sw_vers` → `BuildVersion` | `26A5368g` (27.0 Beta 2) | `26A5378j` (27.0 Beta 3) | `26A5388g` (27.0 Beta 4) | `26A5406e` (27.0 Beta 5) | `26A5416b` (27.0 Beta 6) | `26A5421a` (27.0 Beta 7) | `26A5425a` (27.0 Beta 8) | `26A428` (27.0 RC) | `26B5086k` (27.2 Beta) | `26B5091g` (27.2 Beta 2) |

New fingerprint dimension on the 27.2 beta: `fm respond --model system --show-assets`
prints the exact asset bundles behind each inference — on `26B5086k` that is
`com.apple.fm.language.instruct_3b.fm_api_generic.draft_14.1000.81321.13.205102,0`,
`…instruct_3b.tokenizer_14.1000.0.13.205099,0`, and
`…instruct_3b.fm_api_generic_14.1000.0.13.103386,0`. The on-device model is `instruct_3b`.
Asset IDs are finer-grained than the `fm` source version — they move when Apple swaps
weights without rebuilding the CLI. Check them alongside the binary in future audits.
The weights themselves are root-proof: all four `UAF_FM_*` AssetsV2 domains
(GenerativeModels, CodeLM, Visual, Overrides) return EPERM even to `sudo ls` — MAC on a
restricted system path, not TCC (Full Disk Access does not help; non-FM AssetsV2 domains
read fine). This is a hardening change vs the macOS 15.1 era, when that path was
publicly readable. Dir mtimes (Sep 18 17:51) stamp the install event; `--show-assets`
is the only sanctioned inventory window.

The model catalog itself leaks through `modelmanagerd` logs (`log show --last 24h --debug
--predicate 'eventMessage CONTAINS "ModelCatalog"'`). On `26B5086k` it lists, beyond
`instruct_3b.fm_api_generic` (the `system` model, with `image_encoder` and `.draft`
speculative-decode assets): seven `instruct_3b` task adapters (content_tagger,
machine_translation, messages_action, personalized_smart_reply, summarization,
urgency_classification), a `instruct_300m` family (emoji_keyword_extraction,
factual_consistency_classifier, open_ended_extract, **safety**), a 9M
text_event_extraction_classifier, the `instruct_server_v2` PCC client bundle ("zap"
assets), token input/output deny-list templates (`com.apple.gm.safety_deny.*`,
`com.apple.gm.safety_embedding_deny.all`), a safety output configuration, and
`com.apple.fm.service.vlu.v1` (`com.apple.gm.pcc_inference_provider`). Adapter-per-task
on a shared 3B base matches Apple's published architecture; `.draft` assets pair with
speculative decoding.

Audit recipe after any OS update:

1. **Structure** — regenerate the CLI tree and diff it against the committed copy:

   ```bash
   python3 tools/gen-fm-docs.py --outdir /tmp/fmnew
   diff docs/fm-reference.md /tmp/fmnew/fm-reference.md
   ```

   The tree is a compile-time dump, so a diff here is authoritative: Beta 7's was all
   deletions, which is how PCC's removal was caught.

   Commit the regenerated file as part of the audit, whether or not it changed. An empty
   diff is a result, and the commit records which build the tree belongs to.
2. **Behaviour** — the help tree can stay identical while behaviour changes, and the
   reverse also happens, so re-test the known walls separately. Run the three test
   layers in `tools/TEST_PLAN.md`, then re-check by hand:
   - tool calling — still broken upstream (`tool_calls` never populated)
   - `$defs` in `response_format` — an entry with no `title` 400s; a **cyclic** one
     hangs the model service, so test it last and wait for a control request to pass
   - forced `tool_choice` — raw `fm serve` still answers 500 "unsupported generation
     guide". Through the proxy it must return a real `tool_call`: forced dispatch now
     depends on `response_format` and constrained decoding continuing to work, so if
     Apple breaks those, forced tool calling breaks silently.
     `node tools/deviation-probe.js 1977` check 6 covers this.
   - a tool with no `function.description` — 400s the whole request
   - omitted `stream` — returns SSE, not JSON
   - `n > 1` — 400s
   - prompt framing — `hello world` should be 57 `prompt_tokens`
   - the 4096-token window — a ~4056-token prompt passes, ~8056 does not
   - tool-call content — check the reply text for `<start_of_turn>` and `<ctrl NN>`
     markers, and for a bare `{"tool_call": ...}` object. Send at least 10 requests,
     because the leak is intermittent
3. **Licence** — run `fm license --status` and `fm license --show`. Both print without
   prompting. Compare the agreed version and the terms with the licence paragraph in
   `docs/upstream-behaviour.md`.

Update the "Current behaviour" section of `docs/upstream-behaviour.md`, add a column to
the fingerprint table, and add a row to the release history below. Update the tested
build in the README.

Warning: a cyclic `$defs` request hangs the model service below `fm serve`. Run that test
last. A restart of `fm serve` does not clear the hang. Poll a control request until it
passes.

Caution: for the first hour after an OS update, do not trust a failure. The machine may
still be settling its model assets, and `com.apple.SensitiveContentAnalysisML error 15`
can appear and then clear itself. `fm available` does not detect that state.


## Release history

Beta 7 and later are the supported builds. The proxy carries no code for earlier ones.
This table records how the upstream behaviour arrived where it is. The table in
`docs/upstream-behaviour.md` is
authoritative for what is true now.

| Build | `fm` | What it changed |
|---|---|---|
| Beta 2 `26A5368g` | 2.0.55.1.402 | Baseline. On-device model flaky after the update. |
| Beta 3 `26A5378j` | 2.0.59 | Non-streaming token counts fixed. Nested tool params decoded natively. CORS preflight answered, real request still 403. |
| Beta 4 `26A5388g` | 2.0.62.1.402 | `token-count` renamed `count-tokens`; `--load-transcript` renamed `--resume`. Object chains of any depth decoded. |
| Beta 5 `26A5406e` | 2.0.68.1.401 | Licence gate added. `stream` default flipped to SSE. Tool calling broke. `$defs` with the dialect began hanging the server. |
| Beta 6 `26A5416b` | 2.0.68.1.401 | Rebuilt binary, identical CLI surface. No behaviour change. |
| Beta 7 `26A5421a` | 2.0.68.1.402 | **PCC removed from the binary**, with `fm quota-usage`. Non-cyclic `$defs` fixed. `array<array<object>>` accepted. Titled strings began requiring an `enum`. Audit fixed two proxy hazards in `57f26d3`: a forwarded cyclic schema, and a retried terminal 400. |
| Beta 8 `26A5425a` | 2.0.68.1.402 | Rebuilt binary, identical CLI surface. No behaviour change. Audit fixed a proxy bug: a capped stream emitted two `finish_reason` values. |
| RC `26A428` | 2.0.68.1.402 | Rebuilt binary, identical CLI surface. The RC audit found the tool-call marker leak. A clean-room record shows Beta 7 leaked too. |
| 27.2 Beta `26B5086k` | 2.1.7.1.901 | **PCC model returned**, gated to Terminal.app contexts, with `fm quota-usage` restored and `fm available` renamed `fm models`. New `--model-provider` / `--model-provider-header` routing with a `fm config` tree; `fm serve` routes non-built-in models upstream. Licence bumped to `FM1 version 1.1`, same operative clause. Audit: every known wall holds (tool calling, cyclic hang, framing 57, window 4096, 400s); marker leak persists; forced dispatch still works. PCC fails in this seed: modelmanagerd cannot read fm's inference entitlement at runtime, so `systemNotReady` is deterministic, not settling. |
| 27.2 Beta 2 `26B5091g` | 2.1.8.1.900 | Identical CLI surface, licence and model asset IDs. **PCC works from Terminal.app**, direct and through the proxy, with a window of about 32k: the entitlement fault is fixed. `$defs` entries no longer need `x-order` or `additionalProperties`. A cyclic `$defs` now hangs the model service below `fm serve` for about 2 minutes, and a restart of `fm serve` does not clear it. Tool-call content moved mostly to bare `{"tool_call": ...}` JSON, with markers in 1 of 20 replies. Every other wall holds. No proxy code change. |

Beta 7, Beta 8 and the RC shared `fm` 2.0.68.1.402 and a byte-identical help tree, so
only the binary's mtime distinguished them. The 27.2 beta broke that streak with a
version jump and a grown CLI surface. Either way the help tree does not show behaviour.
Audit both layers after any OS update.
