// Tests for fm-proxy schema flattening. Run: node --test
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { fixToolSchema, fixTools, fixResponseFormatSchema, expandToolCallArguments, classifyError, errorFrame, fmTokenCount } = require("./fm-proxy.js");

// fm serve (Beta 3 / fm 2.0.59) fixed the GenerationSchema `duplicateType` bug that
// used to force EVERY nested object through a JSON-string round-trip, and Beta 4
// (fm 2.0.62) fixed the 3+-chained-object $defs leak. Verified live against a real
// `fm serve`: flat schemas, object nesting to any chain depth, array<object>, and
// object -> array -> object all decode correctly and natively now — no round-trip
// needed. ONE shape is still broken (verified live on Beta 4, not assumed — see
// needsJsonRoundTrip's comment in fm-proxy.js):
//   - array<array<object>> (an object reachable through 2+ consecutive array wrappers)
//     — Beta 4 errors "Failed to parse generated content" (Beta 3 silently omitted
//     the argument). array<array<number>> (primitive leaf) is fine.
// That residual shape still uses the lossless JSON-string round-trip.

// ── fm count-tokens (renamed from token-count in Beta 4) ─────────────────────
// fmTokenCount must return an EXACT tokenizer count, not the chars/4.4 heuristic.
// "hello world" is exactly 11 tokens per Apple's tokenizer (stable across
// Beta 1–4); the heuristic would give 9 + ceil(11/4.4) = 12. If the fm CLI
// subcommand name changes again (Beta 4 renamed token-count → count-tokens) and
// the probe misses it, this test catches the silent fall-through to null.
test("fmTokenCount returns the exact tokenizer count via the fm CLI (count-tokens rename)", () => {
  assert.strictEqual(fmTokenCount("hello world"), 11);
});

test("single-level nested object param passes through natively (no round-trip)", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: { filter: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.filter.type, "object");
  assert.strictEqual(schema.properties.filter.properties.q.type, "string");
  assert.deepStrictEqual(schema.properties.filter.required, ["q"]);
});

test("object with properties but NO explicit type is normalized to type:object, not flattened", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      items: { type: "array", items: { properties: { id: { type: "string" } } } },
    },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.items.items.type, "object");
  assert.strictEqual(schema.properties.items.items.properties.id.type, "string");
});

test("array<object> (single array level) passes through natively", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      edits: {
        type: "array",
        items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
      },
    },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.edits.items.type, "object");
  assert.deepStrictEqual(schema.properties.edits.items.required, ["old", "new"]);
});

test("object chain depth 2 (object containing object) passes through natively", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      a: {
        type: "object",
        properties: { b: { type: "object", properties: { val: { type: "string" } }, required: ["val"] } },
        required: ["b"],
      },
    },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.a.properties.b.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.val.type, "string");
});

test("object -> array -> object passes through natively (the array resets the object chain)", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      order: {
        type: "object",
        properties: {
          customer: { type: "string" },
          items: {
            type: "array",
            items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "number" } }, required: ["sku", "qty"] },
          },
        },
        required: ["customer", "items"],
      },
    },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.order.properties.items.items.type, "object");
});

test("array<array<object>> still needs the JSON-string round-trip (fm serve silently drops it otherwise)", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
  });
  assert.deepStrictEqual(jsonFields, ["grid"]);
  assert.strictEqual(schema.properties.grid.type, "string");
});

test("array<array<number>> (primitive leaf) passes through natively — only object leaves round-trip", () => {
  const { schema, jsonFields } = fixToolSchema({
    properties: { grid: { type: "array", items: { type: "array", items: { type: "number" } } } },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.grid.items.type, "array");
  assert.strictEqual(schema.properties.grid.items.items.type, "number");
});

test("a chain of 3+ directly-nested objects passes through natively (fixed in Beta 4 / fm 2.0.62)", () => {
  // Beta 3 leaked internal $defs registration for 3+ chains; Beta 4 decodes them
  // correctly (verified live 5/5 on system and pcc, incl. a 4-level chain).
  const { schema, jsonFields } = fixToolSchema({
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: { c: { type: "object", properties: { val: { type: "string" } }, required: ["val"] } },
            required: ["c"],
          },
        },
        required: ["b"],
      },
    },
  });
  assert.deepStrictEqual(jsonFields, []);
  assert.strictEqual(schema.properties.a.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.c.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.c.properties.val.type, "string");
});

