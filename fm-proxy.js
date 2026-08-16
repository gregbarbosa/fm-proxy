#!/usr/bin/env node
// fm-proxy.js - Fixes Apple fm serve compatibility with OpenAI-compatible clients
//
// fm serve has limited JSON Schema support for tool parameters:
//   - "required" must be present on the root object
//   - No anyOf, allOf, oneOf, if/then/else, not, patternProperties
//   - enum, minimum, maximum, additionalProperties are OK
//   - arrays of primitives are OK
//   - Nested objects and array<object> now decode natively (macOS 27 Beta 3 / fm
//     2.0.59 fixed the GenerationSchema `duplicateType` bug that used to block every
//     nested object). Verified live: object-in-object (chain depth 2), array<object>,
//     and object -> array -> object all decode correctly. Two shapes are STILL
//     broken and still need the JSON-string round-trip below: array<array<object>>
//     (2+ consecutive array wrappers landing on an object), and a chain of 3+
//     directly-nested object types (object -> object -> object). See
//     needsJsonRoundTrip.
//
// This proxy simplifies tool schemas to work within these limits.
//
// Usage: node fm-proxy.js
// Proxies http://127.0.0.1:1977 -> http://127.0.0.1:1976

const http = require("http");
const { execFileSync } = require("child_process");
const FM_PORT = Number(process.env.FM_PORT) || 1976;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 1977;

// fm serve has several DISTINCT mid-stream/request failure modes that this proxy must
// NOT conflate — clients need to tell them apart because the remedy differs:
//   1. Rate-limit / capacity: HTTP 200 then an error frame ("LanguageModelError -1"),
//      rejecting at admission before any text. Transient; retry with backoff (below).
//      PCC-only.
//   2. Safety-guardrail abort: the model emits valid output, THEN fm serve interrupts
//      ("The model's safety guardrails were triggered."). Deterministic + terminal +
//      PCC-only — retrying the identical request re-fails at the identical point, so we
//      do NOT retry; we surface it at once. Benign code triggers it, so it is NOT a
//      judgment that the user's content is unsafe.
//   3. Forced tool_choice on `system`: a request with `model:"system"` and
//      `tool_choice:"required"` (or a specific function pin) crashes fm serve with the
//      IDENTICAL "LanguageModelError -1" signature as #1 — but it's deterministic and
//      permanent (`pcc` handles it fine), not transient, so it must NOT be retried.
//      classifyError() distinguishes it from #1 by checking the original request.
// classifyError() maps each to an OpenAI-shaped outcome so clients can branch without
// string-matching Apple's prose:
//   - guardrail        → finish_reason:"content_filter" (keep partial; NOT an error — the
//                        OpenAI-idiomatic representation of a safety-stopped generation)
//   - rate-limit       → type:"rate_limit_exceeded" (retried, then surfaced)
//   - unavailability   → type:"service_unavailable" (terminal; e.g. missing PCC attribution)
//   - tool_choice crash → type:"invalid_request_error" (terminal, never retried)
// Set FM_MAX_RETRIES=0 to disable rate-limit retries.
const MAX_RETRIES = Number(process.env.FM_MAX_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.FM_RETRY_BASE_MS ?? 1000);
const RETRY_CAP_MS = Number(process.env.FM_RETRY_CAP_MS ?? 15000);

// ── Token counting ───────────────────────────────────────────────────────────
// Apple's `fm serve` used to report prompt_tokens as always 0 on non-streaming
// responses; that's fixed as of macOS 27 Beta 3 (fm 2.0.59) — verified live against
// `fm token-count`, non-streaming usage is now passed through untouched (see the
// non-streaming response handler). Streaming still sends NO usage at all (also
// verified live, still broken), so Pi's context gauge would sit at ~0% there without
// repair — this section still synthesizes usage for the streaming path only.
//
// Strategy (hybrid): exact count for the prompt (the big, stable number) via
// Apple's own `fm token-count`; cheap heuristic for the streamed completion.
//
// Calibration (measured against `fm token-count`):
//   per-turn chat-template overhead ≈ 9 tokens; content ≈ chars / 4.4.
const PER_TURN_OVERHEAD = 9;
const CHARS_PER_TOKEN = 4.4;
// Beta 5 (fm 2.0.68) framing constant: the fixed cost fm serve adds around a whole
// conversation, which `fm count-tokens` only includes when -i is passed. Measured
// as a flat 54 across prompt lengths 6–400 chars. See countPromptTokens.
const CONVERSATION_FRAMING = 54;

function estimateTokens(text) {
  if (!text) return 0;
  return PER_TURN_OVERHEAD + Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Flatten an OpenAI messages array into the text Apple's model actually sees.
// System messages map to instructions (-i); user/assistant/tool become the prompt.
function splitMessages(messages) {
  const instr = [];
  const prompt = [];
  for (const m of messages || []) {
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => p.text || "").join("")
        : "";
    if (m.role === "system") instr.push(content);
    else prompt.push(content);
  }
  return { instructions: instr.join("\n"), prompt: prompt.join("\n") };
}

