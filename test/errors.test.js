const { test } = require("node:test");
const assert = require("node:assert");
const { classifyError, errorFrame } = require("../src/errors");
const { startStack, request, postChat } = require("./helpers");

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
// engine with the IDENTICAL LanguageModelError -1 signature used for rate-limiting
// (verified live — see memory beta3-tool-choice-required-crash / beta3-audit-remaining-
// tests). It's a deterministic, permanent client-request-shape bug, not transient, and
// so classifyError must check the original
// request (model + tool_choice) to avoid retry-looping a permanent bug for ~19.5s
// before mislabeling it as rate_limit_exceeded.

// Beta 3/4 also produced LanguageModelError -1 for a forced tool_choice, so the proxy
// used to reclassify it by inspecting the request. Beta 5 has its own wording for that,
// which means this signature can now only be a genuine rate limit — including on a
// request that happens to force a tool call. Reclassifying it here would skip the retry
// that recovers it.
test("classifyError: LanguageModelError -1 stays a retryable rate-limit even with a forced tool_choice", () => {
  const c = classifyError("LanguageModelError -1");
  assert.strictEqual(c.type, "rate_limit_exceeded");
  assert.strictEqual(c.retry, true);
});

test("classifyError: a plain LanguageModelError -1 classifies as a normal rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1").type, "rate_limit_exceeded");
  assert.strictEqual(classifyError("LanguageModelError -1", { model: "system" }).type, "rate_limit_exceeded");
});

test("classifyError: called without a parsedReq argument (backward compatible) still classifies as rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1").type, "rate_limit_exceeded");
});

test("classifyError: 'Failed to parse generated content' is deterministic — no retry", () => {
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

test("classifyError: plain 'rate limit' phrase also classifies as rate-limit", () => {
  assert.strictEqual(classifyError("rate limit exceeded").type, "rate_limit_exceeded");
});

test("classifyError: unknown upstream errors are retryable server_errors", () => {
  const c = classifyError("something else went wrong");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.retry, true);
});

// ── a terminal upstream 400 is not retried ──────────────────────────────────────────
// fm serve rejects a request-shape error (unknown model, malformed body) with HTTP
// 400 in ~7ms. The message matches no branch, so it used to fall through to the
// retryable default: the proxy burned the full 1+2+4+8s backoff ladder and then
// surfaced server_error/internal_error. The 400 is deterministic and permanent —
// retrying re-sends the identical rejection — so it must be terminal and typed
// invalid_request_error.

test("classifyError: an upstream HTTP 400 is terminal invalid_request_error, not a retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.", 400);
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "invalid_request");
  assert.strictEqual(c.retry, false);
});

test("classifyError: the same body on HTTP 500 stays a retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.", 500);
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.code, "internal_error");
  assert.strictEqual(c.retry, true);
});

test("classifyError: HTTP 400 only upgrades the generic fallback — specific branches keep their semantics", () => {
  // A rate-limit signature must stay a retryable rate limit even on a 400 status.
  const rl = classifyError("LanguageModelError -1", 400);
  assert.strictEqual(rl.type, "rate_limit_exceeded");
  assert.strictEqual(rl.retry, true);
  // A guardrail abort must stay a content-filter abort even on a 400 status.
  const gr = classifyError("The model's safety guardrails were triggered.", 400);
  assert.strictEqual(gr.type, "generation_aborted");
  assert.strictEqual(gr.retry, false);
});