test("anyOf picks the typed branch, strips the keyword", () => {
  const { schema } = fixToolSchema({
    properties: { v: { anyOf: [{ type: "null" }, { type: "string", enum: ["a", "b"] }] } },
  });
  assert.ok(!("anyOf" in schema.properties.v), "anyOf leaked");
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

test("required list is preserved for a round-tripped field (array<array<object>>)", () => {
  // path is a plain string, grid is array<array<object>> -> still JSON-string
  // round-tripped (see the residual-shapes comment above). Both are required; the
  // model must not be told they are optional.
  const { schema } = fixToolSchema({
    properties: {
      path: { type: "string" },
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
    required: ["path", "grid"],
  });
  assert.deepStrictEqual(schema.required.sort(), ["grid", "path"]);
  assert.strictEqual(schema.properties.grid.type, "string"); // still round-tripped
});

test("round-trip prose demands a QUOTED JSON string (Beta 4 rejects raw JSON in a string slot)", () => {
  // Beta 4's parser deterministically 500s ("Failed to parse generated content")
  // when the model emits raw JSON where the schema says string — which the old
  // "JSON string matching: {...}" prose reliably provoked. The reworded prose
  // ("must be a quoted JSON string, not raw JSON") got the model to emit a real
  // quoted string 4/4 in live trials. Pin the load-bearing phrase.
  const { schema } = fixToolSchema({
    properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
  });
  assert.match(schema.properties.grid.description, /must be a quoted JSON string, not raw JSON/);
  assert.match(schema.properties.grid.description, /matching: \{/);
});

test("required list is preserved through native nested passthrough (object and array<object>)", () => {
  const { schema } = fixToolSchema({
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
      },
    },
    required: ["path", "edits"],
  });
  assert.deepStrictEqual(schema.required.sort(), ["edits", "path"]);
  assert.strictEqual(schema.properties.edits.type, "array"); // native, not round-tripped
  assert.strictEqual(schema.properties.edits.items.type, "object");
});

test("required filters out names that no longer exist", () => {
  const { schema } = fixToolSchema({
    properties: { a: { type: "string" } },
    required: ["a", "ghost"],
  });
  assert.deepStrictEqual(schema.required, ["a"]);
});

test("coercion roundtrip: JSON-string args re-expand to objects (residual round-tripped shape)", () => {
  const { coercion } = fixTools(JSON.stringify({
    tools: [{ function: { name: "search", parameters: { properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    } } } }],
  }));
  assert.deepStrictEqual(coercion.search, ["grid"]);
  const out = expandToolCallArguments("search", JSON.stringify({ grid: '[[{"x":1}]]' }), coercion);
  assert.deepStrictEqual(JSON.parse(out), { grid: [[{ x: 1 }]] });
});

test("coercion roundtrip: HTML-entity-mangled JSON string is decoded then expanded (Beta 4 model quirk)", () => {
  // Seen live on Beta 4: the model emits &quot; (and friends) inside the
  // round-tripped JSON string instead of escaped quotes. A plain JSON.parse
  // fails; a one-shot entity decode recovers the real nested value.
  const { coercion } = fixTools(JSON.stringify({
    tools: [{ function: { name: "search", parameters: { properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    } } } }],
  }));
  const out = expandToolCallArguments("search", JSON.stringify({ grid: "[[{&quot;x&quot;:1}]]" }), coercion);
  assert.deepStrictEqual(JSON.parse(out), { grid: [[{ x: 1 }]] });
});