// Exact token count via `fm token-count -q`. Text is piped on stdin to avoid
// argv length limits; optional instructions go through -i so the count includes
// their (heavier) template wrapping, matching how the server frames a turn.
// Returns null if the binary is missing or errors (callers fall back to the
// heuristic).
// Memoize counts: each call forks `fm` (a synchronous spawn that blocks the event
// loop), and the heavy inputs — system prompt and flattened tool schemas — repeat
// verbatim on every turn. Counts are a pure function of (text, instructions), so a
// keyed cache turns those repeats into free lookups. Bounded to keep memory flat.
const _tokenCache = new Map();
const _TOKEN_CACHE_MAX = 512;
// macOS 27 Beta 4 (fm 2.0.62) renamed `fm token-count` to `fm count-tokens` — the
// old name hard-errors. Probe the new name first, fall back to the old one (Beta 3
// compat), and remember whichever this build accepts so every later call spawns
// `fm` exactly once.
const _TOKEN_SUBCOMMANDS = ["count-tokens", "token-count"];
let _tokenSubcommand = null;
// macOS 27 Beta 5 (fm 2.0.68) added a machine-wide legal-notice gate: until a
// privileged user runs `sudo fm license`, every subcommand exits 69 and prints a
// banner to stderr. That failure is permanent, not transient, so retrying it once
// per count would spawn `fm` twice per message and echo the banner each time.
// Latch it on first sight, warn once, and fall back to the heuristic from then on.
let _fmLicenseGated = false;
function _isLicenseGate(err) {
  const text = String(err?.stderr || "") + String(err?.stdout || "");
  return err?.status === 69 && /LEGAL NOTICE & TERMS/.test(text);
}
function fmTokenCount(text, instructions) {
  // The count subcommand requires at least one input; skip the call entirely when
  // both are empty (e.g. tool-only turns) — the count is just the per-turn overhead.
  if (!text && !instructions) return PER_TURN_OVERHEAD;
  const key = (instructions || "") + "\0" + (text || "");
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  if (_fmLicenseGated) return null;
  let result = null;
  const candidates = _tokenSubcommand ? [_tokenSubcommand] : _TOKEN_SUBCOMMANDS;
  for (const sub of candidates) {
    try {
      const args = [sub, "-q"];
      if (instructions) args.push("-i", instructions);
      const out = execFileSync("/usr/bin/fm", args, {
        input: text || "",
        encoding: "utf8",
        timeout: 5000,
        // Capture stderr instead of inheriting it: the license banner would
        // otherwise print on every failed count.
        stdio: ["pipe", "pipe", "pipe"],
      });
      const n = parseInt(out.trim(), 10);
      if (Number.isFinite(n)) {
        result = n;
        _tokenSubcommand = sub;
        break;
      }
    } catch (err) {
      if (_isLicenseGate(err)) {
        _fmLicenseGated = true;
        console.error(
          "[fm-proxy] `fm` is blocked by the Apple Foundation Models CLI legal notice. " +
            "Token counts fall back to estimates. Run `sudo fm license` in Terminal.app to fix this.",
        );
        break;
      }
      // try the next name; leave _tokenSubcommand unset so a transient failure
      // (e.g. missing binary) re-probes rather than pinning a bad name
    }
  }
  // Cache only successful counts; a null is a transient failure worth retrying.
  if (result != null) {
    if (_tokenCache.size >= _TOKEN_CACHE_MAX) _tokenCache.clear();
    _tokenCache.set(key, result);
  }
  return result;
}

// Exact prompt token count for the full messages array. The fallback mirrors the
// exact path's single per-turn framing (one overhead, not one per concatenated
// string) by estimating the joined text in a single call.
function countPromptTokens(messages) {
  const { instructions, prompt } = splitMessages(messages);
  const n = fmTokenCount(prompt, instructions);
  if (n == null) return estimateTokens(instructions + "\n" + prompt);
  // Beta 5 split the two counting modes apart. With -i, `count-tokens` applies the
  // full conversation framing and matches fm serve's prompt_tokens EXACTLY (verified
  // 0 diff at instruction lengths 11–300 chars). Without -i it counts raw prompt
  // tokens only, landing a flat 54 below fm serve (verified 54 at prompt lengths
  // 6–400 chars). Add the framing back so a request with no system message reports
  // the same number as one that has one.
  return instructions ? n : n + CONVERSATION_FRAMING;
}

// ── Assembled-request instrumentation ────────────────────────────────────────
// The usage gauge (countPromptTokens) deliberately counts ONLY messages[].content
// — that is what Pi displays. But fm serve frames a much larger prompt: the
// flattened tool schemas, the assistant's prior tool_calls (which live in
// m.tool_calls, not m.content), and a per-turn template wrapper on EVERY turn.
// This breakdown measures the real assembled size so we can find PCC's true
// context ceiling empirically: log it for every request, then read off the value
// at the request where fm serve reports "transcript exceeded the model's context
// size". `fixedBody` is the post-fixTools payload actually forwarded upstream, so
// its `tools` are the flattened schemas the model really receives.
function assembledTokenBreakdown(parsedReq, fixedBody) {
  const messages = (parsedReq && parsedReq.messages) || [];
  // 1. messages content — the current gauge number.
  const msgTokens = countPromptTokens(messages);
  // 2. flattened tool schemas as forwarded to fm serve.
  let tools = (parsedReq && parsedReq.tools) || null;
  try { const f = JSON.parse(fixedBody); if (f && f.tools) tools = f.tools; } catch {}
  const toolsJson = tools && tools.length ? JSON.stringify(tools) : "";
  const toolTokens = toolsJson
    ? (fmTokenCount(toolsJson) ?? estimateTokens(toolsJson))
    : 0;
  // 3. assistant tool_calls — invisible to splitMessages (content is null).
  let toolCallText = "";
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (fn) toolCallText += (fn.name || "") + (fn.arguments || "");
      }
    }
  }
  const toolCallTokens = toolCallText
    ? (fmTokenCount(toolCallText) ?? estimateTokens(toolCallText))
    : 0;
  // 4. per-turn template framing applied once per non-system turn (the gauge
  //    collapses this to a single overhead for the whole concatenated prompt).
  const nonSystemTurns = messages.filter((m) => m.role !== "system").length;
  const perTurnExtra = PER_TURN_OVERHEAD * Math.max(0, nonSystemTurns - 1);
  const assembledTotal = msgTokens + toolTokens + toolCallTokens + perTurnExtra;
  return { msgTokens, toolTokens, toolCallTokens, perTurnExtra,
           turns: nonSystemTurns, assembledTotal };
}

function logBreakdown(tag, model, b) {
  console.error(
    `[assembled] ${tag} model=${model} turns=${b.turns} ` +
    `gauge(msgs)=${b.msgTokens} tools=${b.toolTokens} ` +
    `toolCalls=${b.toolCallTokens} perTurn=${b.perTurnExtra} ` +
    `=> assembled=${b.assembledTotal}`
  );
}

// Per-request throughput — completion tok/s, with TTFT for streaming. Emitted on
// every chat completion (NOT gated behind --verbose) so it surfaces in the
// launcher's quiet mode: a one-line, high-signal counter. `kind` is "stream" or
// "sync"; `durationMs` is generation time (streaming: first→last token,
// non-streaming: request-received→response-end, since upstream buffers the whole
// reply). Guards divide-by-zero and zero-token turns (tool-only / empty
// completions) so the line stays well-formed regardless of path.
function logToks(model, kind, completionTokens, durationMs, ttftMs) {
  const secs = durationMs / 1000;
  const tps = secs > 0 ? (completionTokens / secs) : 0;
  const ttft = ttftMs != null ? ` ttft=${Math.round(ttftMs)}ms` : "";
  console.error(
    `[toks] model=${model} ${kind} out=${completionTokens} ` +
    `dur=${secs.toFixed(2)}s${ttft} => ${tps.toFixed(1)} tok/s`
  );
}

// Exact completion token count for accumulated streamed text; heuristic on fail.
function countCompletionTokens(text) {
  const n = fmTokenCount(text);
  return n != null ? n : estimateTokens(text);
}

// Decorative keys fm serve ignores but that still cost prompt tokens. Stripped
// from every property (and every embedded shape) with no loss of capability.
const DECORATIVE = [
  "title", "examples", "default", "$schema", "$id", "$comment",
  "readOnly", "writeOnly",
];