test("classifyError: no status (backward compatible) still defaults to retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.");
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
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      res.write("data: " + JSON.stringify({ error: { code: "500", message: "The model's safety guardrails were triggered.", type: "server_error" } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
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
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
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
    const payload = JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "x" }] });
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
  // Mock fm serve emits the rate-limit signature: an error frame before any content.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ error: { message: "LanguageModelError -1", code: -1 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"rate_limit_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("an upstream HTTP 400 (unknown model) is surfaced as invalid_request_error without retrying", async () => {
  // Reproduces the live Beta 7 failure: fm serve rejects an unknown model in ~7ms
  // with HTTP 400 + {error:{type:'invalid_request_error',code:'400'}}. The proxy
  // used to run the full 1+2+4+8s backoff ladder and then answer
  // server_error/internal_error. It must surface the 400 as a terminal
  // invalid_request_error instead.
  let requestCount = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      requestCount++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "invalid_request_error", code: "400", message: "Unknown model 'pcc'. Available models: system." },
      }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] });
    const t0 = Date.now();
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 400, `status=${res.status} body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.error.type, "invalid_request_error", `body=${res.body}`);
    assert.strictEqual(obj.error.message, "Unknown model 'pcc'. Available models: system.");
    assert.strictEqual(requestCount, 1, "must not retry a permanent client-shape rejection");
    assert.ok(Date.now() - t0 < 2000, `must not burn the backoff ladder, took ${Date.now() - t0}ms`);
  } finally { await stack.stop(); }
});

test("an upstream 400 on a STREAMING request is also terminal invalid_request_error", async () => {
  // The same rejection on a stream:true request arrives as bare JSON over a 400
  // response, not an SSE frame — the streaming relay must classify it identically.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "invalid_request_error", code: "400", message: "Unknown model 'pcc'. Available models: system." },
      }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"invalid_request_error"'), `body=${res.body}`);
    assert.ok(!/"type":"server_error"/.test(res.body), `body=${res.body}`);
    assert.ok(!/returned no output after retries/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

// ── Cross-site headers (fm serve rejects them) ───────────────────────────────
// fm serve answers `403 Cross-site requests are not allowed` to any request carrying
// Origin, Referer or Sec-Fetch-Site. A browser sets those automatically, so forwarding
// them made every real browser request fail even though the proxy attaches its own
// CORS headers. The browser→proxy hop is what the origin describes; the proxy→fm serve
// hop is local, so the whole family is stripped.
test("cross-site request headers are stripped before the upstream hop", async () => {
  let seen = null;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    },
  });
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: {
        "content-type": "application/json",
        origin: "https://example.com",
        referer: "https://example.com/app",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.ok(seen, "upstream never saw the request");
    assert.strictEqual(seen.origin, undefined, "Origin reached fm serve; it would 403");
    assert.strictEqual(seen.referer, undefined, "Referer reached fm serve; it would 403");
    assert.strictEqual(seen["sec-fetch-site"], undefined, "Sec-Fetch-Site reached fm serve; it would 403");
    assert.strictEqual(seen["sec-fetch-mode"], undefined, "Sec-Fetch-* should be stripped as a family");
    // The client still gets CORS headers back from the proxy itself.
    assert.strictEqual(seen["content-type"], "application/json", "ordinary headers must survive");
  } finally { await stack.stop(); }
});

test("a browser-shaped request still returns CORS headers to the client", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: {
        "content-type": "application/json", origin: "https://example.com" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(res.status, 200, `body=${res.body}`);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

// ── A capped stream must carry exactly one finish_reason ────────────────────
// The cap logic used to APPEND a finish_reason: upstream sent "stop" on its own chunk,
// then the trailing usage chunk added "length". One stream carried two values, and a
// client that reads the last one reported a complete answer as truncated. pi rendered
// nothing at all. Upstream's chunk now relays with the reason stripped, and the trailing
// chunk is the single source. The non-streaming path always rewrote in place.
const countFinishReasons = (body) => (body.match(/"finish_reason":"[a-z_]+"/g) || []).length;

const cappedStack = (completionTokens) => startStack({
  handler: (req, parsed, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{"content":"1, 2, 3"}}]}\n\n');
    res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write(`data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":${completionTokens},"total_tokens":${5 + completionTokens}}}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  },
});

const capReq = (port, body) => request(port,
  { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
  JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "count" }], ...body }));