test("native nested object param needs no coercion (not in the coercion map)", () => {
  const { coercion } = fixTools(JSON.stringify({
    tools: [{ function: { name: "search", parameters: { properties: { filter: { type: "object", properties: { q: { type: "string" } } } } } } }],
  }));
  assert.strictEqual(coercion.search, undefined);
});

// ── function.description backfill ──────────────────────────────────────────
// fm serve (Beta 3 / fm 2.0.59, verified live) 400s EVERY tool-calling request —
// regardless of parameters shape, tool_choice, or which tool the model actually
// calls — with "Invalid JSON: The data couldn't be read because it is missing."
// whenever ANY tool in the array has function.description absent or null. An
// empty string ("") is accepted. This was originally misdiagnosed as an
// empty-parameters bug (see memory beta3-tool-choice-required-crash's caveat)
// because a minimal no-arg test tool naturally omits `description` too — but a
// non-empty-parameters tool with no description hits the identical 400, and a
// no-parameters tool WITH a description (even "") works fine. OpenAI's
// tool-calling spec makes `description` optional, so a compliant client can
// send exactly the shape that breaks fm serve. Fix: fixTools backfills a
// missing/null description to "" before forwarding.
test("fixTools backfills a missing function.description to empty string", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools normalizes a null function.description to empty string", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: null, parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools preserves a real function.description untouched", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: "does a thing", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "does a thing");
});

test("fixTools backfills description on every tool in a multi-tool request, not just one", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [
      { type: "function", function: { name: "a", description: "has one", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "has one");
  assert.strictEqual(parsed.tools[1].function.description, "");
});

// ── response_format schema dialect (structured output) ────────────────────────
// Live-verified against a real `fm serve` (2026-07-06, fm 2.0.59, macOS 27 Beta 3):
// the title/x-order/required/additionalProperties dialect is required ONLY on
// object schemas reached through `$defs` (the $defs entries themselves, and any
// object nested inside one -- inline sub-properties, array items -- recursively).
// The top-level schema and any object reached purely through inline `properties`
// nesting (never touching $defs) decode with ZERO dialect keys, contrary to the
// original 2026-06-14 finding (which only tested $ref/$defs-shaped schemas). Real
// schema generators (pydantic .model_json_schema(), zod-to-json-schema, ...)
// virtually always emit $defs/$ref for named/reused types, so this still breaks
// structured output for real clients -- just narrower than "every object level".

test("flat response_format schema with no $defs is left completely untouched", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  const before = JSON.parse(JSON.stringify(schema));
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema, before);
});

test("multi-level inline-nested response_format schema with no $defs is left untouched", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
        required: ["street", "city"],
      },
    },
    required: ["name", "address"],
  };
  const before = JSON.parse(JSON.stringify(schema));
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema, before);
});

test("a $defs entry gets title, x-order, required, and additionalProperties injected", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
    required: ["name", "address"],
    $defs: {
      Address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
      },
    },
  };
  fixResponseFormatSchema(schema);
  const addr = schema.$defs.Address;
  assert.strictEqual(addr.title, "Address");
  assert.deepStrictEqual(addr["x-order"], ["street", "city"]);
  assert.deepStrictEqual(addr.required, []);
  assert.strictEqual(addr.additionalProperties, false);
});

test("an existing required array on a $defs entry is preserved (filtered to real properties)", () => {
  const schema = {
    type: "object",
    properties: { address: { $ref: "#/$defs/Address" } },
    $defs: {
      Address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
        required: ["street", "city", "ghost"],
      },
    },
  };
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema.$defs.Address.required, ["street", "city"]);
});

test("an already-set additionalProperties on a $defs entry is preserved, not overwritten", () => {
  const schema = {
    type: "object",
    properties: {},
    $defs: { X: { type: "object", properties: {}, additionalProperties: true } },
  };
  fixResponseFormatSchema(schema);
  assert.strictEqual(schema.$defs.X.additionalProperties, true);
});

