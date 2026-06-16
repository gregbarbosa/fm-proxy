// Tests for fm-proxy schema flattening. Run: node --test
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { fixToolSchema, fixTools, expandToolCallArguments, classifyError, errorFrame } = require("./fm-proxy.js");

// A schema is fm-serve-safe iff every property is a primitive/array-of-primitive
// and carries no nested `properties` and no composition keywords. This walks the
// flattened output and asserts nothing fm serve can't represent survived.
function assertFlat(schema) {
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    assert.ok(prop && typeof prop === "object", `${name} is an object`);
    assert.notStrictEqual(prop.type, "object", `${name} leaked type:object`);
    assert.ok(!prop.properties, `${name} leaked nested properties`);
    for (const k of ["anyOf", "allOf", "oneOf", "$ref"]) {
      assert.ok(!(k in prop), `${name} leaked ${k}`);
    }
    if (prop.type === "array" && prop.items) {
      assert.notStrictEqual(prop.items.type, "object", `${name}.items leaked object`);
      assert.ok(!prop.items.properties, `${name}.items leaked nested properties`);
      assert.notStrictEqual(prop.items.type, "array", `${name}.items leaked nested array`);
    }
  }
}

test("nested object param becomes a JSON-string field", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: { filter: { type: "object", properties: { q: { type: "string" } } } },
  });
  assert.deepStrictEqual(jsonFields, ["filter"]);
  assert.strictEqual(schema.properties.filter.type, "string");
  assertFlat(schema);
});

test("object with properties but NO explicit type is still flattened (leak #1)", () => {
  // A nested object lacking type:"object" — needsJsonRoundTrip catches it at the
  // top level, but a nested one inside an array must not survive simplifyProperty.
  const { schema } = fixToolSchema({
    properties: {
      items: { type: "array", items: { properties: { id: { type: "string" } } } },
    },
  });
  assertFlat(schema);
});

test("array<array<object>> does not leak nested array of objects (leak #2)", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
  });
  assert.deepStrictEqual(jsonFields, ["grid"]);
  assertFlat(schema);
});

test("anyOf picks the typed branch, strips the keyword", () => {
  const { schema } = fixToolSchema({
    properties: { v: { anyOf: [{ type: "null" }, { type: "string", enum: ["a", "b"] }] } },
  });
  assertFlat(schema);
  assert.ok(["null", "string"].includes(schema.properties.v.type));
});

test("primitive params survive untouched (minus stripped keys)", () => {
  const { schema } = fixToolSchema({
    properties: { n: { type: "integer", minimum: 0, description: "count" } },
  });
  assert.strictEqual(schema.properties.n.type, "integer");
  assert.strictEqual(schema.properties.n.minimum, 0);
  assert.ok(!("description" in schema.properties.n)); // STRIP_KEYS drops description
});

test("required list is preserved (incl. JSON-round-tripped fields)", () => {
  // edit-like tool: path is a plain string, edits is array<object> -> JSON string.
  // Both are required; the model must not be told they are optional.
  const { schema } = fixToolSchema({
    properties: {
      path: { type: "string" },
      edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } } } },
    },
    required: ["path", "edits"],
  });
  assert.deepStrictEqual(schema.required.sort(), ["edits", "path"]);
  assert.strictEqual(schema.properties.edits.type, "string"); // still round-tripped
});

test("required filters out names that no longer exist", () => {
  const { schema } = fixToolSchema({
    properties: { a: { type: "string" } },
    required: ["a", "ghost"],
  });
  assert.deepStrictEqual(schema.required, ["a"]);
});

test("coercion roundtrip: JSON-string args re-expand to objects", () => {
  const { coercion } = fixTools(JSON.stringify({
    tools: [{ function: { name: "search", parameters: { properties: { filter: { type: "object", properties: { q: { type: "string" } } } } } } }],
  }));
  assert.deepStrictEqual(coercion.search, ["filter"]);
  const out = expandToolCallArguments("search", JSON.stringify({ filter: '{"q":"hi"}' }), coercion);
  assert.deepStrictEqual(JSON.parse(out), { filter: { q: "hi" } });
});

// ── Integration tests: real HTTP through a spawned proxy ──────────────────────
// These boot `node fm-proxy.js` against a mock fm serve so the actual request
// path (CORS, error shape, multimodal passthrough) is exercised over the wire.