const STRIP_KEYS = new Set([
  "anyOf", "allOf", "oneOf", "if", "then", "else", "not",
  "$defs", "definitions", "$ref", "patternProperties",
  "description", ...DECORATIVE,
]);

// Keys to drop when embedding a nested schema as a JSON string in a param
// description. The shape only needs to convey structure + types, so prose-heavy /
// decorative keys are pure bloat repeated for every nested field.
const EMBED_STRIP_KEYS = new Set([
  "description", "additionalProperties", ...DECORATIVE,
]);

// Collapse a composition keyword (anyOf/oneOf/allOf) into a single schema, then
// re-simplify. `mergeAll` (allOf) unions every subschema with siblings winning;
// otherwise we pick the first typed branch (or the first) and let siblings fill
// gaps non-destructively.
function flattenComposite(prop, key, mergeAll) {
  const subs = prop[key] || [];
  let merged;
  if (mergeAll) {
    merged = {};
    for (const sub of subs) if (sub && typeof sub === "object") Object.assign(merged, sub);
    for (const [k, v] of Object.entries(prop)) if (k !== key) merged[k] = v;
  } else {
    const base = subs.find((s) => s && typeof s === "object" && s.type) || subs[0] || { type: "string" };
    merged = { ...base };
    for (const [k, v] of Object.entries(prop)) if (k !== key && !(k in merged)) merged[k] = v;
  }
  return simplifyProperty(merged);
}

function simplifyProperty(prop) {
  if (!prop || typeof prop !== "object") return prop;

  // Collapse composition keywords to a single schema.
  if (prop.anyOf) return flattenComposite(prop, "anyOf", false);
  if (prop.oneOf) return flattenComposite(prop, "oneOf", false);
  if (prop.allOf) return flattenComposite(prop, "allOf", true);

  // Nested objects decode natively now (see the header comment) — recurse rather
  // than collapsing to string. A bare `properties` block (no explicit type) is
  // still an object; normalize it to type:"object" so it survives unambiguously.
  // Callers that hit one of the two still-broken shapes never reach here — they're
  // caught by needsJsonRoundTrip before simplifyProperty is called.
  if (prop.type === "object" || prop.properties) {
    const result = { type: "object", properties: {} };
    for (const [name, sub] of Object.entries(prop.properties || {})) {
      result.properties[name] = simplifyProperty(sub);
    }
    if (Array.isArray(prop.required)) {
      result.required = prop.required.filter((n) => n in result.properties);
    }
    if (prop.description) result.description = prop.description;
    return result;
  }

  // If it's an array, simplify items
  if (prop.type === "array") {
    const result = { type: "array" };
    if (prop.items) {
      result.items = simplifyProperty(prop.items);
    }
    if (prop.description) result.description = prop.description;
    return result;
  }

  // Keep primitive types, strip unsupported keys
  const result = {};
  for (const [k, v] of Object.entries(prop)) {
    if (!STRIP_KEYS.has(k)) result[k] = v;
  }
  return result;
}

// True if `prop`, once you strip away any number of array wrappers, bottoms out
// in an object type. Used only to test the leaf of a run of 2+ consecutive array
// wrappers (see needsJsonRoundTrip) — array<array<primitive>> is fine, but
// array<array<object>> is not, so the leaf type is what decides it.
function leafIsObjectThroughArrays(prop) {
  if (!prop || typeof prop !== "object") return false;
  if (prop.type === "array") return leafIsObjectThroughArrays(prop.items);
  return prop.type === "object" || !!prop.properties;
}

// A top-level param needs the JSON-string round-trip only for the ONE shape
// verified live against fm serve (Beta 4 / fm 2.0.62) to still be broken:
//   An object reachable through 2+ consecutive array wrappers
//   (array<array<object>> and deeper) — Beta 4 errors with
//   "Failed to parse generated content" (Beta 3 silently omitted the
//   argument). array<array<number>> (a primitive leaf) is fine.
// Chains of 3+ directly-nested object types leaked internal `$defs` naming on
// Beta 3 and were round-tripped then; Beta 4 decodes them correctly (verified
// live, repeated trials, system + pcc, incl. a 4-level chain) so object
// nesting to any depth now passes through natively and must NOT be
// round-tripped.
function needsJsonRoundTrip(prop, arrayRun = 0) {
  if (!prop || typeof prop !== "object") return false;
  if (prop.type === "array") {
    const run = arrayRun + 1;
    if (run >= 2 && leafIsObjectThroughArrays(prop.items)) return true;
    return needsJsonRoundTrip(prop.items, run);
  }
  if (prop.type === "object" || prop.properties) {
    return Object.values(prop.properties || {}).some((sub) =>
      needsJsonRoundTrip(sub, 0));
  }
  return false;
}

// Returns { schema, jsonFields } — jsonFields lists top-level params that were
// turned into JSON strings and must be JSON.parse'd back on the response.
function fixToolSchema(schema) {
  const result = { type: "object", required: [] };
  const jsonFields = [];
  if (!schema || typeof schema !== "object") {
    result.properties = {};
    return { schema: result, jsonFields };
  }

  result.properties = {};
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    if (needsJsonRoundTrip(prop)) {
      jsonFields.push(name);
      const shape = JSON.stringify(prop, (k, v) =>
        EMBED_STRIP_KEYS.has(k) ? undefined : v);
      const desc = prop.description ? prop.description + " " : "";
      // "must be a quoted JSON string, not raw JSON" is load-bearing: Beta 4's
      // parser deterministically 500s ("Failed to parse generated content") when
      // the model emits raw JSON in a string slot, and the old "JSON string
      // matching:" phrasing reliably provoked exactly that. Verified live 4/4.
      result.properties[name] = {
        type: "string",
        description: `${desc}A JSON-encoded string value (must be a quoted JSON string, not raw JSON) matching: ${shape}`,
      };
    } else {
      result.properties[name] = simplifyProperty(prop);
    }
  }
  // Preserve the caller's `required` list. Dropping it told fm serve every param
  // was optional, so the model would emit partial/empty tool calls (e.g. edit with
  // `{}`) that the client then rejects against the real schema. JSON-round-tripped
  // params keep their name (only the value becomes a string), so names carry over.
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return { schema: result, jsonFields };
}