test("an inline nested object INSIDE a $defs entry also gets the dialect (cascades)", () => {
  const schema = {
    type: "object",
    properties: { address: { $ref: "#/$defs/Address" } },
    $defs: {
      Address: {
        type: "object",
        properties: {
          street: { type: "string" },
          geo: {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" } },
            required: ["lat", "lng"],
          },
        },
        required: ["street", "geo"],
      },
    },
  };
  fixResponseFormatSchema(schema);
  const geo = schema.$defs.Address.properties.geo;
  assert.strictEqual(geo.title, "Geo");
  assert.deepStrictEqual(geo["x-order"], ["lat", "lng"]);
  assert.deepStrictEqual(geo.required, ["lat", "lng"]);
  assert.strictEqual(geo.additionalProperties, false);
});

test("an object reached through an array's items inside a $defs entry gets the dialect", () => {
  const schema = {
    type: "object",
    properties: { reviews: { type: "array", items: { $ref: "#/$defs/Review" } } },
    $defs: {
      Review: {
        type: "object",
        properties: { author: { type: "string" }, text: { type: "string" } },
        required: ["author", "text"],
      },
    },
  };
  fixResponseFormatSchema(schema);
  const review = schema.$defs.Review;
  assert.strictEqual(review.title, "Review");
  assert.deepStrictEqual(review["x-order"], ["author", "text"]);
});

test("the top-level schema is left dialect-free even when $defs is present", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
    required: ["name", "address"],
    $defs: {
      Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
    },
  };
  fixResponseFormatSchema(schema);
  assert.strictEqual(schema.title, undefined);
  assert.strictEqual(schema["x-order"], undefined);
  assert.strictEqual(schema.additionalProperties, undefined);
});

test("a mixed schema: inline-nested object outside $defs stays untouched, $defs entry gets decorated", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      rating: {
        type: "object",
        properties: { score: { type: "number" }, count: { type: "integer" } },
        required: ["score", "count"],
      },
      address: { $ref: "#/$defs/Address" },
    },
    required: ["name", "rating", "address"],
    $defs: {
      Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
    },
  };
  fixResponseFormatSchema(schema);
  assert.strictEqual(schema.properties.rating.title, undefined);
  assert.strictEqual(schema.properties.rating["x-order"], undefined);
  assert.strictEqual(schema.$defs.Address.title, "Address");
  assert.deepStrictEqual(schema.$defs.Address["x-order"], ["street"]);
});

test("a schema with an empty $defs object is left untouched (no-op, not an error)", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, $defs: {} };
  const before = JSON.parse(JSON.stringify(schema));
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema, before);
});

test("fixTools also decorates response_format.json_schema.schema.$defs in the request body", () => {
  const { body } = fixTools(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "restaurant",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
          required: ["name", "address"],
          $defs: {
            Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
          },
        },
      },
    },
  }));
  const parsed = JSON.parse(body);
  const addr = parsed.response_format.json_schema.schema.$defs.Address;
  assert.strictEqual(addr.title, "Address");
  assert.deepStrictEqual(addr["x-order"], ["street"]);
  assert.strictEqual(addr.additionalProperties, false);
  // top level untouched
  assert.strictEqual(parsed.response_format.json_schema.schema.title, undefined);
});

test("fixTools leaves a request with no response_format untouched (no crash, no field added)", () => {
  const { body } = fixTools(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.response_format, undefined);
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

test("a client tool with no description reaches upstream with description backfilled to empty string", async () => {
  // Regression test for the live 400 ("Invalid JSON: ... is missing.") fm serve
  // returns for ANY tool lacking function.description — verified against a real
  // fm serve, not just the mock here (see the fixTools unit tests above).
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "call foo" }],
      tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const got = stack.getLastBody();
    assert.strictEqual(got.tools[0].function.description, "");
  } finally { await stack.stop(); }
});

