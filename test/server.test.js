const { test } = require("node:test");
const assert = require("node:assert");
const { startStack, request, rewriteBody } = require("./helpers");

// ── Server basics ─────────────────────────────────────────────────────────────
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

test("a plain response_format with $defs/$ref reaches upstream inlined, with no $defs", async () => {
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
    const schema = stack.getLastBody().response_format.json_schema.schema;
    assert.strictEqual(schema.$defs, undefined, "$defs must not reach fm serve");
    assert.deepStrictEqual(schema.properties.address, {
      type: "object", properties: { street: { type: "string" } }, required: ["street"],
    });
    assert.strictEqual(schema.title, undefined);
  } finally { await stack.stop(); }
});

test("a cyclic $defs response_format is rejected 400 before reaching upstream (fm serve hang guard)", async () => {
  // Beta 7: forwarding this exact shape (the wire-baseline 'response_format cyclic'
  // fixture) hangs fm serve PERMANENTLY — every later request hangs too until a
  // restart. The proxy must answer 400 itself, naming the offending definition,
  // and must never open an upstream connection.
  let upstreamHits = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => { upstreamHits++; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); },
  });
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "N",
          schema: {
            type: "object",
            properties: { root: { $ref: "#/$defs/Node" } },
            $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
          },
        },
      },
    });
    const t0 = Date.now();
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(upstreamHits, 0, "the hang-inducing schema must never reach fm serve");
    assert.strictEqual(res.status, 400, `body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.error.type, "invalid_request_error");
    assert.strictEqual(obj.error.code, "cyclic_schema");
    assert.match(obj.error.message, /Node/, "the error names the offending definition");
    assert.ok(Date.now() - t0 < 2000, "rejection is immediate, no backoff ladder");
  } finally { await stack.stop(); }
});

// ── streaming usage is always requested upstream ────────────────────────────────────
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
    // Exactly one usage chunk (asserted above) is what proves the raw upstream frame
    // did not leak through beside the proxy's rebuilt one. `choices: []` is NOT a leak
    // marker: it is the correct OpenAI shape for a usage chunk, and the proxy now emits
    // it too rather than a fake `finish_reason: null`.
    assert.deepStrictEqual(chunk.choices, [], `usage chunk should carry choices:[]:\n${res.body}`);
    // The real stop must survive on its own chunk, not be overwritten by the last one.
    assert.ok(/"finish_reason":"stop"/.test(res.body), `stop was lost:\n${res.body}`);
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
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      res.write("data: " + JSON.stringify({ error: { code: "500", message: "The model's safety guardrails were triggered.", type: "server_error" } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: true, messages: [{ role: "user", content: "x" }],
      stream_options: { include_usage: false },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"usage"/.test(res.body), `usage leaked through despite explicit opt-out:\n${res.body}`);
  } finally { await stack.stop(); }
});

// ── the omitted-`stream` default ────────────────────────────────────────────
// Beta 5 flipped fm serve's default: a chat request that OMITS `stream` comes back as
// text/event-stream, where the OpenAI spec returns one JSON object. Most SDKs never set
// the field, so they receive a body they cannot parse. This was previously covered only
// by the external wire-baseline tool, which meant the suite would not notice the fix
// being removed — a mutation test confirmed 0 failures when it was reverted.
test("a request omitting `stream` is pinned to stream:false upstream", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(stack.getLastBody().stream, false);
  } finally { await stack.stop(); }
});

test("a request omitting `stream` returns JSON to the client, not SSE", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] }));
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.strictEqual(JSON.parse(res.body).object, "chat.completion");
  } finally { await stack.stop(); }
});

test("an explicit stream:true is forwarded unchanged, not pinned to false", async () => {
  // Only the forwarded body is asserted: the response content-type here would come from
  // the test harness's fake upstream, not from the proxy, so it proves nothing.
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const got = stack.getLastBody();
    assert.strictEqual(got.stream, true);
    assert.strictEqual(got.stream_options.include_usage, true, "streaming still opts into usage");
  } finally { await stack.stop(); }
});

// ── bind address ────────────────────────────────────────────────────────────

// The start banner reports the address the socket is actually bound to.
test("bind: the proxy listens on loopback only by default", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  assert.match(stack.getStdout(), /listening on http:\/\/127\.0\.0\.1:/);
});

test("bind: PROXY_HOST=0.0.0.0 opens the proxy to the network", async (t) => {
  const stack = await startStack({ env: { PROXY_HOST: "0.0.0.0" } });
  t.after(() => stack.stop());
  assert.match(stack.getStdout(), /listening on http:\/\/0\.0\.0\.0:/);
});