// ── response_format schema dialect (structured output) ──────────────────────
// fm serve's response_format json_schema dialect (constrained decoding) requires
// title + x-order (property order) + required + additionalProperties on every
// object schema reached through `$defs` -- verified live (2026-07-06, fm 2.0.59):
// a $defs entry (or any object nested inside one -- inline sub-properties, array
// items -- recursively) missing any of these 400s with a DecodingError naming the
// exact key (`keyNotFound 'x-order'`, "Object schemas require a 'title' key", a
// missing 'required', a missing 'additionalProperties'). The TOP-LEVEL schema and
// any object reached ONLY through inline `properties` nesting (never touching
// $defs) need NONE of this -- verified live, flat and multi-level inline-nested
// schemas decode with zero dialect keys. This corrects the earlier (2026-06-14)
// finding, which only tested $ref/$defs-shaped schemas and concluded the dialect
// was required "on every object level". Real schema generators (pydantic
// `.model_json_schema()`, zod-to-json-schema, TypeBox, ...) virtually always emit
// $defs/$ref for any named/reused type, so this gap breaks structured output for
// real clients unless corrected here -- scoped narrowly to $defs (rather than
// decorating every object unconditionally) to avoid needless token bloat on the
// (dialect-free) inline portion of the schema.
function isDialectObjectSchema(s) {
  return !!(s && typeof s === "object" && (s.type === "object" || s.properties));
}

function capitalizeTitle(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : "Object";
}

// Recursively injects the dialect into every object schema under `node` (only ever
// walked from inside $defs -- see fixResponseFormatSchema). `titleHint` names this
// node if it turns out to be an object: the $defs key for a top-level definition, or
// the capitalized property name for anything nested inside one.
function decorateDialect(node, titleHint) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (node.items) decorateDialect(node.items, titleHint);
  if (!isDialectObjectSchema(node)) return;
  const props = node.properties || {};
  for (const [name, sub] of Object.entries(props)) decorateDialect(sub, capitalizeTitle(name));
  node.type = "object";
  if (!node.title) node.title = titleHint;
  node["x-order"] = Object.keys(props);
  node.required = Array.isArray(node.required) ? node.required.filter((n) => n in props) : [];
  if (typeof node.additionalProperties !== "boolean") node.additionalProperties = false;
}

// Replace every `$ref: "#/$defs/Name"` with a copy of the definition it points at, then
// drop `$defs` entirely. Returns a new schema, or null if the schema cannot be inlined
// (a cyclic or unresolvable ref) so the caller can fall back.
//
// Sibling keys beat the target's, per JSON Schema 2020-12: `{$ref, description}` keeps
// its own description. Each branch carries its own `active` set, so a definition reused
// in two sibling properties inlines twice (fine) while a definition that reaches itself
// is a cycle (not fine — inlining would not terminate).
const DEFS_REF_PREFIX = "#/$defs/";
function inlineDefs(schema) {
  const defs = schema.$defs;
  let bailed = false;
  const walk = (node, active) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, active));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const name = node.$ref.startsWith(DEFS_REF_PREFIX) ? node.$ref.slice(DEFS_REF_PREFIX.length) : null;
      if (name === null || !Object.prototype.hasOwnProperty.call(defs, name) || active.has(name)) {
        bailed = true;
        return node;
      }
      const { $ref, ...siblings } = node;
      return { ...walk(defs[name], new Set(active).add(name)), ...siblings };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, active);
    return out;
  };
  const result = walk(schema, new Set());
  delete result.$defs;
  return bailed ? null : result;
}

// Normalise a response_format `schema` into something fm serve accepts.
//
// Preferred path: inline the $refs and delete $defs. An object reached only through
// inline `properties` nesting needs NO dialect keys at all (verified live), so this
// makes a $defs schema work without decorating anything. It also avoids two separate
// upstream failures: fm serve 400s a $defs object that lacks `x-order`, and on macOS 27
// Beta 5 (fm 2.0.68) a $defs object that HAS the dialect hangs the `system` engine
// indefinitely and leaves the server unable to answer anything until it is restarted.
//
// Fallback: a cyclic or unresolvable $ref cannot be inlined (a self-referencing tree
// schema would expand forever). Those keep the old dialect injection — the best
// available on Beta 3/4, and no worse than before on Beta 5.
function fixResponseFormatSchema(schema) {
  if (!schema || typeof schema !== "object" || !schema.$defs) return schema;
  const inlined = inlineDefs(schema);
  if (inlined) return inlined;
  for (const [name, def] of Object.entries(schema.$defs)) decorateDialect(def, name);
  return schema;
}

// Rewrites request tools into fm-serve-compatible schemas. Returns the rewritten
// body, a coercion map (toolName -> [jsonField names]) for re-expansion on the
// response, and the parsed request object (or null) so callers needn't re-parse.
function fixTools(body) {
  try {
    const parsed = JSON.parse(body);
    const coercion = {};
    if (parsed.tools) {
      parsed.tools = parsed.tools.map((tool) => {
        const { schema, jsonFields } = fixToolSchema(tool.function?.parameters);
        if (jsonFields.length && tool.function?.name) {
          coercion[tool.function.name] = jsonFields;
        }
        // fm serve (Beta 3 / fm 2.0.59, verified live) 400s the ENTIRE request
        // ("Invalid JSON: The data couldn't be read because it is missing.")
        // if ANY tool's function.description is absent or null — independent of
        // that tool's parameters shape, tool_choice, or which tool is actually
        // called. An empty string is accepted. OpenAI's spec makes description
        // optional, so a compliant client can send exactly the shape that
        // breaks fm serve; backfill it here rather than erroring.
        const description = tool.function?.description;
        return {
          ...tool,
          function: {
            ...tool.function,
            description: description == null ? "" : description,
            parameters: schema,
          },
        };
      });
    }
    if (parsed.response_format && parsed.response_format.type === "json_schema") {
      const js = parsed.response_format.json_schema;
      // Assign the result: inlining returns a NEW schema rather than mutating in place.
      if (js && js.schema) js.schema = fixResponseFormatSchema(js.schema);
    }
    return { body: JSON.stringify(parsed), coercion, parsed };
  } catch {
    return { body, coercion: {}, parsed: null };
  }
}

// Re-expand JSON-string params in a tool_call's arguments back into real objects.
// `args` is the JSON string from the model; returns a (possibly) rewritten string.
function expandToolCallArguments(toolName, argsStr, coercion) {
  const fields = coercion[toolName];
  if (!fields || !fields.length) return argsStr;
  try {
    const obj = JSON.parse(argsStr);
    let changed = false;
    for (const f of fields) {
      if (typeof obj[f] === "string") {
        try { obj[f] = JSON.parse(obj[f]); changed = true; } catch {
          // Beta 4 model quirk (seen live): HTML entities (&quot; etc.) in place
          // of escaped quotes inside the round-tripped JSON string. One-shot
          // entity decode, then retry; still-unparseable values are left as-is.
          const decoded = obj[f]
            .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
            .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
          try { obj[f] = JSON.parse(decoded); changed = true; } catch { /* leave */ }
        }
      }
    }
    return changed ? JSON.stringify(obj) : argsStr;
  } catch {
    return argsStr;
  }
}

