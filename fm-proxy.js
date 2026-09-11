#!/usr/bin/env node
// fm-proxy.js — OpenAI-compatible front for Apple's `fm serve`.
// Proxies http://127.0.0.1:1977 -> http://127.0.0.1:1976 (node fm-proxy.js)
//
// fm serve's JSON Schema limits for tool parameters: the root `required` must be
// present, and anyOf/allOf/oneOf/if-then-else/not/patternProperties are all rejected.
// Nested objects decode natively at any depth. $ref and $defs are inlined first, in
// both tool parameters and response_format, because fm serve understands neither.

const http = require("http");
const { execFileSync } = require("child_process");
const FM_PORT = Number(process.env.FM_PORT) || 1976;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 1977;
// Matches fm-launch.sh's --fm-bin/FM_BIN. Point it at a path that does not exist to
// force the heuristic token count, which is what makes a test run deterministic.
const FM_BIN = process.env.FM_BIN || "/usr/bin/fm";

// fm serve leaks its chat-template control tokens into `content` on most replies to a
// request that carries `tools`: `<start_of_turn>`, `<ctrl46>` and friends. Stripping
// them is content filtering, and this proxy otherwise corrects only envelopes and
// schemas, so it is opt-in and off by default. Set FM_STRIP_TEMPLATE_MARKERS=1.
//
// Leaving it off keeps an audit honest: the markers are how you detect the upstream bug.
const STRIP_MARKERS = process.env.FM_STRIP_TEMPLATE_MARKERS === "1";
// Only the template's own delimiters. `<ctrl\d+>` and `<|...|>` are single tokens in the
// vocabulary, so they arrive whole in one delta and never straddle a chunk boundary
// (verified live over 8 streaming runs). Anything looser would eat ordinary markup.
const TEMPLATE_MARKER = /<start_of_turn>|<end_of_turn>|<ctrl\d+>|<\|[^|>]*\|>/g;
function stripTemplateMarkers(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(TEMPLATE_MARKER, "");
}

// fm serve rejects `stop` with "stop sequences are not supported. Truncate the model's
// output client-side." The proxy is the client, so it does that: `stop` is dropped from
// the forwarded body and the reply is cut at the earliest match, which is removed.
// OpenAI specifies that the returned text does not contain the stop sequence.
// An empty string never matches — otherwise it would truncate everything at index 0.
function truncateAtStop(text, stop) {
  const list = (typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop : [])
    .filter((sq) => typeof sq === "string" && sq.length > 0);
  if (typeof text !== "string" || !list.length) return { text, hit: false };
  let cut = -1;
  for (const sq of list) {
    const i = text.indexOf(sq);
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  return cut === -1 ? { text, hit: false } : { text: text.slice(0, cut), hit: true };
}

// fm serve has DISTINCT failure modes this proxy must not conflate (see
// classifyError): transient rate-limits are retried with backoff; safety-guardrail
// aborts, forced-tool_choice rejections and HTTP 400s are deterministic + terminal
// and never retried. Set FM_MAX_RETRIES=0 to disable retries.
const MAX_RETRIES = Number(process.env.FM_MAX_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.FM_RETRY_BASE_MS ?? 1000);
const RETRY_CAP_MS = Number(process.env.FM_RETRY_CAP_MS ?? 15000);

// ── Token counting ───────────────────────────────────────────────────────────
// Fallback only: fm serve sends real usage, so this runs when a request ends without
// one (a guardrail abort). `fm count-tokens` where possible, chars/4.4 heuristic when
// it is unavailable. Every count forks `fm` synchronously and blocks the event loop,
// so callers must stay off the hot path.
const CHARS_PER_TOKEN = 4.4;
// A measured constant that reproduces fm serve's prompt_tokens exactly — do not
// "simplify" it. It is the fixed cost around a whole conversation, present only with
// -i, and flat at 54 for lengths 6 to 400.
const CONVERSATION_FRAMING = 54;

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
const TOKEN_SUBCOMMAND = "count-tokens";
// The CLI has a machine-wide legal-notice gate: until a privileged user runs
// `sudo fm license`, every subcommand exits 69 and prints a banner to stderr.
// That failure is permanent, not transient, so retrying it once
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
    const out = execFileSync(FM_BIN, args, {
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

// JSON Schema lets `type` be an array. fm serve rejects that outright, and it is what
// zod's .nullable() and pydantic's Optional[] emit, so an ordinary generated schema 400s
// on both the tool and the response_format path.
//
// Collapse to the first non-null member, matching what flattenComposite already does
// with an anyOf union. Dropping "null" loses nothing fm serve could express. A genuine
// union like ["string","number"] also collapses to its first member, which is lossy, but
// it is the same trade the anyOf path already makes and it beats a 400.
function collapseTypeArray(node) {
  if (!node || typeof node !== "object" || !Array.isArray(node.type)) return node;
  const real = node.type.find((t) => t !== "null") || "string";
  return { ...node, type: real };
}

function simplifyProperty(prop) {
  if (!prop || typeof prop !== "object") return prop;
  prop = collapseTypeArray(prop);

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
// Flatten a tool's parameter schema into what fm serve decodes. Every nesting depth
// passes through natively, so this only strips unsupported keywords and
// preserves `required`.
function fixToolSchema(schema) {
  const result = { type: "object", required: [] };
  if (!schema || typeof schema !== "object") {
    result.properties = {};
    return result;
  }

  // Resolve $refs first: simplifyProperty strips $ref/$defs, flattening a referenced
  // param to `{}` — the shape pydantic/zod emit for named types. Inlining gives fm
  // serve the nesting it decodes natively.
  if (schema.$defs) schema = inlineDefs(schema) || schema;

  result.properties = {};
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    result.properties[name] = simplifyProperty(prop);
  }
  // Preserve the caller's `required` — dropping it made params optional and the model
  // emitted partial/empty tool calls.
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return result;
}

// ── response_format schema dialect (structured output) ──────────────────────
// Strategy for the whole section: inline every $ref and drop $defs, so fm serve never
// sees a construct it does not understand. Dialect injection is the fallback for the
// schemas that cannot be inlined.
//
// The dialect is title + x-order + required + additionalProperties on every object
// reached through `$defs`; a missing key returns 400 naming it. Objects reached by
// inline nesting need none, which is why inlining is primary.
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

// Detect a definition that reaches itself through $refs, directly or transitively.
// Returns the first cyclic definition's name, or null when the graph is acyclic.
//
// Forwarding a cyclic $defs hangs fm serve permanently, and every later request hangs
// with it until a restart. Recursion has no finite inline form, so these must be
// rejected rather than repaired. A cycle carrying an extra required scalar happens to
// return 200 today, but that is an undocumented parser quirk — do not bet on it.
function findCyclicDefs(schema) {
  const defs = schema && schema.$defs;
  if (!defs || typeof defs !== "object") return null;
  const scanRefs = (node, into) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) scanRefs(n, into); return; }
    if (typeof node.$ref === "string") {
      const name = node.$ref.startsWith(DEFS_REF_PREFIX) ? node.$ref.slice(DEFS_REF_PREFIX.length) : null;
      if (name !== null && Object.prototype.hasOwnProperty.call(defs, name)) into.add(name);
    }
    for (const v of Object.values(node)) scanRefs(v, into);
  };
  const done = new Set(); // definitions fully explored with no cycle through them
  const dfs = (name, stack) => {
    if (stack.has(name)) return name; // the definition reached itself: cycle
    if (done.has(name)) return null;
    stack.add(name);
    const refs = new Set();
    scanRefs(defs[name], refs);
    for (const r of refs) {
      const hit = dfs(r, stack);
      if (hit) return hit;
    }
    stack.delete(name);
    done.add(name);
    return null;
  };
  for (const name of Object.keys(defs)) {
    const hit = dfs(name, new Set());
    if (hit) return hit;
  }
  return null;
}