// Grab a free TCP port by binding to :0 and reading what the OS assigned.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// One-shot request helper. Returns { status, headers, body }.
function request(port, opts, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Start a mock fm serve + the real proxy. `upstreamPort = 0` means "point the
// proxy at a dead port" so its socket error path (502) fires. `handler` receives
// (mockReq, parsedBody, mockRes) for tests that need to inspect what arrived.
async function startStack({ handler, deadUpstream = false } = {}) {
  const proxyPort = await freePort();
  let upstream = null;
  let lastBody = null;
  let upstreamPort = await freePort(); // reserved; used live unless deadUpstream

  if (!deadUpstream) {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        lastBody = parsed;
        if (handler) return handler(req, parsed, res);
        // default: a minimal non-streaming OpenAI completion
        const out = JSON.stringify({
          id: "chatcmpl-mock", object: "chat.completion", model: "system",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out);
      });
    });
    await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
  }

  const child = spawn(process.execPath, [path.join(__dirname, "fm-proxy.js")], {
    env: { ...process.env, FM_PORT: String(upstreamPort), PROXY_PORT: String(proxyPort),
           FM_MAX_RETRIES: "0", GAUGE_MODE: "msgs" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  // Wait for the "listening" banner so we don't race the first request.
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("proxy did not start")), 5000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) { clearTimeout(to); resolve(); }
    });
    child.on("error", reject);
  });

  return {
    proxyPort,
    getLastBody: () => lastBody,
    getStderr: () => stderr,
    async stop() {
      child.kill();
      if (upstream) await new Promise((r) => upstream.close(r));
    },
  };
}

test("CORS preflight: OPTIONS returns 204 with allow-origin", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort, { method: "OPTIONS", path: "/v1/chat/completions" });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
    assert.match(res.headers["access-control-allow-methods"] || "", /POST/);
    // Authorization must be named explicitly (wildcard doesn't cover it), and `*`
    // must be present so the OpenAI SDK's x-stainless-* headers clear preflight.
    const allow = res.headers["access-control-allow-headers"] || "";
    assert.match(allow, /Authorization/i);
    assert.match(allow, /\*/);
  } finally { await stack.stop(); }
});

test("CORS header present on a real chat completion", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

test("unreachable upstream yields a 502 with an error OBJECT (not a string)", async () => {
  const stack = await startStack({ deadUpstream: true });
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 502);
    const obj = JSON.parse(res.body);
    assert.strictEqual(typeof obj.error, "object");
    assert.strictEqual(typeof obj.error.message, "string");
    assert.match(obj.error.message, /fm serve unreachable/);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

test("image_url content part reaches upstream byte-intact (multimodal passthrough)", async () => {
  // A valid 1x1 PNG data URL; the proxy must forward it unaltered.
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: [
        { type: "text", text: "what color?" },
        { type: "image_url", image_url: { url: dataUrl } },
      ] }],
    });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    const got = stack.getLastBody();
    const part = got.messages[0].content.find((p) => p.type === "image_url");
    assert.ok(part, "image_url part survived to upstream");
    assert.strictEqual(part.image_url.url, dataUrl);
  } finally { await stack.stop(); }
});

// ── Error classification ────────────────────────────────────────────────────
// The proxy must distinguish fm serve's two mid-stream failure modes so clients can
// branch: rate-limit (retry) vs safety-guardrail abort (terminal). See fm-proxy.js
// header comment.

test("classifyError: safety-guardrail abort is terminal and typed", () => {
  const c = classifyError("The model's safety guardrails were triggered.");
  assert.strictEqual(c.type, "generation_aborted");
  assert.strictEqual(c.code, "safety_guardrail");
  assert.strictEqual(c.retry, false);
});

test("classifyError: LanguageModelError -1 is a retryable rate-limit", () => {
  const c = classifyError("LanguageModelError -1");
  assert.strictEqual(c.type, "rate_limit_exceeded");
  assert.strictEqual(c.code, -1);
  assert.strictEqual(c.retry, true);
});