// Apply expandToolCallArguments to every tool_call in an OpenAI tool_calls array
// (both streaming delta and non-streaming message shapes). Mutates in place;
// returns true if any arguments string was rewritten.
function rewriteToolCalls(toolCalls, coercion) {
  let changed = false;
  for (const tc of toolCalls) {
    const fn = tc && tc.function;
    if (!fn || typeof fn.arguments !== "string") continue;
    const next = expandToolCallArguments(fn.name, fn.arguments, coercion);
    if (next !== fn.arguments) { fn.arguments = next; changed = true; }
  }
  return changed;
}

// True if `toolChoice` forces the model to call something: OpenAI's "required", or an
// explicit {type:"function", function:{name}} pin. "auto"/absent doesn't force a call.
function isForcedToolChoice(toolChoice) {
  return toolChoice === "required" ||
    !!(toolChoice && typeof toolChoice === "object" && toolChoice.type === "function");
}

// Classify an upstream fm-serve error message into a distinct OpenAI-shaped error type
// so clients can branch on the *cause* rather than string-matching Apple's prose. The
// failure modes (see header comment) need different client remedies:
//   - rate-limit: transient, retry.
//   - safety-guardrail abort: deterministic + terminal, do NOT retry.
//   - forced tool_choice on `system`: deterministic + terminal, do NOT retry.
// `retry` tells the streaming/non-stream paths whether backoff is worthwhile.
// `parsedReq` (the original request body) is optional context used only to distinguish
// the tool_choice crash below from a real rate limit — every call site has it in scope
// and passes it; omitting it just skips that one distinction.
function classifyError(msg, parsedReq) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("guardrail"))
    return { type: "generation_aborted", code: "safety_guardrail", retry: false, label: "SAFETY-GUARDRAIL ABORT" };
  // PCC attribution / "not available in this context" (ModelManagerError 1013, HTTP 503
  // service_unavailable): deterministic + stable for the process's lifetime — retrying
  // just wastes ~15s. Distinct from a transient capacity 503.
  if (m.includes("not available in this context") || m.includes("service_unavailable"))
    return { type: "service_unavailable", code: "model_unavailable", retry: false, label: "MODEL UNAVAILABLE (PCC attribution)" };
  // Beta 4's stricter tool-call parser rejects malformed generated arguments with
  // this message. Deterministic for a given request (verified live, 5/5 identical
  // failures — e.g. a model emitting raw JSON where the schema says string), so
  // retrying just burned the full ~35s backoff ladder. Typed server_error: the
  // failure is the model/decoder's, not the client's.
  if (m.includes("failed to parse generated content"))
    return { type: "server_error", code: "generation_parse_failed", retry: false, label: "GENERATION PARSE FAILED" };
  // Beta 5 (fm 2.0.68) re-worded the forced-tool_choice crash: the `system` engine now
  // rejects it with a clean 500 "An unsupported generation guide was used." in ~140ms
  // instead of Beta 3/4's LanguageModelError -1. That new wording matches none of the
  // branches below, so without this it fell through to the retryable default and burned
  // the whole backoff ladder on a permanent request-shape rejection. Terminal by
  // construction: the generation guide is fixed by the request, so a retry sends it again.
  if (m.includes("unsupported generation guide"))
    return { type: "invalid_request_error", code: "tool_choice_unsupported", retry: false,
             label: "UNSUPPORTED GENERATION GUIDE (forced tool_choice)" };
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit")) {
    // Beta 3 bug (verified live): tool_choice:"required" (or a forced function) crashes
    // fm serve's `system` engine with this EXACT signature — deterministic and
    // permanent, not a rate limit. `pcc` handles forced tool_choice fine, so this is
    // scoped to `system` only. Must be checked here, before the generic rate-limit
    // branch, or the proxy retry-loops a permanent request-shape bug for ~19.5s before
    // surfacing it mislabeled as transient.
    if (parsedReq && parsedReq.model === "system" && isForcedToolChoice(parsedReq.tool_choice)) {
      return { type: "invalid_request_error", code: "tool_choice_unsupported", retry: false,
               label: "TOOL_CHOICE CRASH (system engine)" };
    }
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  }
  return { type: "server_error", code: "internal_error", retry: true, label: "UPSTREAM ERROR" };
}