test("a plain response_format with $defs/$ref (no dialect) reaches upstream fully decorated", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "restaurant" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "restaurant",
          schema: {
            type: "object",
            properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
            required: ["name", "address"],
            $defs: {
              Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
            },
          },
        },
      },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const got = stack.getLastBody();
    const addr = got.response_format.json_schema.schema.$defs.Address;
    assert.strictEqual(addr.title, "Address");
    assert.deepStrictEqual(addr["x-order"], ["street"]);
    assert.strictEqual(addr.additionalProperties, false);
    assert.strictEqual(got.response_format.json_schema.schema.title, undefined);
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

// tool_choice:"required" (or forcing a specific function) crashes fm serve's `system`
// engine with the IDENTICAL LanguageModelError -1 signature used for PCC rate-limiting
// (verified live — see memory beta3-tool-choice-required-crash / beta3-audit-remaining-
// tests). It's a deterministic, permanent client-request-shape bug, not transient, and
// `pcc` handles forced tool_choice fine — so classifyError must check the original
// request (model + tool_choice) to avoid retry-looping a permanent bug for ~19.5s
// before mislabeling it as rate_limit_exceeded.

test("classifyError: tool_choice:required on model=system reclassifies as a permanent, non-retryable bug", () => {
  const c = classifyError("LanguageModelError -1", { model: "system", tool_choice: "required" });
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.retry, false);
});

test("classifyError: a forced function tool_choice on model=system also reclassifies", () => {
  const c = classifyError("LanguageModelError -1", {
    model: "system", tool_choice: { type: "function", function: { name: "foo" } },
  });
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.retry, false);
});

test("classifyError: the identical error on model=pcc is NOT reclassified (bug is system-only)", () => {
  const c = classifyError("LanguageModelError -1", { model: "pcc", tool_choice: "required" });
  assert.strictEqual(c.type, "rate_limit_exceeded");
  assert.strictEqual(c.retry, true);
});

test("classifyError: model=system WITHOUT a forced tool_choice still classifies as a normal rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1", { model: "system", tool_choice: "auto" }).type, "rate_limit_exceeded");
  assert.strictEqual(classifyError("LanguageModelError -1", { model: "system" }).type, "rate_limit_exceeded");
});

test("classifyError: called without a parsedReq argument (backward compatible) still classifies as rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1").type, "rate_limit_exceeded");
});

test("classifyError: 'Failed to parse generated content' (new in Beta 4) is deterministic — no retry", () => {
  // Beta 4's stricter tool-call parser rejects malformed generated arguments with
  // this message. Verified live to be deterministic for a given request (5/5
  // identical failures) — retrying burned ~35s through the full backoff ladder
  // before surfacing. Must be terminal, and typed server_error (it is not the
  // client's fault; the model/decoder failed to produce parseable output).
  const c = classifyError("Failed to parse generated content.");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.code, "generation_parse_failed");
  assert.strictEqual(c.retry, false);
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

test("tool_choice:required on model=system is typed invalid_request_error through the real proxy, not retried as rate-limit", async () => {
  // Reproduces the live failure: fm serve's `system` engine 500s with the exact
  // LanguageModelError -1 signature used for PCC rate-limiting when tool_choice
  // forces a call. The proxy must classify this by inspecting the original request
  // (model + tool_choice), not just the message text, and must NOT retry it.
  let requestCount = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      requestCount++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "The operation couldn't be completed. (FoundationModels.LanguageModelError error -1.)", type: "server_error", code: "500" },
      }));
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: false, tool_choice: "required",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"invalid_request_error"'), `body=${res.body}`);
    assert.ok(!/"type":"rate_limit_exceeded"/.test(res.body), `body=${res.body}`);
    assert.strictEqual(requestCount, 1, "must not retry a permanent client-request-shape bug");
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