// Inline the $refs, or fall back to dialect injection when the schema cannot be
// inlined. A cyclic schema never reaches here in production — fixTools rejects it
// first — so the fallback is defence in depth for direct callers.
// Walk a response_format schema and collapse every `type` array in place. Unlike a tool
// schema this one is not otherwise simplified: fm serve decodes nested objects here
// natively, so only the shapes it rejects are repaired.
function collapseTypeArraysDeep(node) {
  if (Array.isArray(node)) { node.forEach(collapseTypeArraysDeep); return node; }
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node.type)) node.type = node.type.find((t) => t !== "null") || "string";
  for (const key of ["properties", "$defs", "definitions"]) {
    if (node[key] && typeof node[key] === "object") {
      for (const sub of Object.values(node[key])) collapseTypeArraysDeep(sub);
    }
  }
  if (node.items) collapseTypeArraysDeep(node.items);
  return node;
}

function fixResponseFormatSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (!schema.$defs) return collapseTypeArraysDeep(schema);
  const inlined = inlineDefs(schema);
  if (inlined) return collapseTypeArraysDeep(inlined);
  for (const [name, def] of Object.entries(schema.$defs)) decorateDialect(def, name);
  return collapseTypeArraysDeep(schema);
}

// ── forced tool dispatch ────────────────────────────────────────────────────
// fm serve answers a forced `tool_choice` with `500 An unsupported generation guide was
// used.` It does honour `response_format`, so a forced call is translated into a schema
// and constrained decoding does the work the broken tool parser cannot.
//
// Measured on the 27.0 RC, 5 runs each, before this was written:
//   forced named function                     5/5 called, 98 prompt tokens
//   "required", 2 tools, no prose escape     10/10 correct routing, ~105 tokens
//   auto, with a prose escape                 0/25 — the model always took the escape
//   native tools for the same request         0 tool_calls, 256 tokens, markers leaked
//
// Auto is deliberately NOT translated. Removing the prose escape is what makes the
// model select a tool, and auto must be able to answer without calling one.
const DISPATCH_INSTRUCTION = (names) =>
  "You have access to external functions. You MUST call exactly one of them: " +
  names.map((n) => `"${n}"`).join(", ") + ".\n" +
  "Respond with a JSON object whose single key is that function's name and whose value " +
  "is that function's arguments object. Never add other keys.";

