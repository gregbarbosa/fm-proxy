#!/usr/bin/env node
// fm-proxy.js — OpenAI-compatible front for Apple's `fm serve`.
// Proxies http://127.0.0.1:1977 -> http://127.0.0.1:1976 (node fm-proxy.js)
//
// fm serve's JSON Schema limits for tool parameters: root `required` must be
// present; no anyOf/allOf/oneOf/if-then-else/not/patternProperties; nested
// objects decode natively at any depth EXCEPT array<array<object>>, which needs
// the JSON-string round-trip (see needsJsonRoundTrip). $ref/$defs are inlined
// first (tool parameters and response_format) — fm serve understands neither.

const http = require("http");
const { execFileSync } = require("child_process");
const FM_PORT = Number(process.env.FM_PORT) || 1976;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 1977;

// fm serve has DISTINCT failure modes this proxy must not conflate (see
// classifyError): transient rate-limits are retried with backoff; safety-guardrail
// aborts and forced-tool_choice rejections are deterministic + terminal and never
// retried; PCC-unavailability is terminal. Set FM_MAX_RETRIES=0 to disable retries.
const MAX_RETRIES = Number(process.env.FM_MAX_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.FM_RETRY_BASE_MS ?? 1000);
const RETRY_CAP_MS = Number(process.env.FM_RETRY_CAP_MS ?? 15000);

// ── Token counting ───────────────────────────────────────────────────────────
// Fallback only (fm serve sends real usage) plus the assembled-size instrumentation
// below. `fm count-tokens` where possible, chars/4.4 heuristic when it's unavailable.
const CHARS_PER_TOKEN = 4.4;
// Two measured framing constants — they reproduce fm serve's prompt_tokens exactly,
// do not "simplify": CONVERSATION_FRAMING is the fixed cost around a whole
// conversation (present only with -i; flat 54 at lengths 6–400); PER_MESSAGE_FRAMING
// is the cost of splitting text across turns (4 per message beyond the first).
const CONVERSATION_FRAMING = 54;
const PER_MESSAGE_FRAMING = 4;

// Content-only estimate; framing is added by the caller that needs it.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Flatten messages into what Apple's model sees: system → instructions (-i), rest → prompt.
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

// Exact token count via `fm count-tokens -q`; stdin avoids argv limits, -i adds the
// instructions' template wrapping. Null on failure (callers use the heuristic).
// Memoized and bounded — each call forks `fm` synchronously, heavy inputs repeat.
const _tokenCache = new Map();
const _TOKEN_CACHE_MAX = 512;
// `fm count-tokens` (named `token-count` before Beta 4); no fallback probe — a probe
// spawns `fm` twice per count and cannot succeed anyway.
const TOKEN_SUBCOMMAND = "count-tokens";
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
  // Skip the call when both inputs are empty — the subcommand requires one.
  if (!text && !instructions) return 0;
  const key = (instructions || "") + "\0" + (text || "");
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  if (_fmLicenseGated) return null;
  let result = null;
  try {
    const args = [TOKEN_SUBCOMMAND, "-q"];
    if (instructions) args.push("-i", instructions);
    const out = execFileSync("/usr/bin/fm", args, {
      input: text || "",
      encoding: "utf8",
      timeout: 5000,
      // Capture stderr: the license banner would otherwise print on every failed count.
      stdio: ["pipe", "pipe", "pipe"],
    });
    const n = parseInt(out.trim(), 10);
    if (Number.isFinite(n)) result = n;
  } catch (err) {
    if (_isLicenseGate(err)) {
      _fmLicenseGated = true;
      console.error(
        "[fm-proxy] `fm` is blocked by the Apple Foundation Models CLI legal notice. " +
          "Token counts fall back to estimates. Run `sudo fm license` in Terminal.app to fix this.",
      );
    }
    // Other failures (missing binary, timeout) stay retryable: null, uncached.
  }
  // Cache only successful counts; a null is a transient failure worth retrying.
  if (result != null) {
    if (_tokenCache.size >= _TOKEN_CACHE_MAX) _tokenCache.clear();
    _tokenCache.set(key, result);
  }
  return result;
}