// ── tok/s counter ─────────────────────────────────────────────────────────────
// Every chat completion logs a one-line `[toks]` throughput counter to stderr.
// It is NOT gated behind --verbose (unlike `[assembled] req`), so it shows up in
// the launcher's quiet mode — the user-facing counter this feature exists for.
// These tests pin the shape: model, stream/sync kind, output token count, a
// duration, and a numeric tok/s figure. They also confirm TTFT is reported for
// streaming and omitted for non-streaming.

test("tok/s: streaming completion logs [toks] stream with ttft", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"pcc","choices":[{"index":0,"delta":{"content":"hello world"}}]}\n\n');
      res.write('data: {"id":"x","model":"pcc","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "pcc", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const line = stack.getStderr().split("\n").find((l) => l.includes("[toks]"));
    assert.ok(line, `no [toks] line in stderr:\n${stack.getStderr()}`);
    assert.match(line, /model=pcc/);
    assert.match(line, /\sstream\s/);
    assert.match(line, /out=\d+/);          // non-zero output tokens ("hello world")
    assert.match(line, /dur=[0-9.]+s/);
    assert.match(line, /ttft=\d+ms/);       // streaming reports time-to-first-token
    assert.match(line, /=>\s+[0-9.]+ tok\/s/);
  } finally { await stack.stop(); }
});

test("tok/s: non-streaming completion logs [toks] sync without ttft", async () => {
  const stack = await startStack(); // default handler: non-streaming, completion_tokens: 1
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const line = stack.getStderr().split("\n").find((l) => l.includes("[toks]"));
    assert.ok(line, `no [toks] line in stderr:\n${stack.getStderr()}`);
    assert.match(line, /model=system/);
    assert.match(line, /\ssync\s/);
    assert.match(line, /out=1\b/);
    assert.match(line, /dur=[0-9.]+s/);
    assert.match(line, /=>\s+[0-9.]+ tok\/s/);
    // Non-streaming has no first-token timestamp, so ttft must NOT appear.
    assert.doesNotMatch(line, /ttft=/);
  } finally { await stack.stop(); }
});

// ── Token usage passthrough (Beta 3) ────────────────────────────────────────
// fm serve 2.0.59 (macOS 27 Beta 3) fixed non-streaming usage.prompt_tokens: it used
// to be hardcoded 0, so the proxy overwrote it with its own "assembled" estimate.
// Verified live against a real fm serve that the reported prompt_tokens now matches
// `fm token-count` exactly. The proxy must no longer clobber fm serve's own (now
// correct) non-streaming usage — the client should see fm serve's real numbers
// untouched.
//
// Streaming: fm serve sends a REAL usage chunk too, but only when the request
// opts in via the standard OpenAI `stream_options.include_usage:true` field —
// real clients (Pi included) essentially never set it. The proxy now forces
// that flag upstream on every streaming request regardless of what the client
// sent, captures fm serve's real final usage-only chunk, and relays it instead
// of the old completion-text-based estimate (which remains only as a fallback
// for upstreams that don't cooperate). The client's OWN ask about what THEY
// get back is still honored on the way out: explicit
// `stream_options.include_usage:false` suppresses the usage field in the
// relayed stream; absent or `true` keeps the proxy's established always-on
// usage chunk, just backed by real numbers now.

test("non-streaming: fm serve's own accurate usage passes through unmodified (no override)", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      const out = JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        // Deliberately distinctive numbers, unrelated to the proxy's own message-size
        // estimate, so a leftover override would be caught by a mismatch.
        usage: { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(out);
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const obj = JSON.parse(res.body);
    assert.deepStrictEqual(obj.usage, { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 });
  } finally { await stack.stop(); }
});

