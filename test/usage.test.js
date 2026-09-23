const { test } = require("node:test");
const assert = require("node:assert");
const { classifyError } = require("../src/errors");
const { startStack, request } = require("./helpers");

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
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hello world"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const line = stack.getStderr().split("\n").find((l) => l.includes("[toks]"));
    assert.ok(line, `no [toks] line in stderr:\n${stack.getStderr()}`);
    assert.match(line, /model=system/);
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

// ── token usage passthrough ─────────────────────────────────────────────────────────
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

// ── Context overflow is terminal ─────────────────────────────────────────────
// A prompt larger than the model's window fails identically every time: the request is
// fixed, so a retry re-sends the same oversized transcript. The on-device window is
// 4096 tokens and agent harnesses overshoot it easily (pi's own framing assembles to
// ~8.4k before a single tool), so this is the failure a client meets most often.
// It used to fall through to the retryable generic branch and cost the full
// 1+2+4+8s ladder — five upstream attempts — before surfacing.
test("classifyError: a context overflow is terminal, not a retryable server_error", () => {
  const c = classifyError("The session's transcript exceeded the model's context size.");
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "context_length_exceeded");
  assert.strictEqual(c.retry, false);
});

test("classifyError: context overflow stays terminal on a 500 (fm serve types it server_error)", () => {
  const c = classifyError("The session's transcript exceeded the model's context size.", 500);
  assert.strictEqual(c.code, "context_length_exceeded");
  assert.strictEqual(c.retry, false);
});

test("a context overflow hits upstream exactly once, even with retries enabled", async () => {
  let hits = 0;
  const stack = await startStack({
    maxRetries: 4,
    handler: (req, parsed, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"error":{"type":"server_error","code":"500","message":"The session\'s transcript exceeded the model\'s context size."}}\n\n');
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(hits, 1, `retried a permanent overflow ${hits} times`);
    assert.ok(res.body.includes('"context_length_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("non-streaming context overflow is typed and not retried", async () => {
  let hits = 0;
  const stack = await startStack({
    maxRetries: 4,
    handler: (req, parsed, res) => {
      hits++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "server_error", code: "500", message: "The session's transcript exceeded the model's context size." },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(hits, 1, `retried a permanent overflow ${hits} times`);
    assert.ok(res.body.includes('"context_length_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

// ── The usage chunk must not fake a finish_reason ────────────────────────────
// OpenAI's usage chunk (stream_options.include_usage) carries `choices: []`, and so
// does fm serve's. The proxy re-emits its own final chunk to attach real usage, and it
// used to build `choices: [{delta:{}, finish_reason: abortFinishReason}]` — which is
// `null` for an ordinary completion. Clients that read the LAST chunk's finish_reason
// therefore saw null after a perfectly good "stop", and reported the reply as cut off.
// Pi shows "Response was truncated before completion." Only attach a choices entry when
// there is a real finish_reason to carry (a guardrail abort, or a length cap).
test("streaming: the usage chunk carries choices:[] and never a null finish_reason", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const chunks = res.body.split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    const usageChunk = chunks.find((c) => c.usage);
    assert.ok(usageChunk, "no usage chunk emitted");
    assert.deepStrictEqual(usageChunk.choices, [], "usage chunk must carry choices:[]");
    const nulls = chunks.filter((c) => (c.choices || []).some((ch) => ch.finish_reason === null));
    assert.strictEqual(nulls.length, 0, `a chunk carried finish_reason:null — clients read that as truncation`);
    const stops = chunks.filter((c) => (c.choices || []).some((ch) => ch.finish_reason === "stop"));
    assert.strictEqual(stops.length, 1, "the real stop must survive exactly once");
  } finally { await stack.stop(); }
});

test("streaming: a length cap still carries finish_reason on the usage chunk", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{"content":"1, 2, 3"}}]}\n\n');
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":10,"total_tokens":15}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, max_tokens: 10, messages: [{ role: "user", content: "count" }] }));
    assert.ok(/"finish_reason":"length"/.test(res.body), `no length label:\n${res.body}`);
  } finally { await stack.stop(); }
});