// Returns a dispatch plan, or null when this request must not be translated.
function buildToolDispatch(parsed) {
  const tools = parsed && Array.isArray(parsed.tools) ? parsed.tools : null;
  if (!tools || !tools.length) return null;
  const choice = parsed.tool_choice;
  const named = choice && typeof choice === "object" && choice.type === "function"
    ? choice.function && choice.function.name
    : null;
  if (choice !== "required" && !named) return null;   // auto, none, or absent

  const fns = tools.map((t) => t && t.function).filter((f) => f && f.name);
  const chosen = named ? fns.filter((f) => f.name === named) : fns;
  if (!chosen.length) return null;                    // named a function we were not given

  const properties = {};
  for (const f of chosen) {
    const params = f.parameters || {};
    const prop = { type: "object", properties: params.properties || {} };
    if (Array.isArray(params.required)) prop.required = params.required;
    if (f.description) prop.description = f.description;
    properties[f.name] = prop;
  }
  return {
    schema: { type: "object", properties, required: named ? [named] : [] },
    instruction: DISPATCH_INSTRUCTION(chosen.map((f) => f.name)),
    toolNames: chosen.map((f) => f.name),
  };
}

// Turn the model's schema-constrained reply into OpenAI `tool_calls`. Null when the
// content is not a usable dispatch object, so the caller can relay it untouched rather
// than invent a call.
function dispatchToToolCalls(content, toolNames) {
  let obj = null;
  try { obj = JSON.parse(content); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const name = Object.keys(obj).find((k) => toolNames.includes(k));
  if (!name) return null;
  const args = obj[name];
  return {
    tool_calls: [{
      id: "call_" + Math.random().toString(36).slice(2, 12),
      type: "function",
      function: { name, arguments: JSON.stringify(args == null ? {} : args) },
    }],
  };
}

// Rewrite tools into fm-serve-compatible schemas; returns body and parsed req.
function fixTools(body) {
  try {
    const parsed = JSON.parse(body);
    // fm serve rejects the `developer` role with a 400 that names nothing useful
    // ("Invalid JSON: The data couldn't be read because it isn't in the correct
    // format."). OpenAI introduced `developer` as the successor to `system` and its
    // own SDKs emit it, so map it rather than let an ordinary client fail.
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) if (m && m.role === "developer") m.role = "system";
    }
    // fm serve 400s on `stop`. The proxy applies it to the reply instead, so the field
    // must not reach upstream; the caller reads it back off `parsed`.
    const stopSequences = parsed.stop;
    delete parsed.stop;
    // `reasoning_effort` was a pcc-only knob and pcc was removed from the binary, so on
    // `system` it can only ever 400. Drop it rather than fail a request over a field
    // that has no effect either way.
    delete parsed.reasoning_effort;
    // A forced tool_choice 500s upstream. Translate it into a schema instead, and let
    // constrained decoding pick the tool. Done before the tool-schema rewrite below,
    // because a dispatched request forwards no `tools` at all.
    const dispatch = buildToolDispatch(parsed);
    if (dispatch) {
      const instr = { role: "system", content: dispatch.instruction };
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const sysIdx = msgs.findIndex((m) => m && m.role === "system");
      if (sysIdx >= 0) msgs[sysIdx] = { ...msgs[sysIdx],
        content: `${dispatch.instruction}\n\n${msgs[sysIdx].content ?? ""}` };
      else msgs.unshift(instr);
      parsed.messages = msgs;
      // The caller's own response_format cannot survive: the reply must be the dispatch
      // object. A forced tool call and a caller schema are mutually exclusive requests.
      parsed.response_format = { type: "json_schema",
        json_schema: { name: "ToolDispatch", schema: dispatch.schema } };
      delete parsed.tools;
      delete parsed.tool_choice;
    }
    if (parsed.tools) {
      parsed.tools = parsed.tools.map((tool) => {
        const schema = fixToolSchema(tool.function?.parameters);
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
      if (js && js.schema) {
        // A cyclic $defs cannot be inlined (recursion has no finite inline form) and
        // forwarding it to fm serve HANGS the server permanently — every later request
        // hangs too, until a restart. Reject the request with a client error
        // naming the offending definition instead (see findCyclicDefs; the request
        // handler answers 400 before any upstream connection is made).
        const cyclic = findCyclicDefs(js.schema);
        if (cyclic) return { body, parsed, responseFormatCycle: cyclic };
        js.schema = fixResponseFormatSchema(js.schema);
      }
    }
    // `stop` is returned on its own, NEVER re-attached to `parsed`. Callers re-serialise
    // `parsed` later (to force stream_options, or to apply a cap), and anything left on
    // it goes back on the wire — which is how `stop` reached fm serve and 400'd.
    // NOTHING is re-attached to `parsed`. Callers re-serialise it later — to force
    // stream_options, to apply a cap, or to force stream:false for a dispatch — and
    // anything left on it goes back on the wire. That mistake put `stop` and then
    // `tool_choice` in front of fm serve and 400'd/500'd the request while the stub
    // tests stayed green. A value the relay needs is RETURNED, never re-attached.
    return { body: JSON.stringify(parsed), parsed, stopSequences, dispatch };
  } catch {
    return { body, parsed: null };
  }
}

// Classify an upstream fm-serve error message into a distinct OpenAI-shaped error type
// so clients can branch on the *cause* rather than string-matching Apple's prose. The
// failure modes (see header comment) need different client remedies:
//   - rate-limit: transient, retry.
//   - safety-guardrail abort: deterministic + terminal, do NOT retry.
//   - forced tool_choice: deterministic + terminal, do NOT retry.
//   - HTTP 400: deterministic + terminal, do NOT retry.
// `retry` tells the streaming/non-stream paths whether backoff is worthwhile. Every
// case is decided from the message alone, except the HTTP 400 branch, which needs the
// upstream status code (`status`): a 400 body's message (e.g. "Unknown model 'x'.")
// matches none of the message branches.
function classifyError(msg, status) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("guardrail"))
    return { type: "generation_aborted", code: "safety_guardrail", retry: false, label: "SAFETY-GUARDRAIL ABORT" };
  // The tool-call parser rejects malformed generated arguments with this message.
  // Deterministic for a given request (verified live, 5/5 identical failures — e.g. a
  // model emitting raw JSON where the schema says string), so retrying just burned the
  // full ~35s backoff ladder. Typed server_error: the failure is the model/decoder's,
  // not the client's.
  if (m.includes("failed to parse generated content"))
    return { type: "server_error", code: "generation_parse_failed", retry: false, label: "GENERATION PARSE FAILED" };
  // A forced tool_choice is rejected with a clean 500 "An unsupported generation guide
  // was used." in ~140ms. That wording matches none of the branches below, so without
  // this it falls through to the retryable default and burns the whole backoff ladder on
  // a permanent request-shape rejection. Terminal by construction: the generation guide
  // is fixed by the request, so a retry sends it again.
  if (m.includes("unsupported generation guide"))
    return { type: "invalid_request_error", code: "tool_choice_unsupported", retry: false,
             label: "UNSUPPORTED GENERATION GUIDE (forced tool_choice)" };
  // The prompt is larger than the model's window. fm serve reports it as a 500, but it
  // is a client-shape problem: the request is fixed, so every retry re-sends the same
  // oversized transcript and re-fails identically. Terminal, and typed the way OpenAI
  // types it (`invalid_request_error` / `context_length_exceeded`) so clients can branch
  // on it and trim. The on-device window is 4096 tokens, which agent harnesses overshoot
  // easily, so this is a common failure — it must not cost the full backoff ladder.
  // `clientMessage` is surfaced in place of fm serve's wording. Clients auto-recover
  // from an overflow (compact, then retry) by matching the error TEXT rather than the
  // code — the phrases in the wild are "context length exceeded", "exceeds the context
  // window", "too many tokens", "token limit exceeded". fm serve's sentence matches
  // none, so a client that could have recovered simply gave up. Lead with the canonical
  // phrase and keep Apple's sentence after it, so the upstream cause stays greppable.
  if (m.includes("exceeded the model's context size") || m.includes("exceeds the maximum allowed context"))
    return { type: "invalid_request_error", code: "context_length_exceeded", retry: false,
             label: "CONTEXT EXCEEDED",
             clientMessage: "The session's transcript exceeded the model's context size " +
               "— context length exceeded. Reduce the prompt or compact the conversation." };
  // fm serve only does schema-constrained JSON, not OpenAI's free-form `json_object`
  // mode. Its own message already says to use `json_schema`, which is more actionable
  // than most; give it a code too, so a client can branch instead of matching prose.
  // Not translated to a permissive schema: that would silently narrow "any JSON" to
  // "this JSON".
  if (m.includes("'json_object' is not supported"))
    return { type: "invalid_request_error", code: "json_object_unsupported", retry: false,
             label: "JSON_OBJECT MODE UNSUPPORTED" };
  // A genuine rate limit. Do NOT reclassify this on the request's shape: forced
  // tool_choice has its own message (handled above), so any extra reclassification here
  // would only mislabel a real rate limit as a permanent client error and skip the
  // retry that would have recovered it.
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit"))
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  // An upstream HTTP 400 is a client-shape rejection (unknown model, malformed body)
  // — deterministic and permanent: fm serve rejects it in ~7ms, and a retry re-sends
  // the identical rejection. Without this the generic fallback below treated it as
  // retryable, burning the full 1+2+4+8s backoff ladder before surfacing a
  // misleading server_error/internal_error. Terminal, typed invalid_request_error —
  // the client must change the request. Only the GENERIC fallback is upgraded: every
  // branch above keeps its own semantics on any status (a rate-limit signature stays
  // retryable even on a 400). Same defect class the tool_choice branch above fixes.
  if (status === 400)
    return { type: "invalid_request_error", code: "invalid_request", retry: false, label: "BAD REQUEST (terminal)" };
  return { type: "server_error", code: "internal_error", retry: true, label: "UPSTREAM ERROR" };
}