// Prompt tokens for the messages array; the fallback estimates the joined text once.
function countPromptTokens(messages) {
  const { instructions, prompt } = splitMessages(messages);
  const n = fmTokenCount(prompt, instructions);
  if (n == null) return CONVERSATION_FRAMING + estimateTokens(instructions + "\n" + prompt);
  // With -i the count matches fm serve's prompt_tokens exactly; without it it sits 54
  // low (the conversation framing), so add it back for system-less requests.
  return instructions ? n : n + CONVERSATION_FRAMING;
}

// ── Assembled-request instrumentation ────────────────────────────────────────
// The gauge counts only messages[].content; fm serve also frames tool schemas, prior
// tool_calls (m.tool_calls, not content), and a per-turn wrapper — log the real size.
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
  // 4. per-turn framing — the gauge collapses it to a single overhead.
  const nonSystemTurns = messages.filter((m) => m.role !== "system").length;
  const perTurnExtra = PER_MESSAGE_FRAMING * Math.max(0, nonSystemTurns - 1);
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

// One-line throughput counter per completion; guards zero-token/zero-time.
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

// Decorative keys fm serve ignores but that still cost prompt tokens.
const DECORATIVE = [
  "title", "examples", "default", "$schema", "$id", "$comment",
  "readOnly", "writeOnly",
];

const STRIP_KEYS = new Set([
  "anyOf", "allOf", "oneOf", "if", "then", "else", "not",
  "$defs", "definitions", "$ref", "patternProperties",
  "description", ...DECORATIVE,
]);

// Keys dropped when embedding a schema in a description: structure only, no prose.
const EMBED_STRIP_KEYS = new Set([
  "description", "additionalProperties", ...DECORATIVE,
]);

// Collapse a composition keyword, then re-simplify: allOf unions subschemas
// (siblings win); otherwise take the first typed branch, siblings fill gaps.
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

  // Nested objects decode natively — recurse, don't collapse to string; a bare
  // `properties` block normalizes to type:"object". The broken shape never gets here.
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

// True if `prop` bottoms out in an object through any number of array wrappers.
function leafIsObjectThroughArrays(prop) {
  if (!prop || typeof prop !== "object") return false;
  if (prop.type === "array") return leafIsObjectThroughArrays(prop.items);
  return prop.type === "object" || !!prop.properties;
}

// A top-level param needs the JSON-string round-trip only for the ONE shape verified
// broken upstream: an object reachable through 2+ consecutive array wrappers
// (array<array<object>> and deeper), which errors "Failed to parse generated content".
// array<array<number>> (a primitive leaf) is fine, and object nesting passes through
// natively at any depth. Last verified end-to-end on Beta 4; Beta 5's tool-call parser
// is broken upstream, so this cannot currently be re-checked live.
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

// Returns { schema, jsonFields } — jsonFields must be JSON.parse'd back on response.
function fixToolSchema(schema) {
  const result = { type: "object", required: [] };
  const jsonFields = [];
  if (!schema || typeof schema !== "object") {
    result.properties = {};
    return { schema: result, jsonFields };
  }

  // Resolve $refs first: simplifyProperty strips $ref/$defs, flattening a referenced
  // param to `{}` — the shape pydantic/zod emit for named types. Inlining gives fm
  // serve the nesting it decodes natively; cyclic refs keep the old behaviour.
  if (schema.$defs) schema = inlineDefs(schema) || schema;

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
  // Preserve the caller's `required` — dropping it made params optional and the model
  // emitted partial/empty tool calls. Round-tripped params keep their name.
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return { schema: result, jsonFields };
}

// ── response_format schema dialect (structured output) ──────────────────────
// fm serve's dialect needs title + x-order + required + additionalProperties on
// every object reached through `$defs`; a missing key 400s naming it. Inline-nested
// objects need none, so inlining (below) is primary; this survives for cyclic refs.
// Re-verify: undecorated $defs → 400; decorated $defs on Beta 5 hangs `system`.
function isDialectObjectSchema(s) {
  return !!(s && typeof s === "object" && (s.type === "object" || s.properties));
}

function capitalizeTitle(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : "Object";
}

// Recursively inject the dialect under `node` (only walked from inside $defs).
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

// Normalise a response_format schema: inline $refs and drop $defs (avoids both the
// 400 for missing dialect keys and the Beta-5 hang when present). Cyclic/unresolvable
// refs fall back to dialect injection above.
function fixResponseFormatSchema(schema) {
  if (!schema || typeof schema !== "object" || !schema.$defs) return schema;
  const inlined = inlineDefs(schema);
  if (inlined) return inlined;
  for (const [name, def] of Object.entries(schema.$defs)) decorateDialect(def, name);
  return schema;
}

