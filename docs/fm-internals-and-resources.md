# Foundation Models internals & resources

_Collected 2026-09-19 during the macOS 27.2 beta (`26B5086k`, `fm` 2.1.7.1.901) audit.
Audit-relevant facts live in `AGENTS.md`; this file is the deeper reference: what the
on-device stack is made of, where everything lives, how to see it again, and the
external resources worth keeping._

## The model family (from `modelmanagerd`'s own catalog logs)

```bash
log show --last 24h --debug \
  --predicate 'eventMessage CONTAINS "ModelCatalog"' | grep -E 'Looking up|Bundle policy'
```

One base model, many LoRA task adapters, plus specialist models — matching Apple's
published architecture (base + swappable adapters + draft models for speculative decoding):

| Bundle | What it is |
|---|---|
| `com.apple.fm.language.instruct_3b.fm_api_generic` | **the `system` model** — assets: `base`, `tokenizer`, `fm_api_generic`, `fm_api_generic.draft` (speculative decoding), `image_encoder` (vision input) |
| `com.apple.fm.language.instruct_3b.fm_api_content_tagger` | the `--use-case content-tagging` adapter |
| `com.apple.fm.language.instruct_3b.machine_translation` | translation adapter (+`.draft`) |
| `com.apple.fm.language.instruct_3b.messages_action` | Messages message-actions adapter (+`.draft`) |
| `com.apple.fm.language.instruct_3b.personalized_smart_reply` | Smart Reply adapter (+`.draft`) |
| `com.apple.fm.language.instruct_3b.summarization` | summarization adapter (Apple's paper example) (+`.draft`) |
| `com.apple.fm.language.instruct_3b.urgency_classification` | notification urgency adapter |
| `com.apple.fm.language.instruct_300m.*` | 300M family: `emoji_keyword_extraction`, `factual_consistency_classifier`, `open_ended_extract`, **`safety`** (the guardrail classifier) |
| `com.apple.fm.language.instruct_9m.text_event_extraction_classifier` | 9M micro-classifier |
| `com.apple.fm.language.instruct_server_v2.fm_api` | **PCC server model client bundle** — `base_zap`, `image_tokenizer_zap`, `tokenizer_zap` ("zap" assets). API description only; weights live on Apple's PCC servers |
| `com.apple.safety.output.configuration` | output safety config |
| `com.apple.tokeninputdenylist.template` | `com.apple.gm.safety_deny.input.foundation_models_framework.api`, `com.apple.gm.safety_embedding_deny.all` |
| `com.apple.tokenoutputdenylist.template` | same, for generated output |
| `com.apple.defaultoverrides` | `com.apple.gm.overrides.model_config.all` |
| `com.apple.fm.service.vlu.v1` | `com.apple.gm.pcc_inference_provider` — PCC inference wiring |

Per-adapter bundles resolve as `base` + `tokenizer` + adapter (+ `draft`); lookups are
language-scoped (`?language=en`).

## The vocabulary (what "49K vocab" means)

- The ~3B on-device model uses a **49,152-entry tokenizer vocabulary** with **shared
  input/output embedding tables** (Apple's tech report). The server model uses 100K,
  with extra multilingual and technical tokens.
- "Vocab" = the tokenizer's dictionary: the fixed set of tokens (subwords, characters,
  control tokens) that is the only thing the model can read or write. Each entry has a
  learned embedding; generation is a softmax over all 49K logits per step.
- The on-disk `…instruct_3b.tokenizer_14` asset **is** that vocabulary.
- The `<ctrl46>` marker that leaks into tool-call content is **control token #46 of this
  vocabulary** — the chat template's string delimiter — which is why it arrives whole in
  a single streaming chunk.
- Small vocab = small embedding table + cheap output layer on the Neural Engine.

## Where the weights live — and why you can't have them

- Asset domains: `/System/Library/AssetsV2/com_apple_MobileAsset_UAF_FM_{GenerativeModels,CodeLM,Visual,Overrides}/`
- All four return **EPERM even to `sudo ls`** — MAC on a `restricted` system path, not
  TCC (Full Disk Access does not help). Non-FM AssetsV2 domains read fine, so the block
  targets the AI weights specifically. This is a hardening change vs the macOS 15.1 era,
  when that path was publicly readable (that's how per-feature backend prompts leaked).
- The weights are **palletized mixed 2-bit/4-bit (~3.7 bits-per-weight average)** with
  fp16 LoRA adapters (10s of MB each) — not a plain bf16 checkpoint.
- `fm respond --model system --show-assets` prints the exact asset bundle IDs serving
  each inference — the sanctioned inventory window, and a fingerprint dimension
  finer-grained than the `fm` version.
- Dir mtimes on the four FM domains stamp the install event.
- `/var/db/com.apple.modelcatalog/tokenStore/` (readable) holds NSKeyedArchiver bplists —
  entitlement/token cache, not model data. `/var/db/modelmanagerd/` is root-only.

## PCC state on this machine (27.2 beta 1) — seed bug, not settling

Evidence trail, assembled 2026-09-18/19:

1. `fm respond -m pcc` outside Terminal.app → context gate: "Private Cloud Compute is
   not available in this context. Please use the Terminal app." (`ParentProcessGate`)
2. From Terminal.app → `systemNotReady` ("The system is not ready. Try again later."),
   reproduced over hours and after a **full reboot**.
3. Log capture during a Terminal.app attempt: iCloud check passes, `modelmanagerd`
   resolves fm's use case (`Apple.Group1.AutomationTools.Zap.FMCLI`) off its
   distribution signature, finds `instruct_server_v2.fm_api` — then
   `CS_VALIDATION_CATEGORY_INVALID` for fm's pid, `SecTaskCopyValueForEntitlement
   failed … with error`, concluded `Client missing entitlement
   com.apple.modelmanager.inference`.
4. `codesign -d --entitlements :- /usr/bin/fm` shows the binary **does** carry
   `com.apple.modelmanager.inference: true`.
5. Conclusion: the daemon's runtime read of a valid Apple signature is what broke —
   deterministic, survives reboot → file via Feedback Assistant with a sysdiagnose and
   the log excerpt. `system` stays healthy throughout.

## Diagnostics cookbook

```bash
# model asset IDs behind an inference
fm respond --model system --show-assets 'hi'

# modelmanagerd catalog (names + bundle policies)
log show --last 24h --debug --predicate 'eventMessage CONTAINS "ModelCatalog"'

# fm's own gate/readiness internals
log stream --level debug --predicate 'subsystem == "com.apple.fm"'

# capture exactly what fm POSTs to a provider (no model needed — fake SSE listener)
fm respond --model-provider http://127.0.0.1:19999 -m <id> 'hi'

# per-turn token ledger for fm chat via local providers
node tools/usage-tap.js    # then --model-provider lmstudio-tap; ledger ~/.fm/usage-tap.jsonl

# token counts (Apple tokenizer; framed vs raw)
fm count-tokens -i 'instructions' 'prompt'   # framed incl. chat-template markers
fm count-tokens --transcript ~/.fm/sessions/<session>.json
```

CLI surface notes (27.2 beta): 19 command nodes; 14 long options are hidden from human
`--help` but work — notably `fm chat --model-provider`, `--model-provider-header`,
`--guardrails`, `--use-case`; `respond` hides the `--stream/--no-stream` toggle and
`--show-assets`. `--guardrails` takes `default | permissive-content-transformations`;
`--use-case` takes `general | content-tagging` (observable behavior change).
Providers register as **bare hosts** — fm appends `/v1/chat/completions`.
Full option catalog: `docs/fm-reference.md` (regenerate with `tools/gen-fm-docs.py`).

## External resources

**Apple, primary**
- Adding server-side intelligence with PCC —
  https://developer.apple.com/documentation/foundationmodels/adding-server-side-intelligence-with-private-cloud-compute
  (PCC = 32K context, daily quota, reasoning levels; `systemNotReady` is a typed
  availability case; apps need the managed `com.apple.developer.private-cloud-compute`
  entitlement — https://developer.apple.com/private-cloud-compute/)
- `PrivateCloudComputeLanguageModel.Availability.UnavailableReason.systemNotReady` —
  https://developer.apple.com/documentation/foundationmodels/privatecloudcomputelanguagemodel/availability-swift.enum/unavailablereason/systemnotready
- `SystemLanguageModel.Guardrails` (`default`, `permissiveContentTransformations`) —
  https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/guardrails
- `SystemLanguageModel.init(useCase:guardrails:)` / `.UseCase` —
  https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/init(usecase:guardrails:)
- Introducing Apple Foundation Models (model family: ~3B on-device + PT-MoE server +
  coding + diffusion; palletization, adapters, 49K/100K vocab) —
  https://machinelearning.apple.com/research/introducing-apple-foundation-models
- Tech report: https://machinelearning.apple.com/research/apple-intelligence-foundation-language-models
- WWDC26: fm CLI & Python SDK (session 334), PCC (session 319), securing agentic
  features (session 347) — https://developer.apple.com/videos/play/wwdc2026/{334,319,347}/

**Community**
- Scripting fm / `ParentProcessGate` teardown (the four tty/ancestry rules, and why
  `fm serve` is the sanctioned PCC scripting path) —
  https://petegoldsmith.com/2026/07/02/2026-07-02-fm-pcc-not-available-in-this-context/
- fm-teardown (publicly-shipped-binary analysis; redistributes no weights) —
  https://github.com/llostinthesauce/fm-teardown
- FoundationModelsBench (signed-runner PCC benchmarking rules, PCC notes) —
  https://github.com/rudrankriyam/FoundationModelsBench/blob/main/docs/PCC.md
- FoundationRadar (measure availability/context/latency per device) —
  https://github.com/NagaYu/FoundationRadar
- Apple Intelligence backend prompts found in AssetsV2 (macOS 15.1 era, path now
  hardened) — https://simonwillison.net/2024/Aug/6/apple-intelligence-prompts/
- python-apple-fm-sdk#13 (maintainer: PCC goes through `fm serve`, not the SDK) —
  https://github.com/apple/python-apple-fm-sdk/issues/13

**Provider integrations probed 2026-09-19**
- z.ai GLM Coding Plan, OpenAI-compat base `https://api.z.ai/api/coding/paas/v4` —
  fm-incompatible as-is (fm appends `/v1/...`; z.ai aliases no `/v1` path). Docs:
  https://docs.z.ai/devpack/quick-start
- OpenCode Zen, base `https://opencode.ai/zen` — path-exact fit for fm, but free-tier
  models are client-gated ("free tier can only be used from within OpenCode"); paid
  models work. Docs: https://dev.opencode.ai/docs/zen/
- fm-ready OpenAI-compatible bases: Groq `https://api.groq.com/openai`, Cerebras
  `https://api.cerebras.ai`, Mistral `https://api.mistral.ai`, OpenRouter
  `https://openrouter.ai/api`, HuggingFace `https://router.huggingface.co`, NVIDIA NIM
  `https://integrate.api.nvidia.com`, Gemini
  `https://generativelanguage.googleapis.com/v1beta/openai`, Ollama
  `http://localhost:11434`, LM Studio `http://127.0.0.1:1234`. GitHub Models needs a
  path shim (no `/v1` segment).