test("classifyError: PCC 'not available in this context' is terminal service_unavailable", () => {
  // The ModelManagerError 1013 / HTTP 503 body fm serve returns when PCC attribution
  // is missing (e.g. fm serve spawned under node). Deterministic — must NOT retry.
  const c = classifyError("Model 'pcc' is unavailable: PCC inference is not available in this context.");
  assert.strictEqual(c.type, "service_unavailable");
  assert.strictEqual(c.code, "model_unavailable");
  assert.strictEqual(c.retry, false);
});

test("classifyError: bare service_unavailable type is also terminal", () => {
  assert.strictEqual(classifyError("service_unavailable").retry, false);
  assert.strictEqual(classifyError("service_unavailable").type, "service_unavailable");
});

test("classifyError: plain 'rate limit' phrase also classifies as rate-limit", () => {
  assert.strictEqual(classifyError("rate limit exceeded").type, "rate_limit_exceeded");
});

test("classifyError: unknown upstream errors are retryable server_errors", () => {
  const c = classifyError("something else went wrong");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.retry, true);
});

test("classifyError: null/empty message is an unknown error, not a crash", () => {
  assert.strictEqual(classifyError(null).type, "server_error");
});

test("errorFrame: emits an SSE data line with a typed OpenAI error object", () => {
  const cls = classifyError("The model's safety guardrails were triggered.");
  const frame = errorFrame(cls, "The model's safety guardrails were triggered.");
  assert.ok(frame.startsWith("data: ") && frame.endsWith("\n\n"));
  assert.deepStrictEqual(JSON.parse(frame.slice(6).trim()), {
    error: { message: "The model's safety guardrails were triggered.", type: "generation_aborted", code: "safety_guardrail" },
  });
});

test("safety-guardrail abort ends as finish_reason:content_filter with partial kept (no error frame)", async () => {
  // Mock fm serve emits valid content, THEN the guardrail error frame. OpenAI-idiomatic:
  // the proxy must NOT throw an error frame; it keeps the partial and ends the stream
  // with finish_reason:"content_filter" so SDK clients get the partial + a documented
  // finish_reason instead of an exception.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"pcc","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      res.write("data: " + JSON.stringify({ error: { code: "500", message: "The model's safety guardrails were triggered.", type: "server_error" } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    // Partial content emitted before the abort survives.
    assert.ok(res.body.includes('"content":"partial"'), `body=${res.body}`);
    // The stream ends with finish_reason:"content_filter".
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    // NO error frame is emitted (the OpenAI SDK would raise on one).
    assert.ok(!/"error"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"generation_aborted"/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("safety-guardrail abort BEFORE any content still ends as content_filter (empty completion)", async () => {
  // Pre-commit guardrail: no partial. Still a content_filter finish, not an error.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ error: { message: "The model's safety guardrails were triggered." } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"error"/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("non-streaming guardrail returns a content_filter completion (200, no error)", async () => {
  // Non-streaming: fm serve's error body carries no partial → empty content +
  // finish_reason:"content_filter", HTTP 200 (a valid completion, not an error).
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The model's safety guardrails were triggered." } }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: false, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `status=${res.status} body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.choices[0].finish_reason, "content_filter");
    assert.strictEqual(obj.choices[0].message.content, "");
    assert.ok(!obj.error, `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("rate-limit error frame (pre-commit) is surfaced as rate_limit_exceeded", async () => {
  // Mock fm serve emits the PCC rate-limit signature: an error frame before any content.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ error: { message: "LanguageModelError -1", code: -1 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"rate_limit_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("PCC-unavailable 503 (bare-JSON body, no SSE framing) is typed service_unavailable, not retried as rate-limit", async () => {
  // Reproduces the live failure: fm serve returns HTTP 503 with a BARE-JSON error body
  // (NOT a `data:`-framed SSE frame) when `pcc` lacks attribution. The proxy must
  // classify it and surface a typed service_unavailable, not treat it as an empty
  // stream and emit the generic "no output (likely PCC rate limit)" message.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "service_unavailable", code: "503",
          message: "Model 'pcc' is unavailable: PCC inference is not available in this context." },
      }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"service_unavailable"'), `body=${res.body}`);
    assert.ok(res.body.includes('"code":"model_unavailable"'), `body=${res.body}`);
    // Regression guard: the old generic "no output / rate limit" frame must NOT appear.
    assert.ok(!/likely PCC rate limit/.test(res.body), `body=${res.body}`);
    assert.ok(!/"type":"rate_limit_exceeded"/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});