// Build an SSE error frame (`data: {"error":{...}}\n\n`) carrying a typed OpenAI error.
function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({
    error: { message: msg || "upstream error", type: cls.type, code: cls.code },
  })}\n\n`;
}

// Exported for tests when required as a module; harmless when run directly.
if (require.main !== module) {
  module.exports = { fixTools, fixToolSchema, fixResponseFormatSchema, expandToolCallArguments, classifyError, errorFrame, fmTokenCount, _isLicenseGate };
}

// CORS so browser-based OpenAI clients (open-webui, web apps hitting the base URL
// directly) clear their preflight. Origin is `*` by default; override with
// CORS_ORIGIN. Applied to every response via relayHead and the raw writeHead paths
// so no response can slip out without it.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_HEADERS = {
  "access-control-allow-origin": CORS_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // `*` covers Content-Type and the OpenAI SDK's x-stainless-* headers, but per
  // the Fetch spec the wildcard does NOT cover Authorization — it must be named
  // explicitly or browser preflight for the API key would fail.
  "access-control-allow-headers": "Authorization, *",
  "access-control-max-age": "86400", // cache preflight a day; fewer round-trips
};
function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

// Copy upstream headers and either set Content-Length (non-stream, known body) or
// drop it (stream, chunked). One place so the two response paths can't desync.
// CORS headers are merged in here so every committed response carries them.
function relayHead(res, statusCode, upstreamHeaders, bodyLen) {
  const headers = { ...upstreamHeaders, ...CORS_HEADERS };
  // The proxy manages its own framing: it either sets Content-Length (buffered
  // body) or streams chunked. Never relay upstream's Transfer-Encoding, or the
  // response carries both CL and TE — illegal framing the client can't parse.
  delete headers["transfer-encoding"];
  if (bodyLen == null) delete headers["content-length"];
  else headers["content-length"] = bodyLen;
  res.writeHead(statusCode, headers);
}

const server = http.createServer((req, res) => {
  // CORS preflight: answer immediately, before buffering any body.
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Decode as UTF-8 so multibyte characters split across TCP chunk boundaries are
  // reassembled by Node's StringDecoder instead of corrupting into U+FFFD.
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("error", () => { /* client aborted upload; nothing to forward */ });
  req.on("end", () => {
    const reqStart = Date.now();
    const { body: toolFixed, coercion, parsed: parsedReq } = fixTools(body);

    const isChat = req.url && req.url.includes("/chat/completions");
    const isStream = !!(parsedReq && parsedReq.stream);

    // fm serve (macOS 27 Beta 3+) sends a REAL usage chunk on a streaming
    // completion, but only when the request opts in via the standard OpenAI
    // `stream_options.include_usage:true` field — real clients (Pi included)
    // essentially never set it. Force it upstream on every streaming request
    // regardless of what the client sent, so the proxy always has fm serve's
    // real numbers to relay (see the streaming end-of-stream handler below)
    // instead of falling back to the completion-text estimate. The CLIENT's
    // own ask about what THEY get back is still honored separately: explicit
    // `include_usage:false` suppresses the usage field on the way out; absent
    // or `true` keeps the proxy's established always-on usage chunk.
    const clientDeclinedUsage = !!(
      parsedReq &&
      parsedReq.stream_options &&
      parsedReq.stream_options.include_usage === false
    );
    let fixed = toolFixed;
    if (isStream && parsedReq) {
      parsedReq.stream_options = { ...(parsedReq.stream_options || {}), include_usage: true };
      fixed = JSON.stringify(parsedReq);
    } else if (isChat && parsedReq && parsedReq.stream === undefined) {
      // macOS 27 Beta 5 (fm 2.0.68) flipped the default: a chat request that OMITS
      // `stream` now comes back as text/event-stream, where every earlier build (and
      // the OpenAI spec) returns a single JSON object. Only an explicit
      // `stream:false` still selects JSON. Clients that never set the field — most
      // OpenAI SDKs — would get an SSE body they cannot parse, so pin it here.
      parsedReq.stream = false;
      fixed = JSON.stringify(parsedReq);
    }
    // Compute the full assembled size fm serve actually frames (messages + tool
    // schemas + assistant tool_calls + per-turn framing). This drives the
    // instrumentation log, and is still the reported prompt_tokens for the
    // streaming and guardrail-fallback paths (fm serve sends no real usage there).
    // The normal non-streaming success path now trusts fm serve's own accurate
    // prompt_tokens instead (see the non-streaming response handler) — this estimate
    // reads ~4x low if it were used there, which is exactly what made the transcript
    // blow past PCC's ~32k ceiling unwarned before fm serve's own number could be
    // trusted. Set GAUGE_MODE=msgs to fall back to the old messages-only number.
    let breakdown = null;
    if (isChat && parsedReq) {
      breakdown = assembledTokenBreakdown(parsedReq, fixed);
      logBreakdown("req", parsedReq.model || "unknown", breakdown);
    }
    const promptTokens = !isChat || !parsedReq
      ? 0
      : process.env.GAUGE_MODE === "msgs"
        ? breakdown.msgTokens
        : breakdown.assembledTotal;

    // One-line diagnostic binding a failure to this request's real assembled size
    // (the empirical PCC ceiling) — shared by the HTTP-status, context-overflow,
    // and stream-aborted cases so they stay in sync.
    const diag = (label, extra = "") => console.error(
      `[assembled] *** ${label} *** assembled=` +
      `${breakdown ? breakdown.assembledTotal : "?"} (gauge ${promptTokens})` +
      (extra ? ` ${extra}` : "")
    );

    // An SSE/JSON frame is an upstream *error* (not content) when it carries a
    // top-level `error` and no usable choices — that's the rate-limit signature.
    const isErrorPayload = (obj) =>
      obj && obj.error && !(obj.choices && obj.choices.length);

    // State shared across retry attempts. The client response (`res`) is the one
    // thing that persists; we don't commit its head until a good frame arrives so
    // a failed attempt can be replayed invisibly.
    let clientGone = false;
    let retryTimer = null;
    let activeProxyReq = null;

    // If the client disconnects, cancel any pending retry and tear down upstream.
    res.on("close", () => {
      clientGone = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (activeProxyReq) activeProxyReq.destroy();
    });
    res.on("error", () => { if (activeProxyReq) activeProxyReq.destroy(); });

    function scheduleRetry(attempt, reason) {
      if (attempt + 1 > MAX_RETRIES || clientGone) return false;
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
      diag(`RETRY ${attempt + 1}/${MAX_RETRIES}`, `after ${reason}; waiting ${delay}ms`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!clientGone) forward(attempt + 1);
      }, delay);
      return true;
    }

    // We always forward a fully-buffered body and set our own Content-Length, so
    // any inbound Transfer-Encoding (e.g. a client that streamed its upload with
    // chunked encoding) must be dropped — keeping both is illegal framing and
    // upstream rejects it with HPE_INVALID_CONTENT_LENGTH.
    const upstreamHeaders = { ...req.headers, "content-length": Buffer.byteLength(fixed) };
    delete upstreamHeaders["transfer-encoding"];

    function forward(attempt) {
      let aborting = false; // set when we tear the upstream down to retry
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: FM_PORT,
          path: req.url,
          method: req.method,
          headers: upstreamHeaders,
        },
        (proxyRes) => {
          proxyRes.setEncoding("utf8"); // same multibyte-safety as the request side
          if (isChat) diag(`UPSTREAM RESPONSE HTTP ${proxyRes.statusCode}`);
          proxyRes.on("error", (e) => { if (isChat) diag("UPSTREAM RES SOCKET ERROR", `— ${e.message}`); });

          // Only intervene on chat completions; everything else passes through.
          if (!isChat) {
            res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
            proxyRes.pipe(res);
            return;
          }

          // The client head is "committed" once we've written it (stream) or are
          // about to (non-stream). Before commit, a failure is retryable.
          let committed = false;
          const commit = () => {
            if (committed) return;
            committed = true;
            if (isStream) {
              relayHead(res, proxyRes.statusCode, proxyRes.headers, null);
              if (proxyRes.statusCode !== 200) diag(`UPSTREAM HTTP ${proxyRes.statusCode}`);
            }
          };
          // Abandon this attempt and retry if we haven't committed yet. Returns
          // true if a retry was scheduled (caller must stop touching the stream).
          const fail = (reason) => {
            if (committed || aborting) return false;
            if (!scheduleRetry(attempt, reason)) return false;
            aborting = true;
            proxyRes.destroy();
            proxyReq.destroy();
            return true;
          };

          if (isStream) {
            // Streaming: fm serve sends a real final usage-only chunk now that we
            // force stream_options.include_usage upstream (see realUsage below).
            // Still accumulate completion text as a fallback estimate for upstreams
            // that ignore the flag, and inject our own final chunk before [DONE]
            // either way (so clients always see usage, or real numbers when we have
            // them — see the end-of-stream handler).
            let completionText = "";
            let realUsage = null;   // fm serve's own usage object, if it sent one
            let sawFinish = false;  // a clean finish_reason or [DONE] arrived
            let producedOutput = false; // any content or tool_calls delta seen
            let tFirstToken = null;  // wall-clock of first output delta (TTFT + tok/s)
            let pending = "";       // line buffer across chunk boundaries
            let lastChunkMeta = null;
            let rawTail = "";       // last bytes of the upstream stream, for failure forensics
            let surfacedError = false; // we already forwarded a typed error frame
            let abortFinishReason = null; // set to "content_filter" on a guardrail abort
            // PCC always opens a stream with an empty {"delta":{"role":"assistant"}}
            // preamble, THEN either real output or an error frame. We must NOT commit
            // the client head on that preamble, or an error arriving right after it
            // would look post-commit and be unretryable. So buffer pre-output frames
            // and only commit on the first meaningful frame (content/tool_calls/finish).
            const preBuffer = [];
            const flushPre = () => { for (const l of preBuffer) res.write(l); preBuffer.length = 0; };
            const commitFlush = () => { commit(); flushPre(); };

            function pump(s, flush) {
              pending += s;
              let idx;
              while ((idx = pending.indexOf("\n")) !== -1 || (flush && pending.length)) {
                if (aborting) return;
                const line = idx !== -1 ? pending.slice(0, idx + 1) : pending;
                pending = idx !== -1 ? pending.slice(idx + 1) : "";
                const t = line.trim();
                // Context overflow is deterministic — never retry it, just surface.
                if (t.toLowerCase().includes("exceeded the model's context size")) {
                  diag("CONTEXT EXCEEDED", `— line: ${t}`);
                }
                let obj = null, isErr = false, errCls = null, meaningful = false;
                if (t.startsWith("data:")) {
                  const payload = t.slice(5).trim();
                  if (payload === "[DONE]") { sawFinish = true; if (!committed) commitFlush(); continue; }
                  try {
                    obj = JSON.parse(payload);
                    isErr = isErrorPayload(obj);
                    if (isErr) {
                      errCls = classifyError(obj.error && obj.error.message, parsedReq);
                    } else if (obj.usage && (!obj.choices || obj.choices.length === 0)) {
                      // fm serve's real final usage-only chunk (choices:[], usage:{...}),
                      // present because we forced stream_options.include_usage upstream.
                      // Capture it; never relay this raw frame — the end-of-stream handler
                      // below emits the client-facing chunk using these real numbers (or
                      // the completionText-based estimate as a fallback if this never
                      // arrives), respecting the client's own usage opt-in/opt-out.
                      realUsage = obj.usage;
                      continue;
                    } else {
                      lastChunkMeta = { id: obj.id, model: obj.model, created: obj.created };
                      const ch0 = obj.choices && obj.choices[0];
                      if (ch0 && ch0.finish_reason) { sawFinish = true; meaningful = true; }
                      const delta = ch0 && ch0.delta;
                      if (delta && typeof delta.content === "string") {
                        if (tFirstToken == null) tFirstToken = Date.now();
                        completionText += delta.content; producedOutput = true; meaningful = true;
                      }
                      // Re-expand JSON-string tool-call args back to real objects.
                      if (delta && Array.isArray(delta.tool_calls)) {
                        if (tFirstToken == null) tFirstToken = Date.now();
                        producedOutput = true; meaningful = true;
                        if (rewriteToolCalls(delta.tool_calls, coercion)) {
                          if (!committed) commitFlush();
                          res.write(`data: ${JSON.stringify(obj)}\n\n`);
                          continue;
                        }
                      }
                    }
                  } catch { /* keepalive / non-JSON */ }
                } else if (/languagemodelerror|error -1/i.test(t)) {
                  isErr = true; // raw (non-data) error line
                  errCls = classifyError(t, parsedReq);
                } else if (t.startsWith("{")) {
                  // fm serve returns non-SSE errors (e.g. HTTP 503 service_unavailable
                  // for a missing-PCC-attribution `pcc` request) as BARE JSON, not a
                  // `data:` frame. Parse it so we classify + surface the typed error
                  // instead of treating the stream as empty and retrying blindly.
                  try {
                    obj = JSON.parse(t);
                    if (isErrorPayload(obj)) {
                      isErr = true;
                      errCls = classifyError(obj.error && obj.error.message, parsedReq);
                    }
                  } catch { /* not an error JSON */ }
                }
                // Safety-guardrail abort → OpenAI content_filter: keep any partial that
                // was already streamed, end the stream with finish_reason:"content_filter",
                // and emit NO error frame (so SDK clients get the partial + a documented
                // finish_reason instead of an exception). Only the guardrail maps to
                // content_filter; rate-limit and service_unavailable stay typed errors
                // (they're HTTP 429/503 analogues, not content filtering).
                if (isErr && errCls && errCls.type === "generation_aborted") {
                  diag(`${errCls.label}`, `— line: ${t}`);
                  abortFinishReason = "content_filter";
                  sawFinish = true;      // terminate the stream cleanly (no retry)
                  continue;              // drop the error frame; end handler emits the finish
                }
                // Pre-commit upstream error: retry only if transient (rate-limit). A
                // safety-guardrail abort is terminal — retrying re-fails identically —
                // so surface it immediately instead of burning the retry budget.
                if (isErr && !committed) {
                  diag(`${errCls.label} (pre-commit)`, `— line: ${t}`);
                  if (errCls.retry && fail("upstream error frame")) return;
                  surfacedError = true; // retries exhausted OR terminal: forward typed
                  meaningful = true;
                }
                if (!committed && !meaningful) {
                  // Preamble / keepalive before any real output — hold it so a
                  // following error frame is still pre-commit and retryable.
                  preBuffer.push(line);
                  continue;
                }
                if (!committed) commitFlush();
                // Forward content as-is; rewrite error frames to a typed OpenAI error so
                // clients can branch on `type` (rate_limit_exceeded / generation_aborted)
                // without string-matching Apple's message.
                if (isErr) {
                  const errMsg = (obj && obj.error && obj.error.message) || t;
                  res.write(errorFrame(errCls, errMsg));
                  if (!surfacedError) surfacedError = true;
                } else {
                  res.write(line);
                }
              }
            }

            proxyRes.on("data", (chunk) => {
              if (aborting) return;
              rawTail = (rawTail + chunk).slice(-2000); // keep a bounded tail for diagnostics
              pump(chunk, false);
            });

            proxyRes.on("end", () => {
              if (aborting) return;
              pump("", true); // flush any buffered partial line
              if (aborting) return; // pump may have triggered a retry
              if (!committed) {
                // Nothing forwardable arrived — empty/aborted stream. Retry it;
                // if exhausted, tell the client plainly instead of an empty 200.
                if (!sawFinish && completionText === "" && fail("empty stream (no finish)")) return;
                commit();
                if (!sawFinish && completionText === "" && !surfacedError) {
                  diag("GIVING UP (empty stream after retries)", `rawTail=${JSON.stringify(rawTail)}`);
                  res.write(errorFrame(classifyError("rate limit", parsedReq),
                    "upstream returned no output (likely PCC rate limit) after retries"));
                }
              }
              if (!sawFinish && completionText !== "") {
                diag("UPSTREAM STREAM ABORTED (no finish)",
                  `completionChars=${completionText.length} rawTail=${JSON.stringify(rawTail)}`);
              }
              // Finished cleanly but produced neither text nor tool_calls — the
              // error path (error frame then [DONE]) that exhausted retries. Tool-
              // call turns set producedOutput, so they don't trip this.
              if (sawFinish && !producedOutput) {
                diag("EMPTY COMPLETION (finished, no output)",
                  `rawTail=${JSON.stringify(rawTail)}`);
              }
              const completionTokens = countCompletionTokens(completionText);
              // Throughput: generation time is first-token → now (independent of
              // retry/network overhead); TTFT is request-received → first-token.
              const nowEnd = Date.now();
              logToks(
                (parsedReq && parsedReq.model) || "unknown", "stream", completionTokens,
                tFirstToken != null ? nowEnd - tFirstToken : nowEnd - reqStart,
                tFirstToken != null ? tFirstToken - reqStart : null,
              );
              // Prefer fm serve's own real usage (captured above from the frame we
              // forced upstream via stream_options.include_usage) over the
              // completionText-based estimate — the same "trust fm serve's own
              // number" upgrade already applied to the non-streaming path. The
              // estimate only fires as a fallback for upstreams that ignore the flag
              // (e.g. pre-Beta-3 fm serve, or a guardrail abort that never reaches a
              // clean finish).
              const usage = realUsage || {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              };
              const meta = lastChunkMeta || {};
              const finishChunk = {
                id: meta.id || "chatcmpl-proxy",
                object: "chat.completion.chunk",
                created: meta.created || Math.floor(Date.now() / 1000),
                model: meta.model || (parsedReq && parsedReq.model) || "unknown",
                choices: [{ index: 0, delta: {}, finish_reason: abortFinishReason }],
              };
              // We always suppress the upstream [DONE] and re-emit our own final
              // chunk, so clients (Pi) that read the last chunk get a real
              // prompt_tokens. The client's own stream_options.include_usage opt-out
              // is honored on the way OUT even though we always force it upstream:
              // explicit `false` gets no usage field (vanilla OpenAI shape); absent
              // or `true` keeps the established always-on usage chunk. The
              // finish_reason itself must still go out even when usage is declined —
              // for a content_filter abort it's ONLY ever carried by this chunk (the
              // abort's own error frame is swallowed above), so we can't just drop
              // the whole chunk on an opt-out.
              if (!clientDeclinedUsage) {
                res.write(`data: ${JSON.stringify({ ...finishChunk, usage })}\n\n`);
              } else if (abortFinishReason) {
                res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
              }
              res.write("data: [DONE]\n\n");
              res.end();
            });
            return;
          }

          // Non-streaming: buffer fully (so we can still retry), then fix usage.
          let raw = "";
          proxyRes.on("data", (c) => (raw += c));
          proxyRes.on("end", () => {
            if (aborting) return;
            let obj = null;
            try { obj = JSON.parse(raw); } catch { /* not JSON */ }
            let outStatus = proxyRes.statusCode;
            if (isErrorPayload(obj)) {
              const cls = classifyError(obj.error && obj.error.message, parsedReq);
              diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
              if (cls.type === "generation_aborted") {
                // content_filter: return a normal completion finished by the filter
                // (OpenAI-aligned), not an error. fm serve's non-stream error carries
                // no partial, so content is empty; status is 200 (it's a valid completion).
                obj = {
                  id: "chatcmpl-proxy", object: "chat.completion",
                  model: (parsedReq && parsedReq.model) || "unknown",
                  choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
                  usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
                };
                outStatus = 200;
              } else {
                if (cls.retry && fail("non-stream error")) return;
                // terminal (service_unavailable) OR retries exhausted (rate-limit): type it.
                if (obj.error && typeof obj.error === "object") {
                  obj.error = { message: obj.error.message, type: cls.type, code: cls.code };
                }
              }
            }
            let out = raw;
            if (obj) {
              // fm serve 2.0.59+ (macOS 27 Beta 3) reports real, accurate non-streaming
              // usage (verified live against `fm token-count`) — no override needed here
              // anymore. Streaming still sends none at all, so that path (below) still
              // synthesizes it from promptTokens/completionTokens.
              // Re-expand JSON-string tool-call args back to real objects.
              const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
              if (msg && Array.isArray(msg.tool_calls)) rewriteToolCalls(msg.tool_calls, coercion);
              out = JSON.stringify(obj);
            }
            // Throughput: no first-token timestamp in non-streaming (upstream
            // buffers the whole reply), so duration is request-received → now.
            const nsCompletionTokens = (obj && obj.usage && obj.usage.completion_tokens) || 0;
            logToks((parsedReq && parsedReq.model) || "unknown", "sync", nsCompletionTokens, Date.now() - reqStart);
            committed = true;
            relayHead(res, outStatus, proxyRes.headers, Buffer.byteLength(out));
            res.end(out);
          });
        }
      );
      activeProxyReq = proxyReq;
      proxyReq.on("error", (e) => {
        // Transport-level failure (fm serve down / reset). Not the rate-limit
        // signature, and aborting=true means we tore it down on purpose to retry.
        if (aborting || clientGone || res.destroyed) return;
        if (isChat) diag("UPSTREAM REQ SOCKET ERROR", `— ${e.code || ""} ${e.message}`);
        // OpenAI-shaped error object (matches the stream-exhaustion path) so clients
        // parsing error.message get a string, not undefined.
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ error: { message: `fm serve unreachable: ${e.message}`, type: "server_error", code: "upstream_unreachable" } }));
      });
      proxyReq.write(fixed);
      proxyReq.end();
    }

    forward(0);
  });
});

// Only start listening when run directly; importing for tests must not bind.
if (require.main === module) {
  server.listen(PROXY_PORT, () => {
    console.log(`fm-proxy listening on http://127.0.0.1:${PROXY_PORT}`);
    console.log(`  proxying to http://127.0.0.1:${FM_PORT}`);
    console.log(`  simplifies tool schemas to flat format for fm serve compatibility`);
  });
}