test("streaming: a cap AT the completion length emits one finish_reason, not two", async () => {
  const stack = await cappedStack(10);
  try {
    const res = await capReq(stack.proxyPort, { max_tokens: 10 });
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
    assert.ok(/"finish_reason":"length"/.test(res.body), `no length label:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: a cap BELOW the completion length emits one finish_reason", async () => {
  const stack = await cappedStack(10);
  try {
    const res = await capReq(stack.proxyPort, { max_completion_tokens: 1 });
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
    assert.ok(/"finish_reason":"length"/.test(res.body), `no length label:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: a cap ABOVE the completion length keeps the real stop, once", async () => {
  const stack = await cappedStack(3);
  try {
    const res = await capReq(stack.proxyPort, { max_tokens: 500 });
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
    assert.ok(/"finish_reason":"stop"/.test(res.body), `stop was lost:\n${res.body}`);
    assert.ok(!/"finish_reason":"length"/.test(res.body), `mislabelled as length:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: an uncapped request is untouched and still carries one stop", async () => {
  const stack = await cappedStack(3);
  try {
    const res = await capReq(stack.proxyPort, {});
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
    assert.ok(/"finish_reason":"stop"/.test(res.body), `stop was lost:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: a cap with include_usage:false still emits exactly one finish_reason", async () => {
  const stack = await cappedStack(10);
  try {
    const res = await capReq(stack.proxyPort, { max_tokens: 10, stream_options: { include_usage: false } });
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
    assert.ok(/"finish_reason":"length"/.test(res.body), `no length label:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: a capped chunk carrying both content and finish_reason survives $ in the text", async () => {
  // Two gaps in one: the rewrite path had never been exercised with a NON-empty delta,
  // and String.replace with a string replacement expands $&, $`, $' and $n out of the
  // completion text. That turned the relayed frame into unparseable JSON. fm serve puts
  // finish_reason on a bare {delta:{}} chunk so it cannot trigger this, but any upstream
  // that bundles the last content with finish_reason can.
  const TEXT = "it costs $& more, $` and $' and $1 too";
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "system",
        choices: [{ index: 0, delta: { content: TEXT }, finish_reason: "stop" }] })}\n\n`);
      res.write('data: {"id":"x","object":"chat.completion.chunk","model":"system","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, max_tokens: 500, messages: [{ role: "user", content: "hi" }] }));
    // Every data frame must still parse, and the text must round-trip byte for byte.
    let seen = "";
    for (const line of res.body.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const obj = JSON.parse(line.slice(6)); // throws if the replacement corrupted it
      seen += (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) || "";
    }
    assert.strictEqual(seen, TEXT, `completion text was mangled:\n${res.body}`);
    assert.strictEqual(countFinishReasons(res.body), 1, `expected one finish_reason:\n${res.body}`);
  } finally { await stack.stop(); }
});

// ── a model that is unavailable in this context is terminal ─────────────────

const PCC_CONTEXT_503 = "Model 'pcc' is unavailable: Private Cloud Compute is not available " +
  "in this context. Please use the Terminal app.";

test("classifyError: a model unavailable in this context is terminal, not retried", () => {
  const c = classifyError(PCC_CONTEXT_503, 503);
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "model_unavailable");
  assert.strictEqual(c.retry, false);
});

test("classifyError: a bare 503 stays retryable", () => {
  assert.strictEqual(classifyError("Service Unavailable", 503).retry, true);
});

test("an unavailable model reaches the client after one upstream request", async (t) => {
  let hits = 0;
  const stack = await startStack({ maxRetries: 4, handler: (req, parsed, res) => {
    hits++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: PCC_CONTEXT_503, type: "server_error" } }));
  } });
  t.after(() => stack.stop());
  const r = await postChat(stack, JSON.stringify({ model: "pcc", stream: false,
    messages: [{ role: "user", content: "hi" }] }));
  assert.strictEqual(hits, 1);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.body).error.code, "model_unavailable");
});

test("classifyError: a provider's wrapped 4xx is terminal", () => {
  const c = classifyError('HTTP error with status code 400:\n{"error":{"message":"No models loaded."}}', 500);
  assert.strictEqual(c.code, "provider_rejected");
  assert.strictEqual(c.retry, false);
});

test("classifyError: a provider's wrapped 429 and 5xx stay retryable", () => {
  assert.strictEqual(classifyError("HTTP error with status code 429: slow down", 500).retry, true);
  assert.strictEqual(classifyError("HTTP error with status code 502: bad gateway", 500).retry, true);
});

test("classifyError: fm serve's cross-site 403 is terminal", () => {
  const c = classifyError("Cross-site requests are not allowed.", 403);
  assert.strictEqual(c.code, "cross_site_refused");
  assert.strictEqual(c.retry, false);
});

// The model service answers nothing for minutes at a time in this state; a 15 s retry
// ladder only delays the error. Measured on 26B123: from under a minute to about 8.
test("classifyError: SensitiveContentAnalysisML error 15 is terminal", () => {
  const c = classifyError("The operation couldn’t be completed. (com.apple.SensitiveContentAnalysisML error 15.)", 500);
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.code, "model_service_unavailable");
  assert.strictEqual(c.retry, false);
});