// Rewrite tools into fm-serve-compatible schemas; returns body, coercion map, parsed req.
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
        // fm serve 400s the ENTIRE request ("Invalid JSON: The data couldn't be read because
        // it is missing.") if ANY tool's function.description is absent or null — regardless
        // of shape, tool_choice, or which tool is called; an empty string is accepted.
        // OpenAI's spec makes description optional, so backfill it rather than erroring.
        // Re-verify: one description-less tool → whole request 400s even if never called.
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
function expandToolCallArguments(toolName, argsStr, coercion) {
  const fields = coercion[toolName];
  if (!fields || !fields.length) return argsStr;
  try {
    const obj = JSON.parse(argsStr);
    let changed = false;
    for (const f of fields) {
      if (typeof obj[f] === "string") {
        try { obj[f] = JSON.parse(obj[f]); changed = true; } catch {
          // Model quirk: HTML entities where escaped quotes should be — decode once, retry.
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

// Apply expandToolCallArguments across a tool_calls array; true if any rewritten.
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

// Classify an upstream fm-serve error message into a distinct OpenAI-shaped error type
// so clients can branch on the *cause* rather than string-matching Apple's prose. The
// failure modes (see header comment) need different client remedies:
//   - rate-limit: transient, retry.
//   - safety-guardrail abort: deterministic + terminal, do NOT retry.
//   - forced tool_choice (Beta 5 wording): deterministic + terminal, do NOT retry.
// `retry` tells the streaming/non-stream paths whether backoff is worthwhile. Every
// case is decided from the message alone — Beta 3/4 needed the original request to
// tell a tool_choice crash from a rate limit, Beta 5 does not.
function classifyError(msg) {
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
  // On Beta 3/4 this signature ALSO meant "forced tool_choice crashed the system
  // engine", so it was reclassified when the request looked like that. Beta 5 rejects
  // forced tool_choice with its own message (handled above), so that reclassification
  // can no longer be right here — it would only mislabel a genuine rate limit that
  // happened to arrive on a forced-tool_choice request as a permanent client error,
  // and skip the retry that would have recovered it. Removed with Beta 3/4 support.
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit"))
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  return { type: "server_error", code: "internal_error", retry: true, label: "UPSTREAM ERROR" };
}

// Build an SSE error frame (`data: {"error":{...}}\n\n`) carrying a typed OpenAI error.
function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({
    error: { message: msg || "upstream error", type: cls.type, code: cls.code },
  })}\n\n`;
}

// An SSE/JSON frame is an error when it carries `error` and no usable choices.
function isErrorPayload(obj) {
  return !!(obj && obj.error && !(obj.choices && obj.choices.length));
}

// Classify the error an upstream frame/body carries — the shared entry for the
// streaming data-frame, bare-JSON, and non-streaming body paths.
function classifyErrorPayload(obj) {
  return classifyError(obj && obj.error && obj.error.message);
}

// Shared pre-surface decision for both relays: log the classified failure, then
// retry if transient (and the budget allows) or fall through to surface it typed.
// Returns true when a retry was scheduled — the caller must stop touching the stream.
function retryOrSurface(cls, ctxLabel, extra, reason, fail, diag) {
  diag(`${cls.label} (${ctxLabel})`, extra);
  return !!(cls.retry && fail(reason));
}

// Exported for tests when required as a module; harmless when run directly.
if (require.main !== module) {
  module.exports = { fixTools, fixToolSchema, fixResponseFormatSchema, expandToolCallArguments, classifyError, errorFrame, fmTokenCount, _isLicenseGate };
}

// CORS for browser clients; `*` by default, override with CORS_ORIGIN, on every response.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_HEADERS = {
  "access-control-allow-origin": CORS_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // `*` doesn't cover Authorization (Fetch spec) — name it; x-stainless-* clears via `*`.
  "access-control-allow-headers": "Authorization, *",
  "access-control-max-age": "86400", // cache preflight a day; fewer round-trips
};
function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

// Copy upstream headers; set Content-Length (buffered) or drop it (chunked).
function relayHead(res, statusCode, upstreamHeaders, bodyLen) {
  const headers = { ...upstreamHeaders, ...CORS_HEADERS };
  // CL+TE together is illegal framing — never relay upstream's Transfer-Encoding.
  delete headers["transfer-encoding"];
  if (bodyLen == null) delete headers["content-length"];
  else headers["content-length"] = bodyLen;
  res.writeHead(statusCode, headers);
}

// Per-request retry state: the client response persists across attempts, its head
// committed only on a good frame, so a failed attempt replays invisibly.
function createRetryPlan(res, diag, fire) {
  let clientGone = false;
  let retryTimer = null;
  let activeProxyReq = null;
  res.on("close", () => {
    clientGone = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (activeProxyReq) activeProxyReq.destroy();
  });
  res.on("error", () => { if (activeProxyReq) activeProxyReq.destroy(); });
  return {
    get clientGone() { return clientGone; },
    setActiveReq(proxyReq) { activeProxyReq = proxyReq; },
    // Schedule attempt+1 with backoff; false when the budget is exhausted or client gone.
    schedule(attempt, reason) {
      if (attempt + 1 > MAX_RETRIES || clientGone) return false;
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
      diag(`RETRY ${attempt + 1}/${MAX_RETRIES}`, `after ${reason}; waiting ${delay}ms`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!clientGone) fire(attempt + 1);
      }, delay);
      return true;
    },
  };
}

// ── Per-request preparation ─────────────────────────────────────────────────
// Build the upstream payload + context: fixTools rewrites, stream fixups, coercion
// map, assembled-size instrumentation. Logs once per request.
function prepareUpstreamRequest(req, body) {
  const { body: toolFixed, coercion, parsed: parsedReq } = fixTools(body);

  const isChat = !!(req.url && req.url.includes("/chat/completions"));
  const isStream = !!(parsedReq && parsedReq.stream);

  // fm serve sends a real usage chunk on streaming only when the request opts in via
  // stream_options.include_usage — real clients never set it. Force it upstream on
  // every streaming request; the client's own explicit include_usage:false is honored
  // on the way OUT, everything else keeps the always-on usage chunk.
  const clientDeclinedUsage = !!(
    parsedReq &&
    parsedReq.stream_options &&
    parsedReq.stream_options.include_usage === false
  );
  // fm serve SILENTLY IGNORES `max_tokens` — the standard OpenAI field, and what most
  // SDKs send. Only `max_completion_tokens` truncates. Verified live: max_tokens:10 on a
  // "count to 100" prompt returned 391 completion tokens, max_completion_tokens:10
  // returned 10. Left alone, a client that sets a cap gets unbounded generation, which
  // on `pcc` also burns context against its ~32k ceiling. Map it across, without
  // overriding an explicit max_completion_tokens.
  let cappedAt = null;
  if (isChat && parsedReq) {
    const mc = parsedReq.max_completion_tokens;
    const mt = parsedReq.max_tokens;
    if (mc == null && Number.isFinite(Number(mt))) {
      parsedReq.max_completion_tokens = Number(mt);
      delete parsedReq.max_tokens;
    }
    const cap = Number(parsedReq.max_completion_tokens);
    if (Number.isFinite(cap)) cappedAt = cap;
  }
  let fixed = toolFixed;
  if (cappedAt != null && parsedReq) fixed = JSON.stringify(parsedReq);
  if (isStream && parsedReq) {
    parsedReq.stream_options = { ...(parsedReq.stream_options || {}), include_usage: true };
    fixed = JSON.stringify(parsedReq);
  } else if (isChat && parsedReq && parsedReq.stream === undefined) {
    // Beta 5 flipped the default: a chat request that OMITS `stream` comes back as
    // text/event-stream, not the single JSON object the OpenAI spec returns — so pin
    // stream:false for clients that never set the field.
    parsedReq.stream = false;
    fixed = JSON.stringify(parsedReq);
  }
  // The full assembled size: the fallback number when fm serve sends no usage (e.g.
  // guardrail abort), logged per request to tie overflows to a real size. Messages
  // match fm serve exactly; the tool-schema part under-counts. GAUGE_MODE=msgs selects
  // the messages-only number (kept: an undocumented debug hatch the TEST harness
  // sets for deterministic [assembled] output — see startStack in fm-proxy.test.js).
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

  // Always forward a fully-buffered body with our own Content-Length; drop any
  // inbound Transfer-Encoding — keeping both is illegal framing and upstream rejects
  // it with HPE_INVALID_CONTENT_LENGTH.
  const upstreamHeaders = { ...req.headers, "content-length": Buffer.byteLength(fixed) };
  delete upstreamHeaders["transfer-encoding"];
  return { fixed, upstreamHeaders, coercion, parsedReq, isChat, isStream,
           clientDeclinedUsage, breakdown, promptTokens, cappedAt };
}

// ── Attempt gate ───────────────────────────────────────────────────────────
// Per-attempt commit/fail state shared by both relays: before the client head is
// committed a failure is retryable; `fail` tears the attempt down and schedules the
// next via the plan (true = retry scheduled, stop touching the stream).
function createAttemptGate({ res, proxyRes, proxyReq, plan, attempt, isStream, diag }) {
  let committed = false;
  let aborting = false;
  return {
    isCommitted: () => committed,
    markCommitted() { committed = true; },
    isAborting: () => aborting,
    commit() {
      if (committed) return;
      committed = true;
      if (isStream) {
        relayHead(res, proxyRes.statusCode, proxyRes.headers, null);
        if (proxyRes.statusCode !== 200) diag(`UPSTREAM HTTP ${proxyRes.statusCode}`);
      }
    },
    fail(reason) {
      if (committed || aborting) return false;
      if (!plan.schedule(attempt, reason)) return false;
      aborting = true;
      proxyRes.destroy();
      proxyReq.destroy();
      return true;
    },
  };
}

// ── Streaming relay ─────────────────────────────────────────────────────────
// Relays one upstream SSE chat stream: line pump, preamble hold-back, typed error
// frames, guardrail abort, final usage/finish chunk.
function relayStreamingChat({ res, proxyRes, diag, commit, isCommitted, fail, isAborting, coercion, cappedAt,
                              parsedReq, promptTokens, clientDeclinedUsage, reqStart }) {
  // Real usage needs the forced include_usage upstream; completionText stays a fallback.
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
  // PCC opens streams with an empty {"delta":{"role":"assistant"}} preamble, THEN
  // either output or an error frame — don't commit the head on the preamble or a
  // following error looks post-commit and unretryable; buffer and commit on meaning.
  const preBuffer = [];
  const flushPre = () => { for (const l of preBuffer) res.write(l); preBuffer.length = 0; };
  const commitFlush = () => { commit(); flushPre(); };

  function pump(s, flush) {
    pending += s;
    let idx;
    while ((idx = pending.indexOf("\n")) !== -1 || (flush && pending.length)) {
      if (isAborting()) return;
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
        if (payload === "[DONE]") { sawFinish = true; if (!isCommitted()) commitFlush(); continue; }
        try {
          obj = JSON.parse(payload);
          isErr = isErrorPayload(obj);
          if (isErr) {
            errCls = classifyErrorPayload(obj);
          } else if (obj.usage && (!obj.choices || obj.choices.length === 0)) {
            // fm serve's real usage-only chunk — capture it; never relay this frame raw (the
            // end-of-stream handler emits the client-facing chunk from these numbers).
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
                if (!isCommitted()) commitFlush();
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
                continue;
              }
            }
          }
        } catch { /* keepalive / non-JSON */ }
      } else if (/languagemodelerror|error -1/i.test(t)) {
        isErr = true; // raw (non-data) error line
        errCls = classifyError(t);
      } else if (t.startsWith("{")) {
        // fm serve returns non-SSE errors (e.g. the 503 for missing PCC attribution) as BARE
        // JSON — parse and classify it instead of retrying the stream blindly.
        try {
          obj = JSON.parse(t);
          if (isErrorPayload(obj)) {
            isErr = true;
            errCls = classifyErrorPayload(obj);
          }
        } catch { /* not an error JSON */ }
      }
      // Safety-guardrail abort → OpenAI content_filter: keep any partial, end with
      // finish_reason:"content_filter", no error frame (SDKs get the partial + a documented
      // finish_reason instead of an exception). Only the guardrail maps here.
      if (isErr && errCls && errCls.type === "generation_aborted") {
        diag(`${errCls.label}`, `— line: ${t}`);
        abortFinishReason = "content_filter";
        sawFinish = true;      // terminate the stream cleanly (no retry)
        continue;              // drop the error frame; end handler emits the finish
      }
      // Pre-commit error: retry only if transient; terminal errors surface immediately.
      if (isErr && !isCommitted()) {
        if (retryOrSurface(errCls, "pre-commit", `— line: ${t}`, "upstream error frame", fail, diag)) return;
        surfacedError = true; // retries exhausted OR terminal: forward typed
        meaningful = true;
      }
      if (!isCommitted() && !meaningful) {
        // Preamble/keepalive — hold it so a following error stays pre-commit and retryable.
        preBuffer.push(line);
        continue;
      }
      if (!isCommitted()) commitFlush();
      // Forward content as-is; rewrite error frames to typed OpenAI errors.
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
    if (isAborting()) return;
    rawTail = (rawTail + chunk).slice(-2000); // keep a bounded tail for diagnostics
    pump(chunk, false);
  });

  proxyRes.on("end", () => {
    if (isAborting()) return;
    pump("", true); // flush any buffered partial line
    if (isAborting()) return; // pump may have triggered a retry
    if (!isCommitted()) {
      // Nothing forwardable arrived — retry; if exhausted, tell the client plainly.
      if (!sawFinish && completionText === "" && fail("empty stream (no finish)")) return;
      commit();
      if (!sawFinish && completionText === "" && !surfacedError) {
        diag("GIVING UP (empty stream after retries)", `rawTail=${JSON.stringify(rawTail)}`);
        res.write(errorFrame(classifyError("rate limit"),
          "upstream returned no output (likely PCC rate limit) after retries"));
      }
    }
    if (!sawFinish && completionText !== "") {
      diag("UPSTREAM STREAM ABORTED (no finish)",
        `completionChars=${completionText.length} rawTail=${JSON.stringify(rawTail)}`);
    }
    // Finished but no output: the error path that exhausted retries.
    if (sawFinish && !producedOutput) {
      diag("EMPTY COMPLETION (finished, no output)",
        `rawTail=${JSON.stringify(rawTail)}`);
    }
    const completionTokens = countCompletionTokens(completionText);
    // Throughput: generation time is first-token → now; TTFT is request → first-token.
    const nowEnd = Date.now();
    logToks(
      (parsedReq && parsedReq.model) || "unknown", "stream", completionTokens,
      tFirstToken != null ? nowEnd - tFirstToken : nowEnd - reqStart,
      tFirstToken != null ? tFirstToken - reqStart : null,
    );
    // Prefer fm serve's real usage over the completionText estimate; the estimate
    // only fires when no usage frame arrives at all (e.g. a guardrail abort that
    // never finishes).
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
    // Same truncation mislabel as the non-streaming path: fm serve says "stop" even when
    // it stopped at the cap. Only rewrite a plain stop — never an abort's content_filter.
    if (cappedAt != null && !abortFinishReason &&
        Number(usage.completion_tokens) >= Number(cappedAt)) {
      finishChunk.choices[0].finish_reason = "length";
    }
    // Always suppress upstream's [DONE] and re-emit our own final chunk so clients get
    // real usage. Explicit include_usage:false → no usage field (vanilla OpenAI shape);
    // absent/true keeps the always-on chunk. finish_reason must still go out on an
    // opt-out — for content_filter it is ONLY carried by this chunk (the abort's own
    // error frame is swallowed above), so the chunk can't be dropped wholesale.
    if (!clientDeclinedUsage) {
      res.write(`data: ${JSON.stringify({ ...finishChunk, usage })}\n\n`);
    } else if (abortFinishReason) {
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

// ── Non-streaming relay ─────────────────────────────────────────────────────
// Buffer the whole reply (failures stay retryable), rewrite guardrail aborts to
// content_filter completions, re-expand tool-call args.
// fm serve reports finish_reason:"stop" even when it truncated at the cap, so a client
// cannot tell a complete answer from a cut-off one. Verified live: capped at 10 tokens,
// the reply "1, 2, 3, 4" came back as "stop". Rewrite to OpenAI's "length" when the
// completion reached the cap.
//
// The cap is APPROXIMATE — fm serve overshoots it (measured: cap 8 -> 16 tokens,
// cap 16 -> 22, cap 10 -> 10). So compare with >=, never ==. A naturally-complete reply
// that happens to land on the cap is reported as "length"; OpenAI has the same
// ambiguity, and under-reporting a truncation is the worse error.
function applyLengthFinish(obj, cappedAt) {
  if (cappedAt == null || !obj || !obj.usage || !Array.isArray(obj.choices)) return;
  if (Number(obj.usage.completion_tokens) < Number(cappedAt)) return;
  for (const c of obj.choices) if (c && c.finish_reason === "stop") c.finish_reason = "length";
}

function relayNonStreamingChat({ res, proxyRes, diag, fail, isAborting, markCommitted,
                                 coercion, parsedReq, promptTokens, reqStart, cappedAt }) {
// Non-streaming: buffer fully (so we can still retry), then fix usage.
let raw = "";
proxyRes.on("data", (c) => (raw += c));
proxyRes.on("end", () => {
  if (isAborting()) return;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* not JSON */ }
  let outStatus = proxyRes.statusCode;
  if (isErrorPayload(obj)) {
    const cls = classifyErrorPayload(obj);
    if (cls.type === "generation_aborted") {
      diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
      // content_filter: a normal 200 completion finished by the filter, empty content.
      obj = {
        id: "chatcmpl-proxy", object: "chat.completion",
        model: (parsedReq && parsedReq.model) || "unknown",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
      };
      outStatus = 200;
    } else if (retryOrSurface(cls, "non-stream", `— ${raw.slice(0, 200)}`, "non-stream error", fail, diag)) {
      return;
    } else if (obj.error && typeof obj.error === "object") {
      // terminal (service_unavailable) OR retries exhausted (rate-limit): type it.
      obj.error = { message: obj.error.message, type: cls.type, code: cls.code };
    }
  }
  let out = raw;
  if (obj) {
    // fm serve's non-streaming usage is accurate — pass it through untouched.
    const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
    if (msg && Array.isArray(msg.tool_calls)) rewriteToolCalls(msg.tool_calls, coercion);
    applyLengthFinish(obj, cappedAt);
    out = JSON.stringify(obj);
  }
  // Throughput: duration is request-received → now (upstream buffers the whole reply).
  const nsCompletionTokens = (obj && obj.usage && obj.usage.completion_tokens) || 0;
  logToks((parsedReq && parsedReq.model) || "unknown", "sync", nsCompletionTokens, Date.now() - reqStart);
  markCommitted();
  relayHead(res, outStatus, proxyRes.headers, Buffer.byteLength(out));
  res.end(out);
});
}

const server = http.createServer((req, res) => {
  // CORS preflight: answer immediately, before buffering any body.
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // UTF-8 decoding reassembles multibyte chars split across TCP chunk boundaries.
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("error", () => { /* client aborted upload; nothing to forward */ });
  req.on("end", () => {
    const reqStart = Date.now();
    const ctx = prepareUpstreamRequest(req, body);
    const { fixed, upstreamHeaders, coercion, parsedReq, isChat, isStream,
            clientDeclinedUsage, breakdown, promptTokens, cappedAt } = ctx;

    // One-line diagnostic binding a failure to this request's assembled size.
    const diag = (label, extra = "") => console.error(
      `[assembled] *** ${label} *** assembled=` +
      `${breakdown ? breakdown.assembledTotal : "?"} (gauge ${promptTokens})` +
      (extra ? ` ${extra}` : "")
    );

    // Retry state across attempts; forward(attempt+1) replays a failed attempt.
    const plan = createRetryPlan(res, diag, (n) => forward(n));

    function forward(attempt) {
      let gate = null; // set once a response arrives (createAttemptGate)
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

          const g = createAttemptGate({ res, proxyRes, proxyReq, plan, attempt, isStream, diag });
          gate = g;
          const relay = { res, proxyRes, diag, ...g, coercion, parsedReq, promptTokens, reqStart, cappedAt };
          if (isStream) relayStreamingChat({ ...relay, clientDeclinedUsage });
          else relayNonStreamingChat(relay);
        }
      );
      plan.setActiveReq(proxyReq);
      proxyReq.on("error", (e) => {
        // Transport-level failure (fm serve down/reset); deliberate teardowns are skipped.
        if ((gate && gate.isAborting()) || plan.clientGone || res.destroyed) return;
        if (isChat) diag("UPSTREAM REQ SOCKET ERROR", `— ${e.code || ""} ${e.message}`);
        // OpenAI-shaped error object so clients parsing error.message get a string.
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