test("streaming: fm serve sends no usage, so the proxy still injects a computed usage chunk", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const usageLine = res.body.split("\n").find((l) => l.includes('"usage"'));
    assert.ok(usageLine, `no usage chunk in stream:\n${res.body}`);
    const chunk = JSON.parse(usageLine.slice(usageLine.indexOf("{")));
    assert.ok(chunk.usage.prompt_tokens > 0, `prompt_tokens should be computed, got ${chunk.usage.prompt_tokens}`);
    assert.strictEqual(chunk.usage.completion_tokens, chunk.usage.total_tokens - chunk.usage.prompt_tokens);
  } finally { await stack.stop(); }
});

// ── Forcing stream_options.include_usage upstream (Beta 3 follow-up) ───────
// fm serve sends a REAL final usage chunk on a streaming completion, but only
// when the request opts in via the standard OpenAI `stream_options.
// include_usage:true` field — real clients (Pi included) essentially never
// set it. The proxy now forces that flag upstream on every streaming request
// regardless of what the client sent, captures fm serve's real final
// usage-only chunk, and relays it instead of the completion-text-based
// estimate (which remains only as a fallback for upstreams that ignore the
// flag — see "fm serve sends no usage" above). The client's OWN ask about
// what THEY get back is still honored on the way out: explicit
// `stream_options.include_usage:false` suppresses the usage field in the
// relayed stream; absent or `true` keeps the proxy's established always-on
// usage chunk, just backed by real numbers now.

test("streaming: proxy forces stream_options.include_usage upstream even when the client didn't ask", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(stack.getLastBody().stream_options && stack.getLastBody().stream_options.include_usage, true);
  } finally { await stack.stop(); }
});

test("non-streaming requests are left untouched (no stream_options forced)", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(stack.getLastBody().stream_options, undefined);
  } finally { await stack.stop(); }
});

test("streaming: fm serve's real usage chunk is relayed verbatim, not recomputed", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      // fm serve's real final usage-only chunk (choices:[]), sent because the
      // proxy forced stream_options.include_usage:true upstream.
      res.write('data: {"id":"x","model":"system","choices":[],"usage":{"prompt_tokens":4242,"completion_tokens":7,"total_tokens":4249}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    const usageLines = res.body.split("\n").filter((l) => l.includes('"usage"'));
    assert.strictEqual(usageLines.length, 1, `expected exactly one usage chunk:\n${res.body}`);
    const chunk = JSON.parse(usageLines[0].slice(usageLines[0].indexOf("{")));
    assert.deepStrictEqual(chunk.usage, { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 });
    // The raw upstream usage-only frame (choices:[]) must never leak through
    // verbatim — only the proxy's own rebuilt final chunk carries usage.
    assert.ok(!/"choices":\[\]/.test(res.body), `raw usage-only frame leaked through:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: explicit stream_options.include_usage:false suppresses the usage chunk in the client response", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      // The upstream flag must still be forced true regardless of the client's ask.
      assert.strictEqual(parsed.stream_options && parsed.stream_options.include_usage, true);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[],"usage":{"prompt_tokens":4242,"completion_tokens":7,"total_tokens":4249}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: true, messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: false },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(!/"usage"/.test(res.body), `usage leaked through despite explicit opt-out:\n${res.body}`);
    assert.ok(/"finish_reason":"stop"/.test(res.body)); // the finish_reason itself still arrives
    assert.ok(/data: \[DONE\]/.test(res.body));
  } finally { await stack.stop(); }
});

test("streaming: content_filter abort still emits its finish_reason even when the client opted out of usage", async () => {
  // The abort path swallows the guardrail error frame and signals the finish
  // ONLY via the proxy's own final chunk — so opting out of usage must not
  // also silently drop the finish_reason the client needs to see.
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
    const payload = JSON.stringify({
      model: "pcc", stream: true, messages: [{ role: "user", content: "x" }],
      stream_options: { include_usage: false },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"usage"/.test(res.body), `usage leaked through despite explicit opt-out:\n${res.body}`);
  } finally { await stack.stop(); }
});