// Build an SSE error frame (`data: {"error":{...}}\n\n`) carrying a typed OpenAI error.
function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({
    // A classification may carry its own client-facing wording (see classifyError's
    // overflow branch) — prefer it over upstream's, which clients cannot match on.
    error: { message: cls.clientMessage || msg || "upstream error", type: cls.type, code: cls.code },
  })}\n\n`;
}

// An SSE/JSON frame is an error when it carries `error` and no usable choices.
function isErrorPayload(obj) {
  return !!(obj && obj.error && !(obj.choices && obj.choices.length));
}

// Classify the error an upstream frame/body carries — the shared entry for the
// streaming data-frame, bare-JSON, and non-streaming body paths. `status` is the
// upstream HTTP status code (undefined when unknown); see classifyError.
function classifyErrorPayload(obj, status) {
  return classifyError(obj && obj.error && obj.error.message, status);
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
  module.exports = { fixTools, fixToolSchema, fixResponseFormatSchema, findCyclicDefs, classifyError, errorFrame, fmTokenCount, _isLicenseGate, stripTemplateMarkers, truncateAtStop, buildToolDispatch, dispatchToToolCalls };
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
// Build the upstream payload and the per-request context: schema rewrites, stream
// fixups, header scrubbing, and the lazy token-count fallback.
function prepareUpstreamRequest(req, body) {
  const { body: toolFixed, parsed: parsedReq, responseFormatCycle, stopSequences, dispatch } = fixTools(body);

  const isChat = !!(req.url && req.url.includes("/chat/completions"));
  // A dispatched reply is one JSON object and cannot become `tool_calls` until it has
  // arrived whole and parsed. So ask fm serve for a non-streaming reply even when the
  // client wants SSE, and synthesise the stream on the way back out.
  const dispatchStreamOut = !!(dispatch && parsedReq && parsedReq.stream);
  if (dispatchStreamOut) parsedReq.stream = false;
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
  // returned 10. Left alone, a client that sets a cap gets unbounded generation. Map it
  // across, without overriding an explicit max_completion_tokens.
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
  if (dispatchStreamOut) fixed = JSON.stringify(parsedReq);
  if (cappedAt != null && parsedReq) fixed = JSON.stringify(parsedReq);
  if (isStream && parsedReq) {
    parsedReq.stream_options = { ...(parsedReq.stream_options || {}), include_usage: true };
    fixed = JSON.stringify(parsedReq);
  } else if (isChat && parsedReq && parsedReq.stream === undefined) {
    // fm serve's default: a chat request that OMITS `stream` comes back as
    // text/event-stream, not the single JSON object the OpenAI spec returns — so pin
    // stream:false for clients that never set the field.
    parsedReq.stream = false;
    fixed = JSON.stringify(parsedReq);
  }
  // Prompt tokens for the rare case where fm serve sends no usage at all (a guardrail
  // abort that never finishes). Counting forks `fm` synchronously, which blocks the
  // event loop, so never do it on the hot path: the relays call this only when the
  // fallback actually fires.
  const promptTokensFallback = () =>
    isChat && parsedReq ? countPromptTokens(parsedReq.messages) : 0;

  // Always forward a fully-buffered body with our own Content-Length; drop any
  // inbound Transfer-Encoding — keeping both is illegal framing and upstream rejects
  // it with HPE_INVALID_CONTENT_LENGTH.
  const upstreamHeaders = { ...req.headers, "content-length": Buffer.byteLength(fixed) };
  delete upstreamHeaders["transfer-encoding"];
  // fm serve refuses a request that looks cross-site: any of Origin, Referer or
  // Sec-Fetch-Site earns `403 Cross-site requests are not allowed`. A browser client
  // sets them automatically, so forwarding them made the proxy 403 every real browser
  // request — the proxy's own CORS headers cannot rescue a body that never ran. This
  // hop is local (browser → proxy → 127.0.0.1), so the browser's origin says nothing
  // about it; strip the whole family. (An Origin of localhost/127.0.0.1 happens to
  // pass upstream, which is why local test pages never showed the failure.)
  for (const h of Object.keys(upstreamHeaders)) {
    if (h === "origin" || h === "referer" || h.startsWith("sec-fetch-")) delete upstreamHeaders[h];
  }
  return { fixed, upstreamHeaders, parsedReq, isChat, isStream,
           clientDeclinedUsage, promptTokensFallback, cappedAt, responseFormatCycle, stopSequences, dispatch, dispatchStreamOut };
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
function relayStreamingChat({ res, proxyRes, diag, commit, isCommitted, fail, isAborting, cappedAt,
                              parsedReq, promptTokensFallback, clientDeclinedUsage, reqStart, stopSequences }) {
  // Real usage needs the forced include_usage upstream; completionText stays a fallback.
  let completionText = "";
  let realUsage = null;   // fm serve's own usage object, if it sent one
  let sawFinish = false;  // a clean finish_reason or [DONE] arrived
  // `stop` was withheld from fm serve, so honour it here. A sequence can span two
  // deltas, so hold back the last (maxStopLen - 1) characters: they are the only ones
  // that could still be completing a match. Anything held is flushed at end of stream.
  const stopList = (() => {
    const raw = stopSequences;
    const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    return list.filter((sq) => typeof sq === "string" && sq.length > 0);
  })();
  const maxStopLen = stopList.reduce((m, sq) => Math.max(m, sq.length), 0);
  let pendingTail = "";
  let stopHit = false;
  const applyStopHoldback = (text) => {
    if (stopHit) return "";                    // everything after the stop is discarded
    const full = pendingTail + text;
    const { text: cut, hit } = truncateAtStop(full, stopList);
    if (hit) { stopHit = true; pendingTail = ""; return cut; }
    const hold = Math.min(maxStopLen - 1, full.length);
    pendingTail = hold > 0 ? full.slice(full.length - hold) : "";
    return hold > 0 ? full.slice(0, full.length - hold) : full;
  };

  let producedOutput = false; // any content or tool_calls delta seen
  let tFirstToken = null;  // wall-clock of first output delta (TTFT + tok/s)
  let pending = "";       // line buffer across chunk boundaries
  let lastChunkMeta = null;
  let rawTail = "";       // last bytes of the upstream stream, for failure forensics
  let surfacedError = false; // we already forwarded a typed error frame
  let abortFinishReason = null; // set to "content_filter" on a guardrail abort
  // Under a cap, upstream's finish_reason chunk arrives BEFORE the usage frame, so the
  // stop-vs-length call cannot be made yet. Hold the value here and let the trailing
  // chunk emit it once. Relaying it now and adding "length" later put TWO finish_reason
  // values in one stream, which clients read last-wins: pi saw "length" on a complete
  // answer and rendered nothing.
  let heldFinish = null;
  // A stream can open with an empty {"delta":{"role":"assistant"}} preamble, THEN
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
      let line = idx !== -1 ? pending.slice(0, idx + 1) : pending;
      pending = idx !== -1 ? pending.slice(idx + 1) : "";
      const t = line.trim();
      let obj = null, isErr = false, errCls = null, meaningful = false;
      if (t.startsWith("data:")) {
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") { sawFinish = true; if (!isCommitted()) commitFlush(); continue; }
        try {
          obj = JSON.parse(payload);
          isErr = isErrorPayload(obj);
          if (isErr) {
            errCls = classifyErrorPayload(obj, proxyRes.statusCode);
          } else if (obj.usage && (!obj.choices || obj.choices.length === 0)) {
            // fm serve's real usage-only chunk — capture it; never relay this frame raw (the
            // end-of-stream handler emits the client-facing chunk from these numbers).
            realUsage = obj.usage;
            continue;
          } else {
            lastChunkMeta = { id: obj.id, model: obj.model, created: obj.created };
            const ch0 = obj.choices && obj.choices[0];
            if (ch0 && ch0.finish_reason) {
              sawFinish = true; meaningful = true;
              if (cappedAt != null) {
                heldFinish = ch0.finish_reason;
                delete ch0.finish_reason;
                // Relay the chunk with the reason stripped rather than dropping it, so
                // the SSE framing stays one event per upstream event. The replacement
                // MUST be a function: a string replacement makes String.replace expand
                // $&, $`, $' and $n out of the completion text, which corrupts the frame
                // into unparseable JSON. Replacing in place (rather than rebuilding the
                // line) also keeps the flush path right, where the line has no trailing
                // newline to re-add.
                line = line.replace(payload, () => JSON.stringify(obj));
              }
            }
            const delta = ch0 && ch0.delta;
            if (delta && typeof delta.content === "string") {
              if (tFirstToken == null) tFirstToken = Date.now();
              const original = delta.content;
              if (STRIP_MARKERS) delta.content = stripTemplateMarkers(delta.content);
              if (stopList.length) delta.content = applyStopHoldback(delta.content);
              if (delta.content !== original) {
                // In-place rewrite with a FUNCTION replacement: a string replacement
                // would expand $& out of the completion text and corrupt the frame.
                line = line.replace(payload, () => JSON.stringify(obj));
              }
              // Accumulate what the client actually receives, so the usage fallback
              // counts the relayed text rather than the raw upstream text.
              completionText += delta.content; producedOutput = true; meaningful = true;
            }
            // Tool-call deltas are real output too: mark the stream meaningful so an
            // error after them is treated as post-commit, not retryable.
            if (delta && Array.isArray(delta.tool_calls)) {
              if (tFirstToken == null) tFirstToken = Date.now();
              producedOutput = true; meaningful = true;
            }
          }
        } catch { /* keepalive / non-JSON */ }
      } else if (/languagemodelerror|error -1|exceeded the model's context size/i.test(t)) {
        isErr = true; // raw (non-data) error line
        errCls = classifyError(t);
      } else if (t.startsWith("{")) {
        // fm serve returns non-SSE errors (e.g. a 400 for an unknown model) as BARE
        // JSON — parse and classify it instead of retrying the stream blindly.
        try {
          obj = JSON.parse(t);
          if (isErrorPayload(obj)) {
            isErr = true;
            errCls = classifyErrorPayload(obj, proxyRes.statusCode);
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
          "upstream returned no output after retries"));
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
    // Nothing matched a stop sequence, so the held-back tail is real output. Flush it
    // as its own chunk before the final one, or the client silently loses the last few
    // characters of every completion.
    if (pendingTail && !stopHit) {
      const m0 = lastChunkMeta || {};
      res.write(`data: ${JSON.stringify({ id: m0.id || "chatcmpl-proxy",
        object: "chat.completion.chunk", created: m0.created || Math.floor(Date.now() / 1000),
        model: m0.model || (parsedReq && parsedReq.model) || "system",
        choices: [{ index: 0, delta: { content: pendingTail } }] })}\n\n`);
      completionText += pendingTail;
      pendingTail = "";
    }
    // Prefer fm serve's real usage. Counting the text ourselves forks `fm`, so it
    // happens only when no usage frame arrived at all (a guardrail abort that never
    // finishes) — never on an ordinary stream.
    let usage = realUsage;
    if (!usage) {
      const pt = promptTokensFallback();
      const ct = countCompletionTokens(completionText);
      usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
    }
    // Throughput: generation time is first-token → now; TTFT is request → first-token.
    const nowEnd = Date.now();
    logToks(
      (parsedReq && parsedReq.model) || "unknown", "stream", Number(usage.completion_tokens) || 0,
      tFirstToken != null ? nowEnd - tFirstToken : nowEnd - reqStart,
      tFirstToken != null ? tFirstToken - reqStart : null,
    );
    const meta = lastChunkMeta || {};
    // Same truncation mislabel as the non-streaming path: fm serve says "stop" even when
    // it stopped at the cap. Only rewrite a plain stop — never an abort's content_filter.
    const cappedFinish = (cappedAt != null && !abortFinishReason &&
                          Number(usage.completion_tokens) >= Number(cappedAt))
      ? "length" : null;
    // Exactly one finish_reason leaves this relay: an abort wins, then the length
    // rewrite, then whatever upstream said and this chunk held back.
    const carriedFinish = abortFinishReason || cappedFinish || heldFinish;
    const finishChunk = {
      id: meta.id || "chatcmpl-proxy",
      object: "chat.completion.chunk",
      created: meta.created || Math.floor(Date.now() / 1000),
      model: meta.model || (parsedReq && parsedReq.model) || "unknown",
      // A usage chunk carries `choices: []` — OpenAI's shape, and fm serve's. Attach a
      // choices entry ONLY to carry a finish_reason this chunk is the sole source of
      // (a guardrail abort, or the length rewrite). Emitting `finish_reason: null` here
      // overwrites the real "stop" for any client that reads the last chunk, which is
      // how an ordinary completion got reported as truncated.
      choices: carriedFinish ? [{ index: 0, delta: {}, finish_reason: carriedFinish }] : [],
    };
    // Always suppress upstream's [DONE] and re-emit our own final chunk so clients get
    // real usage. Explicit include_usage:false → no usage field (vanilla OpenAI shape);
    // absent/true keeps the always-on chunk. finish_reason must still go out on an
    // opt-out — for content_filter it is ONLY carried by this chunk (the abort's own
    // error frame is swallowed above), so the chunk can't be dropped wholesale.
    if (!clientDeclinedUsage) {
      res.write(`data: ${JSON.stringify({ ...finishChunk, usage })}\n\n`);
    } else if (carriedFinish) {
      // Usage was declined, but a finish_reason this chunk alone carries must still go
      // out — a length cap as well as a content_filter abort.
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

// Turn one buffered completion into the SSE frames a streaming client expects. Used
// only for a dispatched request, where the reply had to be parsed whole before any
// `tool_calls` could be named.
const ARG_CHUNK = 64;
function emitSynthesisedStream(res, obj, status, upstreamHeaders) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const ch = obj.choices && obj.choices[0] ? obj.choices[0] : {};
  const meta = { id: obj.id || "chatcmpl-proxy", object: "chat.completion.chunk",
                 created: obj.created || Math.floor(Date.now() / 1000),
                 model: obj.model || "system" };
  const send = (delta, extra) => res.write(`data: ${JSON.stringify({ ...meta,
    choices: [{ index: 0, delta, ...(extra || {}) }] })}\n\n`);

  send({ role: "assistant" });
  const calls = ch.message && ch.message.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    calls.forEach((tc, i) => {
      // The opening delta names the call; the rest carry only argument text, which is
      // the shape OpenAI streams and what SDKs accumulate on.
      send({ tool_calls: [{ index: i, id: tc.id, type: "function",
                            function: { name: tc.function.name, arguments: "" } }] });
      const args = tc.function.arguments || "";
      for (let p = 0; p < args.length; p += ARG_CHUNK) {
        send({ tool_calls: [{ index: i, function: { arguments: args.slice(p, p + ARG_CHUNK) } }] });
      }
    });
  } else if (ch.message && typeof ch.message.content === "string" && ch.message.content) {
    send({ content: ch.message.content });
  }
  res.write(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {},
    finish_reason: ch.finish_reason || "stop" }], usage: obj.usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
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
                                 parsedReq, promptTokensFallback, reqStart, cappedAt, stopSequences, dispatch, dispatchStreamOut }) {
// Non-streaming: buffer fully (so we can still retry), then fix usage.
let raw = "";
proxyRes.on("data", (c) => (raw += c));
proxyRes.on("end", () => {
  if (isAborting()) return;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* not JSON */ }
  let outStatus = proxyRes.statusCode;
  if (isErrorPayload(obj)) {
    const cls = classifyErrorPayload(obj, proxyRes.statusCode);
    if (cls.type === "generation_aborted") {
      diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
      // content_filter: a normal 200 completion finished by the filter, empty content.
      obj = {
        id: "chatcmpl-proxy", object: "chat.completion",
        model: (parsedReq && parsedReq.model) || "unknown",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
        usage: (() => { const pt = promptTokensFallback();
                        return { prompt_tokens: pt, completion_tokens: 0, total_tokens: pt }; })(),
      };
      outStatus = 200;
    } else if (retryOrSurface(cls, "non-stream", `— ${raw.slice(0, 200)}`, "non-stream error", fail, diag)) {
      return;
    } else if (obj.error && typeof obj.error === "object") {
      // terminal, or retries exhausted: type it, preferring the classification's own
      // client-facing wording when it has one (see classifyError's overflow branch).
      obj.error = { message: cls.clientMessage || obj.error.message, type: cls.type, code: cls.code };
    }
  }
  let out = raw;
  if (obj) {
    // fm serve's non-streaming usage is accurate — pass it through untouched.
    const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
    // A dispatched request asked fm serve for the tool-selection object. Turn it back
    // into the `tool_calls` shape the client asked for. A reply we cannot use is
    // relayed untouched: inventing a call would be worse than surfacing the text.
    if (dispatch && msg && typeof msg.content === "string") {
      const call = dispatchToToolCalls(msg.content, dispatch.toolNames);
      if (call) {
        msg.tool_calls = call.tool_calls;
        msg.content = null;
        obj.choices[0].finish_reason = "tool_calls";
      } else {
        diag("DISPATCH UNPARSED (relaying content)", `— ${msg.content.slice(0, 120)}`);
      }
    }
    if (STRIP_MARKERS && msg && typeof msg.content === "string") {
      msg.content = stripTemplateMarkers(msg.content);
    }
    // `stop` was withheld from fm serve (it 400s), so apply it here.
    if (msg && typeof msg.content === "string" && stopSequences) {
      const { text, hit } = truncateAtStop(msg.content, stopSequences);
      if (hit) {
        msg.content = text;
        obj.choices[0].finish_reason = "stop";
      }
    }
    applyLengthFinish(obj, cappedAt);
    out = JSON.stringify(obj);
  }
  // Throughput: duration is request-received → now (upstream buffers the whole reply).
  const nsCompletionTokens = (obj && obj.usage && obj.usage.completion_tokens) || 0;
  logToks((parsedReq && parsedReq.model) || "unknown", "sync", nsCompletionTokens, Date.now() - reqStart);
  markCommitted();
  // The client asked for SSE on a dispatched request, so the buffered reply becomes a
  // stream here. Arguments go out in pieces, as OpenAI does, so a client that
  // concatenates `function.arguments` across deltas gets valid JSON.
  if (dispatchStreamOut && obj) {
    emitSynthesisedStream(res, obj, outStatus, proxyRes.headers);
    return;
  }
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
    const { fixed, upstreamHeaders, parsedReq, isChat, isStream,
            clientDeclinedUsage, promptTokensFallback, cappedAt, responseFormatCycle, stopSequences, dispatch, dispatchStreamOut } = ctx;

    // One-line failure diagnostic. Success is not logged.
    const diag = (label, extra = "") =>
      console.error(`[fm-proxy] *** ${label} ***` + (extra ? ` ${extra}` : ""));

    // A cyclic $defs in response_format would hang fm serve PERMANENTLY — only a
    // restart clears it, and every later request hangs too. Reject it here,
    // before any upstream connection: a clear 400 invalid_request_error naming the
    // offending definition, so the client can fix the schema instead of poisoning
    // the server.
    if (responseFormatCycle) {
      diag("CYCLIC $defs REJECTED", `— response_format definition '${responseFormatCycle}'`);
      const message = `response_format schema contains a cyclic $defs definition '${responseFormatCycle}' — ` +
        "recursive schemas have no finite inline form and hang fm serve; remove the cycle";
      res.writeHead(400, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: { message, type: "invalid_request_error", code: "cyclic_schema" } }));
      return;
    }

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
          // Log the status only when it is not a success. A line per healthy request
          // is noise the operator has to filter back out.
          if (isChat && proxyRes.statusCode >= 400)
            diag(`UPSTREAM RESPONSE HTTP ${proxyRes.statusCode}`);
          proxyRes.on("error", (e) => { if (isChat) diag("UPSTREAM RES SOCKET ERROR", `— ${e.message}`); });

          // Only intervene on chat completions; everything else passes through.
          if (!isChat) {
            res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
            proxyRes.pipe(res);
            return;
          }

          const g = createAttemptGate({ res, proxyRes, proxyReq, plan, attempt, isStream, diag });
          gate = g;
          const relay = { res, proxyRes, diag, ...g, parsedReq, promptTokensFallback, reqStart, cappedAt, stopSequences, dispatch, dispatchStreamOut };
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
